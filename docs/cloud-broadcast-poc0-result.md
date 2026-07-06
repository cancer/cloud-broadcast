# PoC-0 実施結果報告 — Cloudflare Containers アウトバウンド UDP 検証

## 0. 概要

`cloud-broadcast-poc0-spec.md` に定義された PoC-0（H0: CF Containers からのアウトバウンド UDP
往復）を実機で実施し、**合格**と判定した。あわせて任意追試（§7）として Discord voice への
実接続まで実施し、**Cloudflare Containers 上で Discord 音声 Bot が成立すること**を確認した。

- 実施日: 2026-07-03
- 実装: `poc-udp-spike/`（`https://poc-udp-spike.cancer6.workers.dev`にデプロイ済み）
- 判定: **H0 合格**（詳細は `cloud-broadcast-feasibility-check.md` A-1 に反映済み）

---

## 1. 準備したもの

実機検証には以下がローカル環境に必要だった（`cloud-broadcast-poc-plan.md` 準備物）。

| 項目 | 内容 |
|---|---|
| Docker互換エンジン | Colima（Apple Silicon のため `--arch x86_64` でamd64 VMとして起動。QEMU + lima-additional-guestagentsが別途必要） |
| Cloudflareアカウント | Workers Paid プラン加入済み、`wrangler login` 済み |
| Discord Bot | Developer Portalでアプリ/Bot作成、Public Bot OFF・Install Link None（プライベート運用）、トークン発行、テスト guild へ Connect 権限で招待 |
| 認証情報の保管 | `cloud-streaming/.env`（`.gitignore`済み）にトークン・guild_id・channel_idを保存 |

### 遭遇した環境上のつまずきと対処

- `docker build --load` が `unknown flag` で失敗 → `docker-buildx` の CLIプラグイン登録が未設定だったため、`~/.docker/config.json` に `cliPluginsExtraDirs` を追加
- Colima起動時に `qemu-img not found` / `guest agent binary could not be found` → `qemu` と `lima-additional-guestagents` を追加インストール
- `@discordjs/voice`(0.19.2) が Node >=22.12 を要求 → コンテナのベースイメージを `node:20-slim` から `node:22-slim` に変更

---

## 2. 実施内容と結果

### 2-1. トランスポート単体テスト（`poc0-spec.md` §5.1, 0-1）

`dgram(udp4)` で STUN Binding Request を送出し、Binding Response（戻りパケット）を受信できるかを
deploy 済み CF ネットワーク上（`enableInternet: true`）で確認。DNS依存・単一サーバ依存を排除するため
3試行実施。

| 試行 | 宛先 | 目的 | 結果 | reason | elapsedMs |
|---|---|---|---|---|---|
| 1 | stun.l.google.com:19302 | ホスト名（DNS込み）の基本疎通 | ok | binding-success | 35 |
| 2 | 74.125.250.129:19302 | ①のIP直指定、DNSを排除した transport 単体確認 | ok | binding-success | 24 |
| 3 | global.stun.twilio.com:3478 | 別ベンダー、単一STUNサーバ依存の排除 | ok | binding-success | 47 |

**→ H0 合格**。CF Containers は Workers ソケット経由でTCPのみに仲介されるのではなく、
**コンテナが直接アウトバウンドUDPソケットを開いて双方向通信できる**ことを実測で確認した。

### 2-2. Discord実プロトコル追試（`poc0-spec.md` §7、任意）

同一コンテナに `discord.js` + `@discordjs/voice`(0.19.2) + `sodium-native` を追加し、
実際のBotトークンでGatewayへログイン → テストguildのVCへ `joinVoiceChannel` → 状態遷移を観測。

```
gateway-login-ok → client-ready → guild-fetched → join-requested
  → voice-state:signalling->connecting
  → voice-state:connecting->connecting（×3: UDPソケット確立/IP discovery/暗号化ネゴシエーション中）
  → voice-state:connecting->ready
  → voice-ready
```

`VoiceConnectionStatus.Ready` への到達を確認。これは UDP IP discovery と AEAD暗号化
ネゴシエーション（`feasibility-check.md` A-2）が実機で成立したことを意味する。

**→ 任意追試も合格**。「汎用UDPが通る」（2-1）から「Discord音声接続が実際に確立する」（2-2）まで、
必要条件・十分条件の両方を実測で確認した。

---

## 3. 結論と影響

- **Cloudflare Containers 上で Discord 音声 Bot は成立する。**
- `cloud-broadcast-mvp-spec.md` §13 が置いた「CF UDP PoC最優先」のゲートは合格で通過。
- メディアプレーンも制御プレーンと同じ Cloudflare スタックに統一する構成が選択可能になった
  （Fly.io等の常駐基盤は「不合格時の代替」から「保険」に位置づけが変わった）。
- 反映先: `cloud-broadcast-feasibility-check.md`（A-1）、`cloud-broadcast-poc-plan.md`（PoC-0実施結果）、
  `cloud-broadcast-poc0-spec.md`（§8結果表・§10 DoD）

---

## 4. 次のステップ

`cloud-broadcast-poc-plan.md` の分岐フローに従い、**PoC-1（メディアパイプライン end-to-end）を
CF Containers 上で継続**する。会話PCM受信 → 静止画+AACでのRTMPS送出までを検証する。
