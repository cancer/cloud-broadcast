FROM node:22-slim
WORKDIR /app

# sodium-native はプラットフォーム毎の prebuild が無い場合ソースビルドにフォールバックするため、
# ビルドツールを入れておく（PoC のため多少のイメージ肥大は許容）
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json .
RUN npm install --omit=dev

COPY index.mjs voicetest.mjs .
EXPOSE 8080
CMD ["node", "index.mjs"]
