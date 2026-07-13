import { MPEGDecoder } from "mpg123-decoder";
import mpgWasmModule from "./mpg123.wasm";

// Workers ランタイムは実行時の wasm コンパイル（バイト列からの codegen）を禁じる
// （WebAssembly.compile は "Wasm code generation disallowed by embedder" で失敗）。
// mpg123-decoder は既定で inline 圧縮文字列を実行時 compile するためそのままでは動かない。
// 対策: デプロイ時にコンパイル済みの module（.wasm の静的 import）をライブラリへ注入する。
// MPEGDecoder.module がセットされていると内部は compile を行わず、これを
// WebAssembly.instantiate(module, imports) に渡すだけになる（実行時 instantiate は許可）。
// 圧縮文字列の展開に使う puff wasm も compile されなくなるため、両 wasm 経路を回避できる。
// mpgWasmModule の中身は scripts/extract-wasm.mjs が生成する（ライブラリ更新時は再実行）。
(MPEGDecoder as unknown as { module: WebAssembly.Module }).module = mpgWasmModule;

export interface Mp3ValidationResult {
  // デコーダを実行しきれたか（例外なく decode を完了できたか）
  ok: boolean;
  // mp3 として正常にデコードできたか（サンプルが出力され、デコードエラーが無い）
  valid: boolean;
  // デコードできた総サンプル数
  samples: number;
  // デコード中に mpg123 が報告したエラーメッセージ
  errors: string[];
}

export async function validateMp3(bytes: Uint8Array): Promise<Mp3ValidationResult> {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const { samplesDecoded, errors } = decoder.decode(bytes);
    return {
      ok: true,
      valid: samplesDecoded > 0 && errors.length === 0,
      samples: samplesDecoded,
      errors: errors.map((error) => error.message),
    };
  } finally {
    decoder.free();
  }
}
