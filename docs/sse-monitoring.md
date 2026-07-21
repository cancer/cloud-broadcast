# PoC: 監視の SSE

仕様（`docs/cloud-broadcast-dashboard.md` §9）は監視を SSE（`コンテナ→DO→Worker→ブラウザ`）・複数同時視聴で定めるが、長時間維持と複数購読者ファンアウトは未検証。

## PoC 1: 長時間 SSE の維持（Worker → ブラウザ）

- **検証する事実**: Workers で SSE 接続を配信の想定時間（30 分超）維持できるか。切断時の挙動と、Cloudflare Access のセッション失効／再認証が長時間接続・再接続に与える影響。
- **二値の成功条件**: 30 分継続受信できる。切断が起きても `EventSource` の自動再接続で復帰する。
- **最小の spike**: Worker で SSE を張り、一定間隔でイベントを流し続けて 30 分観測。Access を有効にした状態で再接続も試す。
- **失敗時の分岐**: 接続時間上限に当たるなら定期再接続＋スナップショット再送前提で設計、または WebSocket を検討。

## PoC 2: DO の複数購読者ファンアウト

- **検証する事実**: DO が複数の SSE 接続を保持し、状態変化を全接続へ配れるか（hibernation との相性含む）。
- **二値の成功条件**: 2 ブラウザ同時接続で、DO が起こした 1 つの状態変化を両方が受信する。
- **最小の spike**: 2 タブから接続 → DO が状態を 1 回変える → 両タブが受信。
- **失敗時の分岐**: 保持が難しいなら購読者リストの持ち方（storage / in-memory）を再検討。

## 実施結果（2026-07-13・CF 実機）

実装は `poc-sse/`（`poc/sse-monitoring` ブランチ）、デプロイ先 `poc-sse.cancer6.workers.dev`。

### 結論: 両 PoC とも合格。設計はこのまま採用可

| 検証項目 | 結果 | 根拠 |
|---|---|---|
| PoC1 継続受信 | ✅ 単一接続を **45 分無切断**維持（目標 30 分超）。tick 15s 間隔一定・停止なし・`opens=1` | Node reader 実測（maxGap 15102ms） |
| PoC1 自動再接続 | ✅ `/kick` 強制切断 → 2 ブラウザの `EventSource` が自動復帰（`opens 1→2`）、ファンアウト継続 | Playwright 実測 |
| PoC2 複数購読者ファンアウト | ✅ 1 回の `/bump` → 全購読者（2 ブラウザ + curl）が同一 state を受信（`delivered` 一致） | Playwright + curl 実測 |
| Access edge 強制 | ✅ 認証なし `/sse` → **302**（非 `text/event-stream`）・aud 一致 | curl 実測 |

### アーキテクチャ上の決定（重要）

**SSE は Worker で終端し、Worker↔DO は WebSocket にする**（`browser ⟷SSE⟷ Worker ⟷WS⟷ DO`）。

理由: DO への **plain fetch サブリクエストは、応答をストリーミング中でも DO を常駐させない**（[DO lifecycle 公式](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)）。そのため「Worker→DO を plain fetch で貼り DO が SSE を返す」構成は成立しない（実測: snapshot も flush されず・DO 内ポンプが進まず `seq=0`・接続は Canceled）。WebSocket は DO を常駐させ hibernation も効くため、これで解決。
- 継続性（PoC1）: Worker 側ポンプが keepalive + tick を定期送出（DO 非依存）。
- ファンアウト（PoC2）: `/bump` で DO が全 WebSocket（=各購読者の Worker invocation）へ配信 → 各 Worker が自ブラウザへ SSE 転送。

### Access（session 失効／再認証の影響）

現行フロー: workers.dev を Workers ダッシュボード **Domains & Routes → Enable Cloudflare Access** で保護 → 払い出された **AUD + JWKS URL** を Worker の JWT 検証（`jose`・`Cf-Access-Jwt-Assertion`）に設定。custom domain は不要。

session 失効時の挙動（実測 + 理論確定・実測不要と判断）:
- 失効後に `EventSource` が再接続すると、`/sse` は Access が edge で **302（非 `text/event-stream`）**を返す → `EventSource` は受理できずリトライループ、**再ログインするまで復帰しない**（302 は実測）。
- **開いている最中の SSE は失効しても継続**する。Access は L7 リクエスト受信時にのみ認可し、応答ボディ送出中に cookie 再提示の契機が無い（HTTP 意味論上、他に取りようがない）。公式も同原則を明記（[MFA/SSH: "Existing SSH sessions are not affected by session expiration"](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/)）。

設計含意: **session duration を配信想定時間より長く取る**（例: 30 分配信なら 24h セッション）ことで実運用は問題なし。再接続時は snapshot-on-connect で状態復元。失敗分岐「定期再接続＋スナップショット再送」は既に実装済み。

## 参照
`docs/cloud-broadcast-dashboard.md` §9・§13。
