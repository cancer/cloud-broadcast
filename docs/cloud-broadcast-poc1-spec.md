# PoC-1 仕様書 — メディアパイプライン end-to-end（VC 受信 → RTMPS 送出）

## 0. この文書について

`cloud-broadcast-poc-plan.md` の **PoC-1** を、そのまま実装・実行・判定できる粒度に落とした実装仕様。

- **目的**: PoC-0 で合格した CF Containers 上で、**H1 = VC の会話を受信して PCM が取れること**、および**静止画 + AAC の RTMPS 送出が YouTube に受理されること**を実測で確定する。
- **位置づけ**: PoC-0（transport）の次段。ここが通ればメディアプレーンの入出力両端が実証され、残るは中間のミックス品質（PoC-2）と負荷（PoC-3）のみになる。
- **前提**:
  - PoC-0 合格済み（`cloud-broadcast-poc0-result.md`）。実装は `poc-udp-spike/` を拡張する（同一 Worker + Container デプロイを育てる。PoC-0 §7 追試と同じ流儀）。
  - 受信（Bot による音声受信）は Discord 公式が保証しない領域（`feasibility-check.md` D-1）。**ドキュメントでは決着せず実測のみが答える**（`knowledge: tech/verify-transport-before-protocol`）。
- **品質（音切れ・デシンク）は本 PoC の合否に含めない。** それは PoC-2（B-1）の検証対象。

---

## 1. 検証仮説と判定基準

- **H1a（受信）**: CF Containers 上の `@discordjs/voice` で、VC の**他参加者**の Opus ストリームを購読し、デコードした PCM が発話に対応して取得できる。
- **H1b（送出）**: コンテナ内 FFmpeg から `rtmps://` で YouTube Live ingest に push でき、YouTube Studio が「受信中」になる。
- **H1c（結合・継続）**: 受信 → FFmpeg → YouTube を **30 分間**（= 要求稼働時間 1 配信分、spec §9.1）連続で維持でき、会話がアーカイブに残る。

| 仮説 | 合格 | 不合格 |
|---|---|---|
| H1a | 発話中ユーザーの decoded PCM が > 0 バイトで、発話時間と整合するオーダーで増加する | 購読できない / PCM が常に 0 バイト |
| H1b | YouTube Studio で配信が「受信中（良好）」になる | ingest が確立しない / 即切断される |
| H1c | 30 分間、voice 接続と FFmpeg プロセスが生存し、アーカイブで会話が確認できる | 途中でコンテナ停止・接続断・送出断が回復不能に発生 |

付帯計測（合否ではなく記録）: **provisioning 時間**（join 要求 → RTMPS 送出開始。spec §4.2 の状態遷移の実測値）、30 分間の voice 再接続回数。

---

## 2. スコープ

- **In**: 受信単体（H1a）／送出単体（H1b）／結合 30 分（H1c）。会話のみを素朴に流す（ギャップは無音パディングの暫定実装）。
- **Out**: BGM 再生・加算ミックス・ジッタバッファ・ドリフト補正（PoC-2）。同時多人数の負荷（PoC-3）。Workers からの起動/停止制御・Secret 設計（C 群、上位設計に影響しないため後続）。

---

## 3. アーキテクチャ

```
[HTTP] ─► Worker ─► Container(:8080)
                      ├ GET /receivetest?durationSec=60   … H1a: join→受信→PCM計測(JSON)
                      ├ GET /streamtest?durationSec=60    … H1b: 静止画+無音でRTMPS送出
                      └ GET /pipetest?durationSec=1800    … H1c: join→受信PCM→FFmpeg→YouTube
                           │
              Discord VC ──┘（Opus/UDP受信）      FFmpeg ──► rtmps://…youtube…/live2/<KEY>
```

制御はすべて HTTP エンドポイント経由（PoC-0 の `/udptest` と同じ）。テストの実体はコンテナ内で走る。

---

## 4. リポジトリ構成（`poc-udp-spike/` への追加）

```
poc-udp-spike/
├── src/worker.ts              # 変更: YOUTUBE_STREAM_KEY を envVars に追加
└── container/
    ├── Dockerfile             # 変更: ffmpeg を apt で同梱、standby.png を COPY
    ├── package.json           # 追加依存: prism-media, @discordjs/opus
    ├── standby.png            # 1920x1080 静止画（spec §5.2）
    ├── receive.mjs            # H1a: VoiceReceiver 購読 + Opus デコード
    ├── rtmpout.mjs            # H1b/H1c: FFmpeg 起動・PCM 書き込み
    └── index.mjs              # 変更: 3 エンドポイント追加
```

---

## 5. 実装仕様

### 5.1 受信 `container/receive.mjs`（H1a）

```js
import { joinVoiceChannel, entersState, VoiceConnectionStatus, EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';

// 重要: 受信するので selfDeaf: false（PoC-0 の voicetest は true だった。true だと受信しない）
export function join({ guild, channelId }) {
  return joinVoiceChannel({
    channelId, guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, selfMute: true, // PoC-1 では送出なし
  });
}

// speaking 開始ごとに購読し、Opus→PCM(48kHz/stereo/s16le) にデコードして onPcm へ渡す
export function subscribeAll(connection, onPcm, stats) {
  const receiver = connection.receiver;
  receiver.speaking.on('start', (userId) => {
    stats.speakingStarts++;
    if (receiver.subscriptions.has(userId)) return;
    const opus = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    opus.pipe(decoder).on('data', (pcm) => {
      stats.bytesByUser[userId] = (stats.bytesByUser[userId] ?? 0) + pcm.length;
      onPcm(userId, pcm);
    });
  });
}
```

`/receivetest` は join → `durationSec` の間購読 → `{ ok, speakingStarts, bytesByUser, reconnects }` を JSON で返す。**テスト中に人間が 1 人以上 VC で発話する**（実施手順 §6）。

### 5.2 送出 `container/rtmpout.mjs`（H1b/H1c）

エンコード設定は spec §5.2 の既定値（1080p / 15fps / 1000k / AAC 160k / 48kHz）。

```js
import { spawn } from 'node:child_process';

export function startFfmpeg({ streamKey, silent = false }) {
  const audioIn = silent
    ? ['-re', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']   // H1b: 無音ソース
    : ['-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0']; // H1c: stdin から PCM
  const args = [
    '-loglevel', 'warning', '-progress', 'pipe:2',
    '-loop', '1', '-framerate', '15', '-i', '/app/standby.png',
    ...audioIn,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage',
    '-pix_fmt', 'yuv420p', '-r', '15', '-g', '30', '-b:v', '1000k',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    '-f', 'flv', `rtmps://a.rtmps.youtube.com/live2/${streamKey}`,
  ];
  return spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'pipe'] });
}
```

> ingest URL・ストリームキーは YouTube Studio の配信画面からコピーする（手動配信枠、spec §7.2）。

### 5.3 結合 `/pipetest`（H1c）— 暫定パイプ仕様

受信 PCM を FFmpeg の stdin へ **20ms（3840 バイト = 960 サンプル × 2ch × 2 バイト）刻みの実時間ペース**で書く。

- 受信 PCM は単一 FIFO バッファへ追記（複数人同時発話の加算はしない。重なったら順次連結でよい＝品質は不問）
- 20ms ごとに: バッファに 3840 バイト以上あればそれを、なければ**無音 3840 バイト**を書く
- ペーシングは `setInterval(20)` の素朴実装でよい（ドリフト補正は PoC-2 の核心なのでここではしない）
- join 要求時刻と FFmpeg への最初の書き込み時刻を記録 → **provisioning 時間**として返す

### 5.4 Worker / Dockerfile 差分

- `worker.ts`: `Env` に `YOUTUBE_STREAM_KEY?: string` を追加し `envVars` で注入（PoC-0 の `DISCORD_*` と同一機構）
- `Dockerfile`: `apt-get install -y ffmpeg` を追加、`standby.png` を COPY、`receive.mjs rtmpout.mjs` を COPY
- `package.json`: `prism-media` / `@discordjs/opus` を追加（バージョンは実装時に `@discordjs/voice` 0.19.x との整合を確認して pin）

---

## 6. 実行手順

前提: PoC-0 の資産（Bot トークン・guild/channel、`wrangler secret` 設定済み）+ YouTube 配信枠を手動作成しストリームキーを取得。

```bash
# 0. Secret 追加
npx wrangler secret put YOUTUBE_STREAM_KEY

# 1. デプロイ
npx wrangler deploy

# 2. H1a: 実行中に自分が VC に入り 10 秒以上発話する
curl "https://poc-udp-spike.<subdomain>.workers.dev/receivetest?durationSec=60"

# 3. H1b: YouTube Studio を開いた状態で
curl "https://poc-udp-spike.<subdomain>.workers.dev/streamtest?durationSec=60"
#    → Studio が「受信中」になることを目視確認

# 4. H1c: 30 分。VC で通常の会話をする（無発話区間を含んでよい）
curl -m 2000 "https://poc-udp-spike.<subdomain>.workers.dev/pipetest?durationSec=1800"
#    → 終了後、YouTube のアーカイブで会話を確認
```

> **⚠️ H1b/H1c は必ず deploy 済み CF 上で測る**（PoC-0 と同じ理由）。ただし **H1a が不合格だった場合の切り分けに限り**、同一コードをローカルで実行してよい。問いが「CF の egress」ではなく「受信 API がそもそも機能するか」に変わるため（§7）。

> **⚠️ `sleepAfter` に注意**: 30 分テスト中に HTTP リクエストが完結しない場合でもコンテナが寝ないよう、`sleepAfter` を一時的に `45m` へ引き上げてデプロイする（テスト後に戻す）。

---

## 7. 判定と分岐

| 結果 | 意味 | 次アクション |
|---|---|---|
| H1a/b/c すべて合格 | 入出力両端が CF 上で成立 | **PoC-2 へ**（ミックス連続化） |
| H1a 不合格（PCM が取れない） | 受信 API の問題。CF 固有か切り分ける | 同一コードを**ローカルで実行**。ローカルで取れる → CF 固有（戻り UDP ストリームの継続性問題）として調査。ローカルでも取れない → D-1 顕在化 or 実装/ライブラリ問題（`@discordjs/voice` 受信 API の現行仕様を確認） |
| H1b 不合格 | RTMPS(TCP) 送出の問題。UDP と無関係 | ffmpeg 引数・ストリームキー・配信枠状態を確認（CF の outbound TCP は Workers 実績上のリスク低） |
| H1c 不合格（途中で死ぬ） | 30 分常駐が CF ライフサイクルと衝突 | 停止シグナル・eviction ログを調査。`sleepAfter` 設定で解消するか確認 → 解消不能なら **Fly.io（保険）で同テスト**を実施し基盤を再判断 |

---

## 8. 結果記録様式

| 項目 | 値 | 備考 |
|---|---|---|
| H1a: speakingStarts / bytesByUser | | 発話者数・発話時間と整合するか |
| H1b: Studio 受信状態 | | 「良好」/警告の別 |
| H1c: 完走（30 分） | | 中断があれば時刻と原因 |
| provisioning 時間 | | join 要求 → 送出開始 |
| voice 再接続回数（30 分中） | | stateChange ログから |
| アーカイブ確認 | | 会話が聞こえるか（品質は不問） |

---

## 9. リスク・注意点

- **`selfDeaf: true` だと受信できない**。PoC-0 の `voicetest.mjs` は `selfDeaf: true` なので流用時に必ず変える。
- **受信 API は Discord 未保証（D-1）**: `@discordjs/voice` の receive API は仕様変更歴あり。実装着手時に現行版のドキュメントで `receiver.subscribe` / `EndBehaviorType` の仕様を確認する（mvp-spec §6.1 の注意書き）。
- **戻り UDP の継続性**: PoC-0 で実測したのは数十秒の往復。30 分級の戻りストリーム維持は H1c が初めて検証する（NAT マッピング維持は BGM 非送出でも keepalive が担う想定だが、実測が答え）。
- **プライバシー**: `/receivetest` 実施時もテスト guild の参加者は録音明示済みであること（spec §10）。
- **課金**: 30 分テストは実行時のみ。`sleepAfter` を戻し忘れない。

---

## 10. 完了の定義（Definition of Done）

- [ ] deploy 済み CF 上で H1a/H1b/H1c を実行し、§8 の表に結果を記録した。
- [ ] H1 の yes/no が確定し、§7 の分岐のどれに進むかが決まった。
- [ ] provisioning 時間の実測値を記録した（spec §4.2 の状態遷移設計へのフィードバック）。
- [ ] 結果を `cloud-broadcast-poc-plan.md`（PoC-1 実施結果）へ反映した。
