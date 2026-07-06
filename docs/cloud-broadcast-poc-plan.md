# Cloud Broadcast MVP — PoC 計画書

`docs/cloud-broadcast-mvp-spec.md` / `docs/cloud-broadcast-feasibility-check.md` を受け、
**実機でしか決着しない検証点**を最小コストで潰すための PoC 手順を定義する。

research で決着済みの前提（`feasibility-check.md` 調査結果）:
- **A-2（暗号化）**: 解決可能。現行 `@discordjs/voice` + `sodium-native` で AEAD モード対応。
- **D-1（受信の規約）**: Bot 音声受信は Discord 公式には未サポート（undocumented）。継続性リスクとして保持。
- **A-1（CF アウトバウンド UDP）**: ~~ドキュメントでは未決~~ → **PoC-0 実機 spike で合格決着（2026-07-03）**。
  詳細は本文 PoC-0「実施結果」および `feasibility-check.md` A-1 参照。

---

## 0. PoC で検証する仮説（合否は crisp に）

| # | 仮説 | 合格条件 | 不合格時の分岐 |
|---|---|---|---|
| H0 | CF Containers からアウトバウンド生 UDP が双方向で通る | UDP ソケット確立＋**戻りパケット受信**を確認 | 常駐基盤（H1）へ。CF はメディアから外す |
| H1 | 常駐基盤（Fly.io 等）で `@discordjs/voice` の音声パイプラインが確立する | VC join → 会話受信 PCM が取れる | 基盤再選定（9 章の他候補） |
| H2 | 不連続な受信を連続化し RTMPS 送出まで通る | YouTube 側でアーカイブが**音切れなく**確認できる | B-1 のミキサ設計を見直し |
| H3 | 想定人数の同時発話で CPU が収まる | 目標マシンサイズ内で欠落なし | マシンサイズ／エンコード設定を調整 |

---

## PoC-0: Cloudflare Containers アウトバウンド UDP spike（最優先・第一級ゲート）

**目的**: H0 の yes/no を数時間で確定する。spec §13 が最優先に置いた分岐点。

### 準備物（ユーザー側）

PoC-0-1（transport 単体）に必須:
1. **Docker Desktop（起動状態）** — `wrangler deploy` がローカルで Docker を使いイメージをビルド/push。
   公式明記「You must have Docker running locally when you run `wrangler deploy`」
2. **Cloudflare アカウント + Workers Paid プラン（$5/月）** — Containers は有料機能（Free は vCPU/mem/disk が N/A）
3. **wrangler 認証** — `npx wrangler login`（ブラウザ OAuth）or API トークン。wrangler は npx で可
4. Node（済: v24.9.0）

PoC-0-2（transport 合格後の実 Discord 接続）で追加:
5. Discord アプリ + Bot トークン（Developer Portal）
6. テスト guild + ボイスチャンネル、Bot を Connect 権限付きで招待、`guild_id`/`channel_id`

> **⚠️ 測定は必ず `wrangler deploy` した CF ネットワーク上で行う。**
> ローカル開発モードはコンテナを手元マシンで動かすため「あなたのマシンの UDP」しか測れず、
> PoC の問い（CF の egress が UDP を通すか）を検証できない。

### 0-1. トランスポート単体テスト（まず transport を切り分ける）
`@discordjs/voice` を挟まず、Node の `dgram` で生 UDP の往復だけを見る。

- 最小コンテナ（Node 20 + 下記スクリプト）を CF Containers にデプロイ
- 公開 UDP エコー先へ 1 パケット送出 → 応答受信をログ
  - 例: STUN サーバへ Binding Request（`stun.l.google.com:19302`）を投げ、Binding Response が返るか
    （STUN は UDP の往復確認に手頃。戻りが来れば「アウトバウンド UDP + 戻り経路」が生きている証左）
- **合格**: 応答パケットを受信 / **不合格**: 送信がエラー or タイムアウトで無応答

```
// 擬似コード（dgram + STUN Binding Request）
// 1. dgram.createSocket('udp4')
// 2. STUN Binding Request を stun.l.google.com:19302 へ send
// 3. message イベントで応答が来るか、5s タイムアウトで判定
```

> discriminating fact（feasibility-check A-1）: CF の egress が Workers 仲介なら Workers ソケットは
> TCP 専用のため UDP は不可能。直接 egress を持つなら通る。この spike がそこを実測で切り分ける。

### 0-2. 実プロトコルテスト（0-1 合格時のみ）
`@discordjs/voice` で実際に VC join を試み、UDP ハンドシェイク（IP discovery）と
暗号化ネゴシエーション（A-2 の AEAD モード）まで到達するかを確認。

### 判定
- **H0 合格** → メディアプレーンも CF に寄せる方針で PoC-1 を CF 上で継続（payoff: スタック統一）
- **H0 不合格** → PoC-1 を Fly.io で実施し、メディアは常駐基盤に確定

### 実施結果（2026-07-03）

✅ **H0 合格**。0-1（STUN 3試行）・0-2（`@discordjs/voice` 実接続）ともに成功。詳細は
`docs/cloud-broadcast-feasibility-check.md` A-1、実装は `poc-udp-spike/` を参照。
**メディアプレーンも CF Containers に統一する方針で PoC-1 へ進む。**

---

## PoC-1: メディアパイプライン end-to-end（Fly.io を既定ターゲット）

**目的**: H1 + A-2 + D-1 を一度に通す。CF が H0 不合格なら本命、合格なら CF 上で同手順。

> Fly.io を既定ターゲットにするのは「research が CF を殺したから」ではなく
> **既知良好でタイムラインを de-risk する**ため（H0 の結果と独立に価値がある）。

### 1-1. コンテナイメージ（依存を焼き込む）
- ランタイム: Node.js 20 + TypeScript
- Discord 音声: `@discordjs/voice`（最新を pin）
- 暗号化ネイティブ依存: **`sodium-native`**（AEAD モード必須。A-2）
- Opus: `@discordjs/opus`
- （必要時）DAVE E2EE: `@snazzah/davey`（受信対象 VC が E2EE の場合）
- エンコード/送出: FFmpeg（`ffmpeg-static` かイメージに apt で同梱）

### 1-2. 手順
1. Bot トークンで Gateway 接続 → 指定 VC へ join
2. `VoiceReceiver` で各参加者の Opus を受信 → PCM デコード（会話が PCM で取れることを確認）
3. まず**会話のみ**を FFmpeg に流し、静止画 + AAC で `rtmps://` へ送出
   → YouTube Studio 側で映像（静止画）と音声が出ることを確認
4. ここまでで H1 と「RTMPS 送出成立」を確認（BGM・ミックスは PoC-2 で追加）

### 合格条件
- YouTube Live の管理画面で配信枠が「受信中」になり、会話音声がアーカイブに残る
- VC join → 送出開始までの provisioning 時間を計測（spec §4.2 の状態遷移の実測値）

### 実施結果（2026-07-06）
✅ **H1 合格（CF 実機）**。H1a: 実 VC で他参加者の発話を 10.6MB 受信（decodeErrors 0）。H1b: 静止画+無音を RTMPS 送出、YouTube Studio「受信中」・ffmpeg 60s 継続（drop 0 / speed 1x）。provisioning 実測 **約 3.04 秒**。実装は `poc-udp-spike/`、詳細は `docs/cloud-broadcast-poc1-3-handoff.md`。D-1（受信の未保証）は実機成立で解消。

---

## PoC-2: BGM ループ + ミックス（B-1 の核心を実測）

**目的**: H2。spec が「加算ミックス」の一言で隠している最大の実装難所を早期に叩く。

### 検証内容
- BGM を `AudioPlayer` で VC へ送出しつつ、**手元 PCM から直接**ミックスに合流
  （受信には現れない前提＝spec §2.2 補足を実機確認）
- **不連続な受信ストリームを単調 48kHz タイムラインへ再配置**（ジッタバッファ + 無音ギャップ埋め）
- BGM PCM と加算 → **実時間ペース**で FFmpeg へ供給、静止画の映像 PTS を音声クロックに追従
- サンプルレート/チャンネル数を受信・BGM・出力で 48kHz に統一（spec §6.3）

### 合格条件
- 無発話区間でも配信が**ストール/デシンクしない**（連続性維持）
- 発話と BGM が同時に、音切れ・過大な遅延なく YouTube アーカイブに残る

### 実施結果（2026-07-06）
✅ **H2 合格**。ミキサ（クロック駆動・ジッタバッファ・加算）はローカル mixbench 10 分で drift 非発散（±38ms）・underrun 0 を実証。CF 実機では `/dualtest` で **1 体の Bot が BGM 送出中に他者音声 3.56MB を受信し、自 BGM は受信に非混入（H2c、selfBytes 0）**＝ spec §2.2 の加算ミックス前提が実機成立。`/mixtest` 3 分で発話+BGM を RTMPS 送出、drift -29ms 非発散・drop 0・speed 1.01x、**アーカイブ試聴で会話+BGM を確認（H2a/b）**。H2d も実機で非発散。

---

## PoC-3: 負荷計測（H3・基盤確定後）

- 想定同時発話人数で N 並列 Opus デコード + 1080p 静止画エンコード + AAC の **CPU/メモリ実測**
- 目標マシンサイズに収まるか。収まらなければ fps/ビットレート（spec §5.2: fps 15/1000k）を調整
- ここで基盤コスト上限 n を確定（spec §9.3 の「上限を言い切れる」要件）

### 実施結果（2026-07-06）
✅ **H3 合格**。N_target=2。`instance_type=standard-3`（2 vCPU/8 GiB）で `/loadtest?sink=null` 600 秒: 定常 CPU **p50 35% / p95 39%**（余裕大）、underruns は時間非依存（コールドスタート由来のみ）、dropFrames 0。エンコードが支配項で話者数はほぼ効かず standard-3 は N=2 を大きく超える余力。**月額上限 n ≈ Workers Paid 基本料 $5（≈¥800）**（ワークロード上コンテナ従量は included 枠内で実質 0。`mvp-spec §9.2` 更新済み）。

---

## PoC 完了（2026-07-06）

PoC-0〜3 すべて **CF 実機で合格**。メディアプレーンは Cloudflare Containers（standard-3）で確定。設計上の不確実性はゼロ。未実施は H1c（30 分耐久）のみで、CF ライフサイクル起因の失敗要因は排除済み・残存する稀なランタイム更新衝突は `mvp-spec §4.3.1`（中断の即時検知 R1・自動リカバリ R2）を要件化して吸収。次段は本実装（制御プレーン・構成 as Code・R1/R2・30 分耐久の本番確認）。詳細: `docs/cloud-broadcast-poc1-3-handoff.md`。

---

## 検証しないこと（PoC スコープ外）

- Workers 起動/停止制御・D1 状態管理・Secret 注入（C 群）= 上位設計に影響しないため後続
- YouTube 配信枠の API 自動作成（spec §7.2）= MVP は手動キー
- 障害自動復旧（spec §4.3）

---

## 全体の分岐フロー

```
PoC-0 (CF UDP spike)
   ├─ 合格 → PoC-1 を CF 上で（メディアも CF に統一）
   └─ 不合格 → PoC-1 を Fly.io で（メディアは常駐基盤）
        ↓
PoC-1 (VC join→受信→RTMPS)  … 合格で基盤確定
        ↓
PoC-2 (BGM+ミックス連続性)   … B-1 の核心
        ↓
PoC-3 (負荷計測)             … マシンサイズ/コスト上限確定
        ↓
      本実装（構成スキーマ・制御プレーン・運用仕上げ）
```
