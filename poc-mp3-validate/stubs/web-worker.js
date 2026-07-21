// @eshaz/web-worker は mpg123-decoder の WebWorker 版デコーダ専用。
// その browser エントリは `module.exports = Worker` で、import 時にグローバル
// Worker を参照する。Workers ランタイムには Worker が無いため、バレル
// (mpg123-decoder の index.js) を読むだけで ReferenceError で落ちる。
// 本 PoC は同期版 MPEGDecoder のみ使い WebWorker 版は生成しないので、
// 未使用の Worker を「生成したら失敗する」空クラスへ差し替える。
export default class WorkerUnavailable {
  constructor() {
    throw new Error("Web Worker is not available in the Cloudflare Workers runtime");
  }
}
