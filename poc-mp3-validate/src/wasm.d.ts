// Workers は .wasm を静的 import でコンパイル済み WebAssembly.Module として渡す。
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
