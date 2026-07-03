# Cloud Broadcast MVP — 技術検証ポイント一覧

`docs/cloud-broadcast-mvp-spec.md` の実現可能性を判定するために検証すべき項目を、
**ゲート性（失敗したら設計が成立しないか / ただの実装作業か）** で分類して列挙する。

各項目は「事実を断定」せず「何を・どの一次情報に照らして検証すべきか」として記す
（外部仕様は最新ドキュメントで裏取りが必要なため）。

---

## A. ハード・ゲート（失敗したら現行アーキテクチャは成立しない = go/no-go）

### A-1. Cloudflare Containers でアウトバウンド UDP 音声が成立するか（＝基盤選定の分岐点）
- **なぜ最上位ゲートか**: Discord 音声は UDP のみで TCP フォールバックなし（spec §3.3 L95-98）。
  spec 改訂で**メディアプレーン基盤は「未決」**となり、
  「Cloudflare Containers でアウトバウンド UDP 音声が成立するか」の PoC が
  **最優先かつ基盤選定の分岐点**に格上げされた（spec §3.3 L100, §13 L348-350, §12.2 L334-335）。
  - Cloudflare Containers は **inbound TCP/UDP 不可は公式明記**。だが
    **アウトバウンド UDP（双方向リアルタイム音声）が成立するかはドキュメントに答えがない灰色領域**
    （spec §3.3 L100 が自認）。ここが二値の go/no-go。
  - **成立** → メディアプレーンも Cloudflare に寄せ、制御と同一スタックで最もきれいな構成
  - **不成立** → 9 章の常駐基盤候補（アウトバウンド UDP 可＝Fly.io Machines 等）へ落として同じ PoC を再実施
- **検証内容**:
  - Cloudflare Containers から Discord voice サーバへ**アウトバウンド UDP** が張れ、
    **戻りパケット（受信音声）まで双方向で通る**か（inbound 不可の設計がアウトバウンド発の戻りを
    どう扱うか。IP discovery が成立するか）
  - scale-to-zero・エフェメラル設計が数十分の**常駐ボイス接続**と両立するか（途中で落とされないか）
  - 同じ PoC を Fly.io 等の常駐基盤でも実施（そちらは汎用コンテナで通って当然側だが、確証として）
- **一次情報**: Cloudflare Containers のネットワーク/ライフサイクル・ドキュメント + **実機 PoC**
  （spec §13-1 が「基盤選定と全体構成の分岐点」と置く PoC そのもの）。
  ドキュメントに記載がないため PoC 必須（spec §12.3 L342 も明記）
- **補足**: 汎用基盤（Fly 等）側では Discord voice はボット発のアウトバウンド＋ステートフル NAT で
  戻りも通常成立するため、トランスポート自体より A-2（暗号化）・ハンドシェイクが実質のゲートになる。
  Cloudflare Containers では**トランスポートの成否自体が未知**である点が本質的な違い。

### A-2. Discord voice の暗号化モードを、出荷する `@discordjs/voice` + ネイティブ依存が満たすか
- **なぜゲートか**: Discord は旧 `xsalsa20_poly1305` 系を AEAD モード
  （`aead_aes256_gcm_rtpsize` / `aead_xchacha20_poly1305_rtpsize` 系）へ移行中とされる。
  現在 Discord が受理するモードをライブラリ + コンテナ内の crypto ネイティブ依存（libsodium 等）が
  実装していなければ、UDP が通っても音声は確立しない。A-1 と同じ「存在ゲート」。
- **検証内容**:
  - 現在 Discord voice が**受理する暗号化モードの一覧**（廃止スケジュール含む）
  - 出荷予定の `@discordjs/voice` バージョンが対応モードを実装しているか
  - Docker イメージに必要なネイティブ crypto 依存（libsodium 等）が焼き込めているか
- **一次情報**: 現行 Discord Developer Docs（Voice Encryption Modes の章） + `@discordjs/voice` の対応バージョン
- **注意**: 廃止タイムラインは近年動いている領域。記憶で断定せず現行ドキュメントで確認する。

---

## B. 最大の実装リスク（実現は可能だが、spec が最も作業量を隠している）

### B-1. リアルタイム・クロック駆動のミックス（spec が「加算ミックス」の一言で片付けている核心）
- **なぜ難所か**: spec §2.2 / §6.3 は「受信 PCM 群 + BGM PCM を加算」と書くが、実態は:
  - Discord の受信は**参加者ごとに不連続**。発話中しかパケットが来ず、
    `@discordjs/voice` の receiver は無音でストリームを終了する。
  - 一方 RTMPS/YouTube は**連続・実時間（wall-clock）ペースの PCM** を要求する。
    途切れると配信がストール/デシンクする。
  - したがって必要なのは単なる加算ではなく:
    1. 各不連続受信ストリームを**単調増加する 48kHz タイムライン上へ再配置（ジッタバッファ + 無音ギャップ埋め）**
    2. 連続する BGM PCM と合算
    3. **実時間ペースで** FFmpeg へ供給し、静止画（ループ映像）の映像 PTS を音声クロックに追従させる
- **検証内容**: 上記ジッタバッファ + クロック駆動ミキサを実装した際の音ズレ・欠落・遅延の許容範囲。
  無発話区間の連続性維持。BGM が受信に現れない前提（spec §2.2 補足 L57, L61）の実機確認。
- **位置づけ**: UDP が「存在ゲート」なら、これは**最上位の実装リスク**。PoC 段階で早期に叩くべき。

### B-2. 小型 Fly マシン上での Opus デコード + H.264/AAC リアルタイムエンコードの CPU コスト
- **なぜ検証か**: spec §9.1 は「CPU 軽量」と主張（L268）。だが N 人分の同時 Opus デコード +
  1080p 静止画の連続エンコード + AAC は無視できず、**マシンサイズ（＝コスト）を決める**。
- **検証内容**: 想定同時発話人数での実測 CPU 使用率。必要な Fly マシンの vCPU/メモリ帯。
  静止画エンコードを軽くする余地（fps 15 / 低ビットレートは spec §5.2 で既定）。

---

## C. 実現可能・要確認だが致命的でない（ルーチンな検証）

### C-1. Cloudflare Workers → Fly.io Machines API による起動/停止
- **検証内容**: Workers から Fly Machines API でコンテナを起動・破棄できるか、起動時に環境変数/引数で
  構成 + 短命トークンを注入できるか（spec §3.2, §6.4）。状態遷移（§4.2）を D1 に記録。

### C-2. Secret 注入経路（Cloudflare Secrets Store → メディアプレーン）
- **検証内容**: 長命 Secret を制御プレーンに留め、短命・最小限のみコンテナへ渡す運用（spec §8）が
  Fly の secret / 環境変数注入で成立するか。`secret://` 参照の Zod バリデーション（§5.4）。

### C-3. YouTube Live RTMPS ingest のハンドシェイクと再接続
- **検証内容**: FFmpeg から `rtmps://` で YouTube ingest へ push できるか（spec §7.1）、
  接続断時の挙動。MVP は手動ストリームキー（§7.2）なので OAuth は範囲外。

### C-4. コスト上限の予測可能性（基盤未決のため候補比較）
- **検証内容**: A-1 の結果で基盤が決まってから確定。Cloudflare Containers 成立時は Cloudflare 側コストへ統合
  （spec §9.2 L272 が別途要算出と明記）。不成立時は 9 章の常駐候補（Fly.io 約40円/最悪340円 等）を
  現行料金で再確認。会社要件は「上限 n を言い切れること」（§9.3）。

---

## D. 規約・継続性リスク（「今動くか」とは別軸）

### D-1. Discord voice **受信** は非公式・未サポート扱い
- **なぜ別軸か**: 音声**受信**は Discord が公式にドキュメント化・サポートしていない領域とされる
  （spec §6.1 L201, §10 L291, §11.3 も「規約上の扱いを確認」と明記）。
  「今日動く」ことと「規約上許容され将来も動く」ことは別。バイナリゲートと混同しない。
- **検証内容**: 現行 Discord デベロッパーポリシー上の音声受信の扱い。録音・配信明示の運用担保（§10）。
  `@discordjs/voice` receive API の仕様変更履歴（spec が「仕様変更歴あり」と警告 §6.1, §11.3）。

---

## 調査結果（一次情報での裏取り｜2026-07 時点）

research で決着した3点。**A-1 は spec §13 の方針を実質的に覆す結論**なので最優先で反映すべき。

### A-1【ドキュメントでは未決｜実機 spike でしか決着しない】CF Containers のアウトバウンド生 UDP
- **inbound（確定）**: 「end-users cannot make non-HTTP TCP or UDP requests to a Container instance」
  （公式アーキ・ドキュメント明記）。inbound UDP は**確定的に不可**。ただし Discord voice は
  Bot 発のアウトバウンドなので、これ単体では致命傷にならない。
- **outbound（本件の核心・未決）**: 公式ドキュメントは egress を **HTTP/HTTPS 中心**に説明するが、
  **生 UDP の可否を肯定も否定もしていない**。
  - 「Outbound handlers only intercept HTTP and HTTPS traffic. Traffic on ports other than `80`/`443`
    is **never routed through** outbound/outboundByHost」← これは「ハンドラが介入しない」であって
    「遮断する」ではない。むしろ非 HTTP は**未介入で通過する**含みとも読める。
  - architecture ドキュメントは egress 詳細を FAQ に委譲、FAQ は outbound-traffic に委譲、と
    **三者とも生 UDP に answer していない**（＝ドキュメントの天井に到達。追加の検索では解決不能）。
- **判定（判断保留）**: 「記述の不在」を「不成立」に読み替えない。**現行ドキュメントでは未決**。
  決着する discriminating fact は一つ:「コンテナの egress は Workers ランタイム経由で仲介されるのか、
  コンテナが直接ソケットを開けるのか」。
  - Workers 仲介なら → Workers のソケット API は `connect()`/**TCP 専用（UDP API 無し）**のため
    アウトバウンド UDP は不可能。
  - コンテナが直接 egress を持つなら → UDP が通る可能性がある。
  - **これはドキュメントで解けず、実機 spike でしか判定できない**。＝ spec §13 の
    「CF UDP PoC を最優先」という要求は**正しかった**。research はその PoC を不要にしたのではなく、
    「なぜ PoC が必要か（ドキュメントに答えが無いから）」を裏取りした。
- **リスクと payoff**: egress が HTTP 中心のため**高リスク**。ただし**成立すれば制御・メディアが
  Cloudflare に統一される**（ユーザーが spec 改訂で狙った payoff）。高リスク・高リターンの二値ゲート。
- **一次情報**:
  - https://developers.cloudflare.com/containers/platform-details/outbound-traffic/
  - https://developers.cloudflare.com/containers/platform-details/architecture/
  - https://developers.cloudflare.com/containers/faq/
  - https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/ （Workers ソケットは TCP 専用）
- **ライフサイクル（副産物・決着）**: scale-to-zero は**既定挙動**だが `sleepAfter` で常駐可能・上限記述なし。
  つまり「30分常駐」自体は CF でもブロッカーではない。**残る未決は UDP egress の一点のみ**。

### A-2【決着＝解決可能】暗号化モードは現行ライブラリ＋ネイティブ依存で満たせる
- Discord は **`xsalsa20_poly1305*` 系を 2024-11-18 に廃止**。以降その旧モードでは voice gateway に
  接続不可。**`aead_xchacha20_poly1305_rtpsize` は必須**、`aead_aes256_gcm_rtpsize` は可能なら優先
  （利用可否は Opcode 2 Ready で通知される）。
- `@discordjs/voice`（0.19.0）は `encryptionMode` を持ち、暗号化は optional 依存を要求。
  **`sodium-native`（推奨）等の crypto ネイティブ依存**を Docker に焼き込めば AEAD モードに対応。
  Opus は `@discordjs/opus`、FFmpeg も同梱が必要。
- **判定**: **ゲートではなく実装作業**。現行 `@discordjs/voice` + `sodium-native` を pin すれば通る。
  DAVE（E2EE、`@snazzah/davey`）が絡む場合のみ追加確認（受信対象 VC の E2EE 有無次第）。
- **一次情報**: Discord Change Log（Voice）/ discord-api-docs Issue #6059 / discord.js voice 0.19.0 docs。

### D-1【決着＝継続性リスクとして残す】Bot の音声受信は Discord 公式には未サポート
- Discord は **Bot による音声受信を公式にはサポート/ドキュメント化していない**（"Discord does not
  officially support bots receiving audio"）。
- **切り分け注意**: `@discordjs/voice` 自体は discord.js org 管理の**公式ライブラリ**。
  非公式なのはライブラリではなく **Discord プラットフォーム側の「受信」という挙動**であり、
  公式ライブラリがその未保証の挙動を実装している、という関係。
  リスクは「ライブラリが野良」ではなく「**受信 API を Discord が保証せず仕様変更で壊れうる**」点にある。
- **判定（重み付け）**:
  - **技術的に壊れるリスク = 低確率の背景リスク**。受信は discord.js 経由で長年 de-facto 安定稼働し
    エコシステムも追随している。「公式ライブラリの API が突然消える」形では起きにくい。
    現実的な形は「Discord が voice 下回りを変更 → 一時的に壊れて追随を待つ窓」（2024-11 の暗号化強制移行が
    その precedent）だが、これも結局ライブラリが追いつく話で恒久的 go/no-go ではない。
    かつこの種の依存破壊リスクは discord.js に限らず何にでも付く背景リスクで、構築判断を止める理由にならない。
  - **実際に手を動かす価値がある D-1 の核心 = コンプラ側**。録音・配信明示（spec §10、取得済み）と
    プライバシーポリシー掲示（Developer Policy 要件）の運用担保。こちらを D-1 の主タスクとする。
- **一次情報**: discord.js voice guide / discordjs/discord.js Issue #2929 / Discord Developer Policy。

---

## 検証の推奨順序（調査結果を反映）

> **research が変えたこと / 変えなかったこと**: A-2・D-1 は決着（実装作業／継続性リスク）。
> A-1 はドキュメントでは未決で、**spec §13 の「CF UDP PoC 最優先」は依然として正しい**
> （ドキュメントに答えが無いので実機でしか判定できない）。research はその PoC を不要にしていない。
> 変更提案は順序ではなく**リスク分散**: CF spike は当たれば payoff（スタック統一）が大きいが高リスクなので、
> Fly.io の既知良好な PoC を**並行または直後に**走らせてタイムラインを de-risk する。

0. **CF Containers UDP spike（first-class の早期ゲート）** — 最小構成で
   「コンテナからアウトバウンド UDP ソケットを Discord voice エンドポイントへ開き、戻りパケットを
   受け取れるか」を **yes/no で判定**。成立 → メディアも CF に統一（payoff）。不成立 → 常駐基盤へ。
   - 合否基準を crisp に: UDP ソケット確立＋戻り受信の有無。曖昧な「動きそう」で終わらせない。
1. **本命 PoC（Fly.io 等の常駐基盤）** — `@discordjs/voice` で VC join → 会話受信 → RTMPS 送出。
   A-2（`sodium-native` + AEAD モード）と D-1（受信 API）もここで同時に通す。
   - 位置づけは「research が CF を殺したから」ではなく「**既知良好でタイムラインを de-risk する**」。
2. **B-1** をその PoC に載せて RTMPS 送出まで通す（不連続受信の連続化・音ズレの実測）
3. **B-2** の CPU 実測でマシンサイズ確定（基盤確定後）
4. C 群（制御プレーン・Secret・コスト）は上位設計に影響しないので後続で可
5. **D-1** は実装と並行して録音明示・プライバシーポリシーの運用担保（技術可否とは独立）
