# PoC: インスタンスサイズの下限（メモリ・CPU）

仕様は `standard-3`（2 vCPU / 8 GiB）を起点に選定した（`docs/cloudflare-containers-discord-bot.md`「instance_type の選定」）。実測は定常 CPU 約 35%（2 vCPU 基準 ≒ 0.7 vCPU）・RSS 約 430 MiB（`docs/cloudflare-containers-youtube-rtmps.md`「性能」）で、割り当てに対して大きな余剰がある。どこまで削れるかを実機で確かめる。

## 前提（課金とプラットフォーム制約が選択肢を絞る）

- **CPU は実使用ベース課金**（[2025-11-21 変更](https://developers.cloudflare.com/changelog/post/2025-11-21-new-cpu-pricing/)）。vCPU 割り当てを減らしても CPU 課金は下がらない。**メモリ（とディスク）はプロビジョンベース課金**のままなので、コストの主レバーは**メモリ割り当ての削減**（[Pricing](https://developers.cloudflare.com/workers/platform/pricing/)）。
- カスタムインスタンスタイプの制約: vCPU は 1〜4、**メモリは vCPU あたり最低 3 GiB**（[Limits](https://developers.cloudflare.com/containers/platform-details/limits/#custom-instance-types)）。つまり 2 vCPU のままではメモリは 6 GiB までしか削れず、**3 GiB まで削るには 1 vCPU で成立することが条件**。
- 1 vCPU 未満は既定タイプのみ（`basic`: 1/4 vCPU / 1 GiB、`standard-1`: 1/2 vCPU / 4 GiB）。実測 0.7 vCPU がどちらの割り当ても上回るため、机上で除外する（PoC 不要）。
- 判定は必ず**フルワークロード**（Discord 接続 + BGM 再生 + 1080p エンコード + RTMPS 送出）で行う。部分負荷での合格は判定に使わない。

## PoC 1: 1 vCPU で配信パイプラインが実時間を維持するか

- **検証する事実**: 実測 0.7 vCPU 相当の負荷が、1 vCPU 割り当てで実時間処理を維持するか。0.7 という値は 2 コアでの計測であり、1 コアではエンコーダのスレッド並列が効かないため、数字がそのまま移る保証はない。
- **二値の成功条件**: フルワークロードを連続 30 分流し、ffmpeg の処理速度が実時間を下回らず（speed ≥ 1.0x・フレームドロップなし）、Stage / YouTube の音声が途切れない。
- **最小の spike**: 同一ワークロードを `instance_type = { vcpu = 1, memory_mib = 3072, ... }` で起動し、ffmpeg progress・ドロップ数・CPU 使用率を観測。
- **失敗時の分岐**: 1 vCPU で破綻するなら 2 vCPU に留め、次候補はカスタム `{ vcpu = 2, memory_mib = 6144 }`（メモリ 8 → 6 GiB）。PoC 2 の判定枠を 6 GiB に読み替えて続行する。

## PoC 2: ピークメモリが 3 GiB に収まるか

- **検証する事実**: フルワークロードのピークメモリ（定常 RSS 約 430 MiB + BGM 全曲プリフェッチ + 起動時ピーク）が、削減後の割り当てに収まるか。プリフェッチ分は曲数に依存し未実測（`bgm-on-discordjs.md` PoC 3 と同時に測ると一回で済む）。
- **二値の成功条件**: 実用想定の曲数をプリフェッチした上で、起動 → BGM 切替 → 配信 → 停止の全操作と連続 30 分の稼働を通して OOM kill が発生しない。
- **最小の spike**: フルワークロードでピーク RSS を実測 → `memory_mib = 3072`（PoC 1 失敗時は 6144）で同じ操作を流し、OOM の有無を確認。
- **失敗時の分岐**: OOM するなら一段上の割り当てに戻す。プリフェッチ分が支配項なら、メモリ下限は曲数上限（dashboard §14 未決）とセットで決めるか、プリフェッチの置き場をディスクに倒す。

## 実施結果（2026-07-12・CF 実機）

`poc-udp-spike` の `/sizetest`（フルワークロード: Discord 接続 + BGM 送出/ミックス + 1080p エンコード
+ RTMPS 送出、`loadgen=2` で合成2話者、`prefetch=20 曲×240s` で PoC 2 のピークメモリを再現）で実測。

### PoC 1（1 vCPU で実時間維持するか）
- **15fps では不可**。1vcpu 30分ラン: CPU **p50 0.875 / p95 0.995**（単一コア飽和・余裕ゼロ）、
  underrun 10775（時間比例で増加＝慢性背圧）、10分ライブでは **VC の BGM が断続的に途切れ**、
  **YouTube ingest が「準備中」から live に上がれない**（実地確認）。→ **1 vCPU / 15fps は FAIL**。
- **fps を落とすと成立**。支配項は静止画の映像エンコードなので、`/sizetest?fps=` で fps を下げると
  CPU が概ね比例して減る（話者数はほぼ効かない＝音声処理は小、`poc1-3-handoff.md` H3 と整合）。
  **fps=1 で 1vcpu が CPU p50 0.875→0.092 / p95 0.12**（headroom 88%）、underrun 72/120s（warmup 集中）、
  **YouTube が 1fps を受理して live 到達・VC 連続**。→ **1 vCPU / 3 GiB は fps=1（静止画前提）で PASS**。
- fps=1 の前提: **単色静止画だから画質ロスなし**。テロップ/波形/シーン切替など動きのある映像を出すなら
  fps を上げる必要があり、その時は CPU が戻って 1 vCPU に収まらなくなる。**「静止画配信」とセットの下限**。
- YouTube 側条件: キーフレーム 2 秒間隔（GOP=fps×2 で担保）、fps は「その他の値も受け入れ可」
  （[YouTube Help](https://support.google.com/youtube/answer/2853702)）。1fps 受理は実地確認。

### PoC 2（ピークメモリが割当に収まるか）
- 1vcpu/3GiB・prefetch 20曲で **ピーク RSS 1204〜1608 MiB**（割当の 40〜52%）、OOM なし、
  起動→BGM 切替→配信→停止・連続稼働を通して収まる。→ **3 GiB で PASS**。

### 2 vCPU フォールバック（1 vCPU が使えない構成向け）
- 動きのある映像等で fps を下げられない場合の下限。`{vcpu:2, memory_mib:6144}` 3分ラン:
  CPU **p50 0.378 / p95 0.428**（standard-3 同水準）、RSS 1380/6185、**live 到達・VC 連続**。→ PASS。
- メモリ下限が 6 GiB なのは custom 制約「3 GiB / vCPU」から（2×3）。standard-3 の 8 GiB からは削減。

### 付随: YouTube「ビットレートが推奨値より低い」警告は誤警報
- 単色静止画（映像ほぼ 0 bit）＋ AAC 160k ＝ 実ビットレート ~172 Kbps が正常値。YouTube は 1080p に
  motion video の 4〜6 Mbps を期待するため常に警告するが、**サイジング・健全性の信号ではない**。

### 結論と本番反映
- **標準は custom `{vcpu:1, memory_mib:3072, disk_mb:6000}` + 送出 fps=1**（静止画前提）。
  standard-3 比でメモリ 8→3 GiB・ディスク 16→6 GB。CPU は実使用ベース課金で割当変更の影響なし。
- **要注意**: 削減は送出経路が実際に fps=1 で回って初めて効く。制御プレーン実装時、ffmpeg の
  framerate 既定を 1（or 静止画前提の低値）にすること（`/sizetest` の既定は 15 のまま）。
- 1 vCPU 未満（`basic` 1/4vCPU/1GiB 等）は custom 不可＝既定タイプのみ。1 GiB は起動スパイク
  （max ~0.83 vCPU 相当）でスロットル＋prefetch 次第で OOM リスクがあり、別途要検証。
- 別タスク: BGM 切替（`bgm.swap` の `player.stop(true)`→再開）が node ループを一瞬止め、切替時に
  VC/配信が瞬間バッファする。サイジングとは別軸で、クロスフェード/次曲プリバッファ等で平滑化可能。

## 参照

`docs/cloudflare-containers-discord-bot.md`「instance_type の選定」、`docs/cloudflare-containers-youtube-rtmps.md`「性能」、[Limits and Instance Types](https://developers.cloudflare.com/containers/platform-details/limits/)（custom 制約: 最低 1 vCPU・3 GiB/vCPU・最大 2 GB disk/1 GiB mem）、[Pricing](https://developers.cloudflare.com/workers/platform/pricing/)、[YouTube 配信エンコーダ設定](https://support.google.com/youtube/answer/2853702)。
