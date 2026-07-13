import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Mp3ValidationResult } from "../src/decode";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    VALID_MP3: string;
    CORRUPT_HEAD_MP3: string;
    CORRUPT_TRUNCATED_MP3: string;
    CORRUPT_NOISE_MP3: string;
  }
}

const toBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const validate = async (base64: string): Promise<Mp3ValidationResult> => {
  const res = await SELF.fetch("https://example.com/", {
    method: "POST",
    body: toBytes(base64),
  });
  expect(res.status).toBe(200);
  return res.json();
};

// このスイートは Workers 単体での mp3 デコード可否判定を検証する。
// 実測で分かった「壊れ方による判別可能性の差」も特性化テストとして固定する:
//   - フレーム内データの破壊（ランダムノイズ上書き）はデコードエラーとして検出できる → invalid
//   - 構造的欠損（先頭ヘッダ削り / 途中切断）は検出できない。mp3 は自己同期する
//     フレーム列なので、デコーダは残りを PCM として復号し valid と判定する
// つまり本判定は「デコードして PCM を得られるか」であり、「ファイルが完全か」ではない。
describe("mp3 validation Worker", () => {
  it("正常な mp3 を valid と判定する（3 秒 44.1kHz = 132300 サンプル）", async () => {
    const result = await validate(env.VALID_MP3);
    expect(result.ok).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.samples).toBe(132300);
    expect(result.errors).toHaveLength(0);
  });

  it("フレーム内をランダムノイズで上書きした mp3 は invalid（デコードエラーを検出）", async () => {
    const result = await validate(env.CORRUPT_NOISE_MP3);
    expect(result.ok).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("先頭 200B 欠損は検出できない: 残りフレームに再同期し valid になる", async () => {
    const result = await validate(env.CORRUPT_HEAD_MP3);
    expect(result.ok).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.samples).toBeGreaterThan(0);
  });

  it("後半 50% 切断は検出できない: 残り分を PCM 化し valid になる（サンプルは減る）", async () => {
    const result = await validate(env.CORRUPT_TRUNCATED_MP3);
    expect(result.ok).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.samples).toBeGreaterThan(0);
    expect(result.samples).toBeLessThan(132300);
  });

  it("空ボディは valid=false（サンプル 0）", async () => {
    const res = await SELF.fetch("https://example.com/", { method: "POST" });
    expect(res.status).toBe(200);
    const result: Mp3ValidationResult = await res.json();
    expect(result.ok).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.samples).toBe(0);
  });

  it("POST 以外は 405 を返す", async () => {
    const res = await SELF.fetch("https://example.com/", { method: "GET" });
    expect(res.status).toBe(405);
  });
});
