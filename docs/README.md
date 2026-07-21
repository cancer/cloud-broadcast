# PoC 検証項目

実装に入る前に**実機で検証すべき項目（PoC）**の docs。仕様（リポジトリ直下の `docs/`）は WHAT を定義するが、ここに挙げる項目は**未検証のプラットフォーム挙動**（Cloudflare Containers ↔ Durable Objects ↔ Workers、discord.js / @discordjs/voice、SSE）に依存しており、**実装指示ではなく検証タスク**である。動く前提で設計を書き下す前に、まず動くことを確かめる。

方法（knowledge「トランスポート可否は実プロトコルを載せる前に実網で決着させる」に従う）: 各 PoC は「**検証する事実（discriminating fact）**」「**二値の成功条件**」「**最小の spike**」「**失敗時の分岐**」を書く。合否が解釈の余地なく決まる形にする。既に `docs/` に「実機確認済み」の項目（VC/Stage の join・BGM 送出・UDP・full-duplex 等）があり、それらは対象外。ここは**この設計（制御プレーン＝DO/Worker と、その上の BGM 制御）で新たに未検証な部分**。

- [do-container-plumbing.md](do-container-plumbing.md) — DO ↔ コンテナの制御経路（最優先・土台）
- [sse-monitoring.md](sse-monitoring.md) — 監視の SSE（長時間・複数購読者）
- [bgm-on-discordjs.md](bgm-on-discordjs.md) — BGM 制御（検証・音量・プリフェッチ）
- [instance-sizing.md](instance-sizing.md) — インスタンスサイズの下限（メモリ・CPU をどこまで削れるか）
