#!/usr/bin/env bash
# PoC-3 テスト曲生成: サイン波から N 曲の mp3 を作る。R2 バケットへアップロードし、
# /prefetchtest で「全曲プリフェッチ + 切替時フェッチ0 + 即時（先頭から）切替」を検証する。
#
# 使い方: ./gen-test-songs.sh [曲数=20] [1曲の秒数=180] [出力先=test-songs]
# 曲ごとに周波数を変える（切替が効いているか聴感で区別できるようにするため）。
# キー名は song-NN.mp3（ゼロ埋め）。/prefetchtest?songs=N は list をソートした先頭 N 曲を使う。
set -euo pipefail
cd "$(dirname "$0")"

COUNT="${1:-20}"
DURSEC="${2:-180}"
OUT="${3:-test-songs}"
BUCKET="${R2_BUCKET:-cloud-broadcast-bgm}"

mkdir -p "$OUT"
FREQS=(220 247 262 294 330 349 392 440 494 523)
for i in $(seq 1 "$COUNT"); do
  f=${FREQS[$(( (i - 1) % ${#FREQS[@]} ))]}
  n=$(printf "%02d" "$i")
  ffmpeg -y -loglevel error -f lavfi -i "sine=frequency=${f}:duration=${DURSEC}" \
    -codec:a libmp3lame -qscale:a 4 "$OUT/song-${n}.mp3"
done
ls -l "$OUT"

cat <<EOF

# R2 バケット作成と曲アップロード（deploy 同様ユーザー承認が要る）:
# 注意: --remote 必須。付けないとローカルシミュレータ(.wrangler/state)に書かれ、
# put/get は round-trip 成功するのに実 R2 は空のまま（コンテナの S3 API から見えない）。
wrangler r2 bucket create ${BUCKET}
for f in ${OUT}/*.mp3; do
  wrangler r2 object put "${BUCKET}/\$(basename "\$f")" --file "\$f" --remote
done

# コンテナへ渡す資格情報（R2 API トークンから発行した Access Key ID / Secret Access Key）:
wrangler secret put R2_ACCOUNT_ID
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put R2_BUCKET        # 値は ${BUCKET}
EOF
