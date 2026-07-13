// mpg123-decoder は wasm を圧縮済み文字列として inline で持ち、実行時に
// WebAssembly.compile で展開・コンパイルする。Workers ランタイムは実行時の
// wasm コンパイル（バイト列からの codegen）を禁じるため、この経路は使えない。
//
// 対策として、デプロイ時に静的 import できる生 .wasm を事前に取り出す。
// 展開はライブラリ自身の inflateDynEncodeString を Node（実行時コンパイル可）で
// 走らせて行う。出力 src/mpg123.wasm を worker が import module として読む。
//
// mpg123-decoder を更新したらこのスクリプトを再実行して mpg123.wasm を作り直す。
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// package の exports が subpath を塞ぐので絶対パスで読む（絶対 import は exports 非適用）
const emscriptenPath = path.join(
  root,
  "node_modules/mpg123-decoder/src/EmscriptenWasm.js",
);
const commonPath = path.join(
  root,
  "node_modules/@wasm-audio-decoders/common/src/WASMAudioDecoderCommon.js",
);

const { default: EmscriptenWASM } = await import(emscriptenPath);
const { default: WASMAudioDecoderCommon } = await import(commonPath);

// 静的メソッド（inflateDynEncodeString 等）はコンストラクタ初回実行時に定義される
new WASMAudioDecoderCommon();

// EmscriptenWASM.wasm（圧縮済み文字列）の getter も初回構築時に定義される
new EmscriptenWASM(WASMAudioDecoderCommon);

const bytes = await WASMAudioDecoderCommon.inflateDynEncodeString(
  EmscriptenWASM.wasm,
);

const outPath = path.join(root, "src", "mpg123.wasm");
writeFileSync(outPath, Buffer.from(bytes));
console.log(`wrote ${outPath} (${bytes.byteLength} bytes)`);
