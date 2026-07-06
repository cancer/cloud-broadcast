# PoC-2 仕様書 — BGM ループ + クロック駆動ミックス（連続性検証）

## 0. この文書について

`cloud-broadcast-poc-plan.md` の **PoC-2** を、そのまま実装・実行・判定できる粒度に落とした実装仕様。

- **目的**: **H2 = 不連続な受信ストリームを連続化し、BGM と加算ミックスして、無発話区間でも音切れ・デシンクなく YouTube へ送出し続けられる**ことを実測で確定する。
- **位置づけ**: `feasibility-check.md` B-1 が「spec が『加算ミックス』の一言で隠している最大の実装難所」と置いた核心。基盤ゲート（PoC-0/1）と違い**設計の検証**であり、不合格時はミキサ設計の見直しに分岐する。
- **前提**: PoC-1 合格済み（受信 PCM 取得と RTMPS 送出が成立している）。実装は引き続き `poc-udp-spike/` を拡張する。
- **ミキサ本体は基盤非依存のため、ローカルで先行開発してよい**（§5.4）。ただし**合否判定は必ず CF 上の実 VC + 実 YouTube で行う**。

---

## 1. 検証仮説と判定基準

- **H2a（連続性）**: 無発話区間（受信パケットが来ない時間）を含む配信で、送出がストール・デシンクしない。
- **H2b（ミックス品質）**: 発話と BGM が同時に、音切れ・ロボ声・速度異常なくアーカイブに残る。
- **H2c（BGM 非混入）**: Bot 自身が送出する BGM は受信ストリームに現れない（spec §2.2 補足の実機裏取り。崩れると加算ミックス設計の前提が崩壊する）。
- **H2d（クロック安定）**: 30 分間、音声クロック（書き込んだサンプル数換算時間）と wall-clock の差が発散しない。

| 仮説 | 合格 | 不合格 |
|---|---|---|
| H2a | 10 分以上の無発話区間を含む 30 分配信で、YouTube 側が「受信中」を維持しアーカイブが途切れない | ストール / 映像停止 / 配信断 |
| H2b | アーカイブ試聴で BGM と会話の重なりが自然（欠落・歪み・加速/減速がない） | 音切れ・ロボ声・ズレが体感できる |
| H2c | BGM 単独再生中、受信側の PCM 取得量が 0 のまま | 自 BGM が受信に混入する |
| H2d | 30 分でのクロック差が ±1 フレーム（20ms）オーダーで振動し、単調増加（発散）しない | 差が時間比例で増え続ける |

---

## 2. スコープ

- **In**: ジッタバッファ + 無音ギャップ埋めによる**単調 48kHz タイムラインへの再配置**、BGM ループ再生（`AudioPlayer` で VC へ送出 + 手元 PCM からミックス合流）、クロック駆動の実時間供給、上記 H2a〜d の実測。
- **Out**: 同時多人数の負荷（PoC-3）、BGM プレイリスト管理・R2 配置（本実装）、音量の作り込み（ゲインは固定値でよい）。

---

## 3. アーキテクチャ

```
Discord VC ──(受信: userごとの不連続Opus)──► decode ──► ミキサ Mixer
    ▲                                                    │  ┌ per-user ジッタバッファ(初期60ms)
    │                                                    │  ├ ギャップ→無音埋め
    └──(送出: BGMループ AudioPlayer)◄── bgm.pcm ────────►│  ├ BGM(連続) を gain 付き加算
                                                         │  └ wall-clock 駆動 20ms フレーマ
                                                         ▼
                                             FFmpeg(stdin, s16le) ──► rtmps://…youtube…
```

- BGM は**2 経路**に出る: (a) `AudioPlayer` で VC へ（参加者に聞かせる）、(b) 手元 PCM としてミキサへ（配信に乗せる）。受信には現れない前提（H2c で裏取り）なので二重取り込みは起きない。
- エンドポイント: `GET /mixtest?durationSec=1800&bgmGain=0.3`（実 VC + YouTube）、`GET /mixbench`（合成入力のローカル検証用、§5.4）。

---

## 4. リポジトリ構成（`poc-udp-spike/` への追加）

```
poc-udp-spike/container/
├── mixer.mjs        # 核心: ジッタバッファ + 加算 + クロック駆動フレーマ（基盤非依存・単体テスト可）
├── mixbench.mjs     # §5.4: 合成不連続PCMをミキサへ注入するローカル検証ハーネス
├── bgm.mjs          # BGM: ループ読み出し(48kHz/stereo PCM) + AudioPlayer 送出
├── assets/bgm.opus  # テスト用 BGM 1 曲（イメージ同梱。R2 は本実装で）
└── index.mjs        # 変更: /mixtest /mixbench 追加
```

---

## 5. 実装仕様

### 5.1 ミキサ `mixer.mjs` のインターフェース（**ここを固定してから作る**）

並行開発・PoC-3 での合成負荷注入・本実装への移植をすべてこの境界で行うため、インターフェースを先に固定する。

```js
export class Mixer {
  constructor({ sampleRate = 48000, channels = 2, frameMs = 20, jitterMs = 60, onFrame }) {}
  pushUser(userId, pcmChunk) {}   // 不連続な受信PCM（到着時刻はpush時刻とみなす）
  setBgm(pullFn, gain) {}         // pullFn(nSamples) -> 連続PCM。ループはbgm側の責務
  start() {}                      // wall-clock駆動で onFrame(pcmFrame) を 20ms ごとに呼ぶ
  stop() {}
  stats() {}                      // { framesOut, gapFrames, underruns, clockDriftMs, peakClip }
}
```

### 5.2 ミキサ内部仕様

1. **タイムライン再配置**: user ごとにリングバッファを持ち、push された PCM を「到着時刻 + `jitterMs`」の再生位置に置く。フレーム生成時、該当区間にデータがない user は無音として扱う（= 無音ギャップ埋め）。
2. **加算**: 全 user + BGM(gain 適用) を Int16 飽和加算（クリップ回数を `peakClip` に計上。歪みが目立てば gain を下げる、で PoC は可）。
3. **クロック駆動（`setInterval` 禁止）**: ドリフト蓄積を防ぐため、経過時間基準で必要フレーム数を計算して追いつく方式にする。

```js
// t0 = 開始時刻。tick は 20ms 間隔のタイマでよいが、「何フレーム出すか」は必ず経過時間から算出する
tick() {
  const due = Math.floor((Date.now() - this.t0) / this.frameMs);
  while (this.framesOut < due) this.emitFrame(); // 遅延したら複数フレームで追いつく
}
```

4. **計測**: `clockDriftMs = framesOut * frameMs - (Date.now() - t0)` を 10 秒ごとにログ。`gapFrames`（全員無音でギャップ埋めしたフレーム数）、`underruns`（FFmpeg stdin の書き込みが背圧で待たされた回数）も記録する。

### 5.3 BGM `bgm.mjs`

- `assets/bgm.opus` をデコードした 48kHz/stereo PCM をメモリに保持し、`pullFn(nSamples)` でループ読み出し
- 同じ PCM を `@discordjs/voice` の `AudioPlayer` で VC へ送出（`createAudioResource`。ループは `idle` イベントで再生成）
- VC 送出とミキサ合流は**同一のデコード済みバッファ**を使う（二重デコードしない）

### 5.4 ローカル先行検証 `/mixbench`（合成入力）

実 VC を使わず、ミキサ単体の設計を先に潰すためのハーネス。**合成した不連続 PCM**（例: 発話 2〜5 秒 / 無音 3〜10 秒のランダムバースト × 3 user、正弦波で可）を `pushUser` に注入し、10 分間で `stats()` が次を満たすことを確認する。

- `clockDriftMs` が発散しない（±20ms オーダーで振動）
- `underruns = 0`
- 出力 PCM をファイルに落として試聴し、バースト境界にクリック音・欠落がない

> これはローカル実行でよい。問いが「ミキサの設計が正しいか」であり、CF の egress とは無関係のため（`knowledge: tech/verify-transport-before-protocol` の「問いに対応する環境で測る」の適用）。

---

## 6. 実行手順

```bash
# 0. ローカル先行: ミキサ単体（合成入力）
node container/mixbench.mjs   # or /mixbench 相当をローカル node で

# 1. デプロイ（sleepAfter を 45m に引き上げ）
npx wrangler deploy

# 2. H2c: BGM 単独（VC に Bot のみ、誰も発話しない）で 3 分
curl "https://poc-udp-spike.<subdomain>.workers.dev/mixtest?durationSec=180"
#    → stats の受信バイト数が 0 のままであること

# 3. H2a/b/d: 30 分の実配信。会話あり区間・10 分以上の無発話区間を意図的に作る
curl -m 2000 "https://poc-udp-spike.<subdomain>.workers.dev/mixtest?durationSec=1800&bgmGain=0.3"
#    → 終了後アーカイブを試聴、stats(clockDrift/gapFrames/underruns) を記録
```

---

## 7. 判定と分岐

| 結果 | 意味 | 次アクション |
|---|---|---|
| H2a〜d すべて合格 | B-1 の核心が実証された | **PoC-3 へ**（負荷計測。ミキサの `pushUser` が合成負荷の注入口になる） |
| H2a 不合格（ストール） | 実時間供給の設計不良 | フレーマのペーシング方式・FFmpeg バッファリング（`-thread_queue_size` 等）を見直して再試験 |
| H2b 不合格（音切れ・歪み） | ジッタバッファ不足 or 加算クリップ | `jitterMs` を 60→120ms に増やす / gain 調整。改善カーブを記録して再試験 |
| H2c 不合格（BGM が受信に混入） | **設計前提の崩壊**（spec §2.2 の前提が実機で不成立） | 加算ミックス設計の見直し（BGM を配信ミックスのみに乗せ VC 送出をやめる等、spec §2.2 の再設計）。影響が spec に及ぶため即報告 |
| H2d 不合格（ドリフト発散） | クロック設計の誤り | フレーマの経過時間算出・`Date.now()` 精度を見直し（`process.hrtime.bigint()` へ変更等） |

---

## 8. 結果記録様式

| 項目 | 値 | 備考 |
|---|---|---|
| mixbench（ローカル、10 分） | | drift / underruns / 試聴結果 |
| H2c: BGM 単独時の受信バイト | | 0 であること |
| H2a: 30 分完走・無発話区間長 | | Studio の受信状態推移 |
| H2b: アーカイブ試聴 | | 音切れ・歪み・ズレの有無 |
| H2d: clockDriftMs 推移 | | 10 秒ごとの値（発散有無） |
| gapFrames / underruns / peakClip | | stats() |

---

## 9. リスク・注意点

- **`setInterval(20)` は必ずズレる**（Node のタイマは遅延方向に不定）。「タイマは起床のきっかけ、出力量は経過時間から算出」を崩さない（§5.2-3）。これを崩した実装は H2d で必ず落ちる。
- **48kHz 統一**: 受信（48k）・BGM（デコード時に 48k へ）・出力（48k）でサンプルレート/チャンネル数を統一する（spec §6.3）。混在するとリサンプルが必要になり PoC の切り分けが濁る。
- **FFmpeg の背圧**: stdin 書き込みは `write()` の戻り値を見て `drain` を待つ。無視すると内部バッファが伸びてデシンクとして観測される（ドリフトと誤診しやすい）。
- **YouTube 側の遅延・変換**: アーカイブ品質の判定は配信終了後のアーカイブで行う（ライブ視聴はバッファの影響で切り分けに向かない）。
- **H2c の判定条件**: 「BGM 単独・誰も発話しない」を厳密に作る（人が居ると混入と発話を区別できない）。

---

## 10. 完了の定義（Definition of Done）

- [ ] ミキサ単体（合成入力・ローカル）で drift 非発散・underrun 0 を確認した。
- [ ] deploy 済み CF 上で H2a〜H2d を実測し、§8 の表に記録した。
- [ ] H2 の yes/no が確定し、§7 の分岐のどれに進むかが決まった。
- [ ] 結果を `cloud-broadcast-poc-plan.md`（PoC-2 実施結果）へ反映した。H2c が不合格の場合は `mvp-spec.md` §2.2 の前提修正を起票した。
