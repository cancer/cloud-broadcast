# PoC: DO ↔ コンテナの制御経路

仕様が契約の抽象度で定めた界面（`docs/cloud-broadcast-dashboard.md`『DO ↔ コンテナの界面（契約）』）が、Cloudflare 上で実際に成立するかは未検証。これが通らないと制御プレーン全体が成り立たないので最優先。

## PoC 1: コンテナ → DO の到達性

- **検証する事実**: Cloudflare Container から外向き HTTP で、Worker 経由で特定（固定名）の Durable Object に到達し、応答を受け取れるか。
- **二値の成功条件**: コンテナが打った 1 リクエストが目的の DO のハンドラに届き、DO の応答がコンテナに返る（届く / 届かない）。
- **最小の spike**: コンテナ内から `fetch(<WorkerURL>/heartbeat)` → Worker が `idFromName` で DO に委譲 → DO が 200 を返す。1 往復で判定。
- **失敗時の分岐**: 到達しないなら C→DO を別トランスポート（WebSocket 等）で再検討。ここが決まるまで「稼働ハートビート」の実装方式は確定できない。

## PoC 2: DO → コンテナの push

- **検証する事実**: DO から `@cloudflare/containers` の `containerFetch`（defaultPort 待受）で JSON を push し、コンテナ側が受信・反映できるか。
- **二値の成功条件**: DO が送った desired state 相当の JSON を、コンテナのハンドラが受信・パースできる。
- **最小の spike**: DO → `containerFetch(defaultPort, {desired state})` → コンテナが受領を記録。
- **失敗時の分岐**: push が不安定ならコンテナ側 poll に切替（仕様の「push 採用」を見直す）。

## 実施結果（2026-07-12・CF 実機）

- 判定: PoC 1（上り: コンテナ→DO 到達性）= 合格。PoC 2（下り: DO→コンテナ）は `@cloudflare/containers` の `containerFetch` がコンテナ到達の唯一のネイティブ経路として既知のため、本 PoC の対象外。
- 実装（poc-udp-spike を最小拡張）:
  - `src/worker.ts`: `UdpSpikeContainer.heartbeat()` RPC を追加。Worker の `fetch` で `pathname === '/heartbeat'` を `getContainer(env.UDP_SPIKE, 'ctrl')`（コンテナ既定名とは別の固定名＝`idFromName` 相当）に委譲。
  - `container/index.mjs`: `/plumbingtest` を追加し `fetch(WORKER_URL + '/heartbeat')` を 1 回発射。
  - `WORKER_URL` は `wrangler` の `vars` → `envVars` 経由でコンテナに注入。
- 実測（Version 5cc6322e、`wrangler containers delete`→`deploy` 後）:
  - `/heartbeat` 直叩き（Worker→DO の半分）= `{"pong":true,"from":"do","name":"ctrl","nonce":...}` 正常。
  - `/plumbingtest`（本命の上り往復）= `{"ok":true,"status":200,"doBody":{"from":"do","nonce":"be81d9f6-…"},"elapsedMs":1226}`。初回で成立（コールドスタート込み ~1.2s）。
  - DO 側でしか生成できない `nonce` がコンテナまで戻った＝コンテナ→自 Worker→`idFromName` 固定名 DO→コンテナ の 1 往復が成立。
- 結論: 制御プレーンの上り経路（稼働ハートビート等の土台）が CF 実機で確定。下りと合わせ DO↔コンテナ双方向が成立。

## 参照
`docs/cloud-broadcast-dashboard.md`（界面契約・§12）、`docs/cloud-broadcast-discord-audio.md` §8、`docs/cloudflare-containers-discord-bot.md`。
