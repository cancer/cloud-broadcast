import fs from 'node:fs';
import prism from 'prism-media';

// PoC-3 §5.1: 録音済み Opus を 20ms フレーム列に事前分解し、N 並列で 20ms 間隔リプレイ →
// prism.opus.Decoder（実受信と同一構成）→ Mixer.pushUser。「常時全員発話し続ける」最悪ケースを模す。
// タイマは PoC-2 と同じ「経過時間から出すべきフレーム数を算出」方式（タイマ遅延で負荷が薄まるのを防ぐ）。

// Ogg Opus をデマックスして 20ms Opus パケット列（Buffer[]）をメモリに読み込む。
export function loadOpusFrames(path) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const demux = new prism.opus.OggDemuxer();
    fs.createReadStream(path).pipe(demux);
    demux.on('data', (packet) => frames.push(packet));
    demux.on('end', () => resolve(frames));
    demux.on('error', reject);
  });
}

export class LoadGen {
  // frames: loadOpusFrames の結果 / n: 同時発話ユーザー数 / mixer: pushUser 先
  constructor({ frames, n, mixer, frameMs = 20 }) {
    this.frames = frames;
    this.n = n;
    this.mixer = mixer;
    this.frameMs = frameMs;
    this.users = [];
    this.timer = null;
    this.t0 = null;
    this.framesSent = 0;
    for (let i = 0; i < n; i++) {
      const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
      const userId = `load-${i}`;
      decoder.on('data', (pcm) => mixer.pushUser(userId, pcm));
      decoder.on('error', () => {}); // フレーム末尾の端数などは無視
      // 開始オフセットをずらす（全員が同じ位置を再生しないように）
      this.users.push({ userId, decoder, idx: Math.floor((i / Math.max(n, 1)) * frames.length) });
    }
  }

  start() {
    if (this.frames.length === 0) throw new Error('no opus frames loaded');
    this.t0 = Date.now();
    this.timer = setInterval(() => {
      const due = Math.floor((Date.now() - this.t0) / this.frameMs);
      while (this.framesSent < due) {
        for (const u of this.users) {
          u.decoder.write(this.frames[u.idx]);
          u.idx = (u.idx + 1) % this.frames.length; // ループ
        }
        this.framesSent++;
      }
    }, this.frameMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const u of this.users) { try { u.decoder.end(); } catch {} }
  }
}
