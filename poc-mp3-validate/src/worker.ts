import { type Mp3ValidationResult, validateMp3 } from "./decode";

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      const body: Mp3ValidationResult = {
        ok: false,
        valid: false,
        samples: 0,
        errors: ["POST an mp3 byte body to validate"],
      };
      return Response.json(body, { status: 405 });
    }

    const bytes = new Uint8Array(await request.arrayBuffer());
    try {
      const result = await validateMp3(bytes);
      return Response.json(result);
    } catch (error) {
      // デコーダの初期化・実行自体に失敗した場合。ok:false で「実行しきれなかった」
      // ことを示し、応答は常に Mp3ValidationResult 形式に揃える。
      const body: Mp3ValidationResult = {
        ok: false,
        valid: false,
        samples: 0,
        errors: [error instanceof Error ? error.message : String(error)],
      };
      return Response.json(body);
    }
  },
} satisfies ExportedHandler;
