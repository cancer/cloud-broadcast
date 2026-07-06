// PoC-2 核心: 不連続な受信 PCM を単調 48kHz タイムラインへ再配置（per-user ジッタバッファ +
// 無音ギャップ埋め）し、BGM を gain 付きで Int16 飽和加算、wall-clock 駆動で 20ms フレームを出す。
// 基盤非依存・単体テスト可（spec §5.1）。setInterval は「起床のきっかけ」であって出力量の基準に
// してはいけない（§5.2-3, §9）。出すフレーム数は必ず経過時間から算出する。

const S16_MAX = 32767;
const S16_MIN = -32768;

export class Mixer {
  constructor({ sampleRate = 48000, channels = 2, frameMs = 20, jitterMs = 60, onFrame } = {}) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.frameMs = frameMs;
    this.onFrame = onFrame;

    this.samplesPerFrame = Math.round(sampleRate * frameMs / 1000); // per channel (48k,20ms => 960)
    this.frameBytes = this.samplesPerFrame * channels * 2;          // s16le (=> 3840)
    this.jitterFrames = Math.ceil(jitterMs / frameMs);              // 遅延フレーム数（60ms/20 => 3）

    // per-user: { buf: Buffer(FIFO), readyAtFrame: number|null }
    this.users = new Map();
    this.bgmPull = null;
    this.bgmGain = 0;

    this.t0 = null;
    this.timer = null;
    this._logTimer = null;

    // stats
    this.framesOut = 0;
    this.gapFrames = 0;
    this.underruns = 0;
    this.peakClip = 0;
    this.clockDriftMs = 0;
    this.clockDriftMsMax = 0;
    this._silenceFrame = Buffer.alloc(this.frameBytes); // 再利用用の無音フレーム
  }

  // 不連続な受信 PCM。到着時刻を push 時刻とみなし、jitter 分だけ遅延させて再生位置を決める。
  pushUser(userId, pcmChunk) {
    if (!pcmChunk || pcmChunk.length === 0) return;
    let u = this.users.get(userId);
    if (!u) { u = { buf: Buffer.alloc(0), readyAtFrame: null }; this.users.set(userId, u); }
    // バースト開始（FIFO が空 = 直前まで無音）なら、現在フレーム + jitter 後に再生開始
    if (u.buf.length < this.frameBytes && u.readyAtFrame === null) {
      const dueFrame = this.t0 === null ? 0 : Math.floor((Date.now() - this.t0) / this.frameMs);
      u.readyAtFrame = dueFrame + this.jitterFrames;
    }
    u.buf = u.buf.length === 0 ? Buffer.from(pcmChunk) : Buffer.concat([u.buf, pcmChunk]);
  }

  setBgm(pullFn, gain) { this.bgmPull = pullFn; this.bgmGain = gain; }

  start() {
    this.t0 = Date.now();
    // タイマは frameMs 間隔の起床のきっかけ。出すフレーム数は tick 内で経過時間から算出する。
    this.timer = setInterval(() => this._tick(), this.frameMs);
    this._logTimer = setInterval(() => {
      console.log('mixer', JSON.stringify({ ...this.stats() }));
    }, 10000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this._logTimer) clearInterval(this._logTimer);
    this.timer = this._logTimer = null;
  }

  _tick() {
    const due = Math.floor((Date.now() - this.t0) / this.frameMs);
    // 遅延したら複数フレームで追いつく（ドリフト蓄積を防ぐ）
    while (this.framesOut < due) this._emitFrame();
    this.clockDriftMs = this.framesOut * this.frameMs - (Date.now() - this.t0);
    if (Math.abs(this.clockDriftMs) > Math.abs(this.clockDriftMsMax)) this.clockDriftMsMax = this.clockDriftMs;
  }

  _emitFrame() {
    const n = this.samplesPerFrame * this.channels; // 総サンプル数（インタリーブ）
    const acc = new Int32Array(n); // 加算は 32bit で行い最後に飽和
    let anyUser = false;

    for (const [, u] of this.users) {
      if (u.readyAtFrame !== null && this.framesOut >= u.readyAtFrame && u.buf.length >= this.frameBytes) {
        anyUser = true;
        for (let i = 0; i < n; i++) acc[i] += u.buf.readInt16LE(i * 2);
        u.buf = u.buf.subarray(this.frameBytes);
        if (u.buf.length < this.frameBytes) u.readyAtFrame = null; // バースト末尾 → 次 push で再バッファ
      }
    }

    if (this.bgmPull && this.bgmGain > 0) {
      const bgm = this.bgmPull(this.samplesPerFrame); // frameBytes ちょうどを期待
      if (bgm && bgm.length >= this.frameBytes) {
        for (let i = 0; i < n; i++) acc[i] += Math.round(bgm.readInt16LE(i * 2) * this.bgmGain);
      }
    }

    // 全 user が無音（BGM は別集計）なら gapFrame
    if (!anyUser) this.gapFrames++;

    // Int16 飽和
    const out = Buffer.allocUnsafe(this.frameBytes);
    for (let i = 0; i < n; i++) {
      let s = acc[i];
      if (s > S16_MAX) { s = S16_MAX; this.peakClip++; }
      else if (s < S16_MIN) { s = S16_MIN; this.peakClip++; }
      out.writeInt16LE(s, i * 2);
    }

    this.framesOut++;
    // onFrame が false を返したら背圧（FFmpeg stdin の drain 待ち）とみなし underrun 計上
    const ok = this.onFrame ? this.onFrame(out) : true;
    if (ok === false) this.underruns++;
  }

  stats() {
    return {
      framesOut: this.framesOut,
      gapFrames: this.gapFrames,
      underruns: this.underruns,
      clockDriftMs: this.clockDriftMs,
      clockDriftMsMax: this.clockDriftMsMax,
      peakClip: this.peakClip,
    };
  }
}
