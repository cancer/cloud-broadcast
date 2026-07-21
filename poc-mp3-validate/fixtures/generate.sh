#!/usr/bin/env bash
# 判別テスト用の mp3 fixtures を生成する。
# 正常 1 本 + 破損 3 種（先頭削り / 後半切断 / 中間ノイズ上書き）。
# 破損版は valid.mp3 を元に加工するので、valid.mp3 が基準となる。
set -euo pipefail

cd "$(dirname "$0")"

# 正常: 440Hz サイン波 3 秒を libmp3lame でエンコード
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=3" -codec:a libmp3lame -qscale:a 4 valid.mp3

SIZE=$(stat -f%z valid.mp3 2>/dev/null || stat -c%s valid.mp3)

# 破損1: ヘッダ先頭 200B を削る（先頭フレーム同期を破壊）
tail -c +201 valid.mp3 > corrupt-head.mp3

# 破損2: 後半 50% を切断（ストリーム途中で途切れる）
head -c $((SIZE / 2)) valid.mp3 > corrupt-truncated.mp3

# 破損3: 中間部にランダムノイズを上書き（フレーム内データ破壊）
cp valid.mp3 corrupt-noise.mp3
dd if=/dev/urandom of=corrupt-noise.mp3 bs=1 seek=$((SIZE / 2)) count=$((SIZE / 4)) conv=notrunc status=none

ls -l valid.mp3 corrupt-head.mp3 corrupt-truncated.mp3 corrupt-noise.mp3
