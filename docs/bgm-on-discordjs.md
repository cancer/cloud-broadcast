# PoC: BGM 制御（検証・音量・プリフェッチ）

BGM を Stage で鳴らすこと自体は `docs/` で実機確認済みだが、仕様が定めた**制御の振る舞い**（登録時デコード検証・音量可変・全曲プリフェッチ・先頭からの即時切替）を実現する手段は未検証。

## PoC 1: mp3 デコード検証をどこで行えるか

- **検証する事実**: Cloudflare Workers（V8・ffmpeg 無し）で mp3 のデコード可否検証ができるか。
- **二値の成功条件**: Worker 単体で、与えた mp3 がデコード可能かを判定できる（WebCodecs 等で成功／不可）。
- **最小の spike**: Worker で正常な mp3 と壊れた mp3 をデコード試行し、判別できるか。
- **失敗時の分岐**: Worker で不可なら「登録時検証はコンテナに委譲」に倒す（仕様の「登録時に検証」は満たしつつ実行場所を変える）。

## PoC 2: @discordjs/voice の音量制御

- **検証する事実**: `inlineVolume: true`（PCM デコードを伴う）で BGM 音量を可変にでき、CPU が許容範囲か。
- **二値の成功条件**: 再生中に音量が実際に変わる。かつ `standard-3` で CPU が許容内。
- **最小の spike**: `inlineVolume` で BGM を再生し、音量変更の反映と CPU を実測。
- **失敗時の分岐**: CPU が重いなら、将来の受信・ミックス（PCM 前提）と合わせて PCM 常時化するか、別の音量手段を検討。

## PoC 3: 全曲プリフェッチと即時切替

- **検証する事実**: 起動時に R2 から全曲を取得し、切替がフェッチ無しで即時（新曲を先頭から）成立するか。多曲時の起動時間・資源。
- **二値の成功条件**: 切替時に R2 フェッチが発生せず即時に切り替わる。N 曲でも起動が許容時間内。
- **最小の spike**: 数曲をプリフェッチ → 切替の即時性を確認。曲数を増やして起動時間・メモリ/ディスクを観測。
- **失敗時の分岐**: 多曲で破綻するなら、リストの実用上限（dashboard §14 未決）を設けるか、遅延フェッチに変える。

## 参照
`docs/cloud-broadcast-dashboard.md` §5・§7・§12、`docs/cloud-broadcast-discord-audio.md` §6・§7。

## 実施結果

3 つの PoC をすべて実施し、いずれも合格した。PoC 1 は Workers 単体（ローカルの workers ランタイム）で、PoC 2・3 は CF Containers 実機（`standard-3` = 2 vCPU / 8 GiB）で確定した。各 PoC の失敗時分岐はいずれも発動していない。

### PoC 1: mp3 デコード検証（合格）

- Workers 単体（V8・ffmpeg 無し）で mp3 のデコード可否を判別できる。手段は wasm デコーダ `mpg123-decoder`。
- 落とし穴と回避: Workers は実行時の `WebAssembly.compile`（バイト列からのコード生成）を禁止する（`CompileError`）。`mpg123-decoder` が既定で行う inline 圧縮 wasm の実行時展開はそのままでは動かない。ビルド前に wasm を抽出し、静的 wasm import でコンパイル済み `Module` を注入することで回避した。
- 判別の範囲: この検証が答えるのは「デコードして PCM を得られるか」であって「ファイルが完全か」ではない。
  - フレーム内データの破壊は検出できる（`valid=false`）。
  - 先頭欠損・途中切断は mp3 の自己同期により再同期され、`valid=true` になる（検出できない）。
  - この境界は特性化テストで固定した。
- 二値結論: Worker 単体で判定可能＝合格。失敗時分岐「登録時検証をコンテナに委譲」は発動せず。

### PoC 2: @discordjs/voice の音量制御（合格）

- `inlineVolume: true` で再生中に音量を可変にできる。ミックス出力の RMS が gain に線形追随した（90 秒・gain 0.2 / 0.6 / 1.0 で RMS 240 → 715 → 1182、比 2.98 / 4.92 ≒ 理論値 3.0 / 5.0）。
- CPU は許容内。`inlineVolume` 有無による差はほぼ無く（いずれも p95 ≈ 0.63 core／2 vCPU 中＝総容量比 ≈ 31%）、フレームドロップ 0。
- 補足: RMS による実証はミックス／RTMP 経路（`pull` した PCM への直接スケール）で行った。VC 送出経路（prism `VolumeTransformer`）の効きは、暗号化 Opus のため数値化できず、CPU 差分と聴感で担保する。
- 二値結論: 音量が実際に変わり CPU も許容内＝合格。失敗時分岐（PCM 常時化・別の音量手段）は不要。

### PoC 3: 全曲プリフェッチと即時切替（合格）

- 起動時に R2 の全曲を S3 互換 API（`aws4fetch` の SigV4 署名、endpoint `<account>.r2.cloudflarestorage.com`、region `auto`）でプリフェッチする。コンテナは Worker ではなく R2 バインディングを使えないため、S3 API を直叩きする方式を採った。
- 全 N（1・3・5・10・20 曲）で次を確認した。
  - 切替時の R2 フェッチ 0（`fetchesDuringPlayback=0`）。
  - 先頭からの切替（`switchFromHead=true`）。
  - 全曲取得（`getCount=N`）。
  - フレームドロップ 0。
- 起動時間・メモリの曲線（`standard-3`）:

  | N | prefetchMs（起動） | rssMaxMiB |
  |---|---|---|
  | 1 | 2013（cold 含む） | 524 |
  | 3 | 1249 | 664 |
  | 5 | 1611 | 832 |
  | 10 | 3113 | 1125 |
  | 20 | 4861 | 1536 |

  起動時間はほぼ線形（約 250ms/曲）、RSS も線形に増加し、N=20 でも 1536 MiB < 3 GiB に収まる（instance-sizing の worst-case 1.2〜1.6 GB と整合）。
- 検証時の落とし穴: `wrangler r2 object put` は `--remote` 無しだとローカルシミュレータ（`.wrangler/state`）に書き込み、実 R2 は空のままになる。put/get の round-trip は成功するのに、`bucket info` の object_count=0・S3 API の list 空・GET 404 で発覚した。`--remote` を付けて解決。S3 直叩きの実装自体は正しかった。
- 二値結論: 切替フェッチ 0・即時・N=20 でも起動/メモリ許容内＝合格。失敗時分岐（実用上限・遅延フェッチ）は不要。
