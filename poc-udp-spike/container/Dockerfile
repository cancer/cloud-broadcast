FROM node:22-slim
WORKDIR /app

# sodium-native / @discordjs/opus はプラットフォーム毎の prebuild が無い場合ソースビルドに
# フォールバックするため、ビルドツールを入れておく。ffmpeg は RTMPS 送出に同梱（PoC-1 §5.4）。
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 build-essential ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# lockfile で再現ビルド（caret の毎ビルド解決を排除）。npm ci は package-lock.json と厳密一致で入れる。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.mjs voicetest.mjs receive.mjs rtmpout.mjs mixer.mjs bgm.mjs loadgen.mjs metrics.mjs .
COPY standby.png .
COPY assets ./assets
EXPOSE 8080
CMD ["node", "index.mjs"]
