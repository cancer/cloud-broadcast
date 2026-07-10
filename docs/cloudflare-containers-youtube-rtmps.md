# Cloudflare Containers + YouTube RTMPS

Cloudflare Containers 上の FFmpeg から YouTube Live へ RTMPS で映像・音声を push するための設定と注意点。実機（CF Containers）で YouTube への受理・継続送出・アーカイブ再生を確認した結果に基づく。

## 前提スタック

- コンテナに `ffmpeg` を同梱（Dockerfile で `apt-get install ffmpeg`）。
- 音声は標準入力（`pipe:0`）から s16le / 48kHz / stereo の生 PCM を受け、FFmpeg が H.264 + AAC にエンコードして RTMPS 送出する。
- Cloudflare 側の基盤設定（Containers = Durable Object 構成、`instance_type`、egress の有効化、secret、rollout など）は「Cloudflare Containers + Discord Bot」ドキュメントと共通。ここでは送出固有の点のみ記す。

## 送出先と Secret

- 送出先は **YouTube Studio の「ライブ配信」ダッシュボードで発行される**「ストリーム URL」＋「ストリームキー」。RTMPS の ingest は `rtmps://a.rtmps.youtube.com/live2/` をベース URL とし、末尾にストリームキーを付ける。ストリームキーは Studio のストリーム設定から取得でき、再生成も可能。
- ストリームキーは秘匿情報。CF secret として投入する: `wrangler secret put YOUTUBE_STREAM_KEY`。
- egress（`enableInternet`）が有効なら、コンテナからの RTMPS アウトバウンドは通る。

## FFmpeg のエンコード設定

### YouTube ingest のハード要件（外すと受理されない）

- 映像コーデックは H.264、音声コーデックは AAC。
- ピクセルフォーマットは yuv420p（4:2:0）。
- RTMP/RTMPS のコンテナフォーマットは FLV（`-f flv`）。
- 定期的なキーフレーム（GOP）。YouTube 推奨はキーフレーム間隔 2 秒程度。フレームレートに対して GOP 長を合わせる（例: 15fps なら `-g 30` = 2 秒間隔）。

### 自由に調整してよい値

- 解像度・フレームレート・映像ビットレート（`-b:v`）・音声ビットレート（`-b:a`）・エンコード preset は、[YouTube の推奨エンコーダ設定](https://support.google.com/youtube/answer/2853702)の範囲で用途に合わせて変更してよい。`-tune stillimage` は静止画中心の配信向けの最適化で任意。
- 実機で YouTube 受理・アーカイブ再生を確認した設定例: 1080p / 15fps / `-b:v 1000k`、AAC `-b:a 160k` / 48kHz、`-preset veryfast`。

### 構成上の注意点

- 映像がループ静止画・音声が stdin という構成では **`-shortest` を付けない**。映像と音声の長さが揃わず、付けると出力が途中で止まる／縮む。配信の本体は stdin から供給する音声側。

## PCM の供給ペースと背圧

- 20ms 実時間ペースでフレームを書き込む。1 フレーム = 3840 バイト（960 サンプル × 2ch × 2byte、48kHz / stereo / s16le）。
- 供給が FFmpeg の消費より速いと標準入力が詰まる（背圧）。詰まりを検知したら待機し、詰まった回数を underrun として集計する。音声が不足する区間は無音フレームでパディングし、供給が途切れないようにする。

## 性能（standard-3 / 1080p 実測）

- 定常 CPU: p50 約 35% / p95 約 39%（2 vCPU 基準、話者数 N=2）。
- RSS: 約 430 MiB（standard-3 の 8 GiB に対し僅少）。
- 送出は定常で realtime（speed 約 1.0x）に乗り、フレームドロップ 0。
- **エンコード（1080p 静止画）が CPU の支配項で、話者数はほとんど効かない。** 音声の送受信処理より映像エンコードの方が重い。RTMPS 送出自体の負荷はエンコードに比べ微小。

### warmup の注意点

- 配信開始直後の約 10〜20 秒に数個の underrun が出うる（開始直後にわずかな音欠けの可能性）。これは負荷問題ではなく warmup。必要なら FFmpeg のプライム／事前バッファで平滑化する。

## 継続性・稼働時間

- 長時間の連続送出は安定（10 分連続で underrun 0 / フレームドロップ 0 / クロックドリフト ±38ms 程度で非発散を確認）。
- 送出の継続時間は、コンテナを起こし続ける接続（HTTP / DO）が維持されている限り制限されない。稀なランタイム更新でインスタンスが terminate される場合に備え、中断検知と自動リカバリ（再起動・再接続・再送出）を別途用意する。
