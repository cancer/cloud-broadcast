import { readFileSync } from "node:fs";
import path from "node:path";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// fixtures は Node 側（config 評価時）で読み、base64 のテスト専用 binding として
// Workers ランタイムへ渡す。workerd にファイルシステムは無いため、テスト内では
// この binding を Uint8Array に戻して使う。
const fixture = (name: string): string =>
  readFileSync(path.join(__dirname, "fixtures", name)).toString("base64");

export default defineWorkersConfig({
  // wrangler.jsonc の alias と同じ理由で @eshaz/web-worker を空スタブへ差し替える。
  resolve: {
    alias: {
      "@eshaz/web-worker": path.join(__dirname, "stubs", "web-worker.js"),
    },
  },
  test: {
    // mpg123-decoder を Vite 側でバンドルさせ、上の @eshaz/web-worker alias を
    // 効かせる。バンドルしないと workerd がスタブを外部モジュールとして解決できず
    // "No such module" になる（Cloudflare 既知問題 / module-resolution）。
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: ["mpg123-decoder"],
        },
      },
    },
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            VALID_MP3: fixture("valid.mp3"),
            CORRUPT_HEAD_MP3: fixture("corrupt-head.mp3"),
            CORRUPT_TRUNCATED_MP3: fixture("corrupt-truncated.mp3"),
            CORRUPT_NOISE_MP3: fixture("corrupt-noise.mp3"),
          },
        },
      },
    },
  },
});
