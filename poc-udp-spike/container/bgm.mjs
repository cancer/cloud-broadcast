import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { createAudioPlayer, createAudioResource, StreamType, NoSubscriberBehavior, AudioPlayerStatus } from '@discordjs/voice';

// PoC-2 BGM (§5.3): opus ファイルを 48kHz/stereo/s16le PCM に一度だけデコードしてメモリ保持。
// 同じバッファを (a) ミキサへの pull と (b) AudioPlayer での VC 送出の両方に使う（二重デコードしない）。

// ffmpeg で opus ファイルを raw PCM(s16le/48k/stereo) にデコードして Buffer で返す。
export function decodeToPcm(path) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-loglevel', 'error', '-i', path,
      '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => process.stderr.write(c));
    proc.on('error', reject);
    proc.on('close', (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg decode exit ${code}`)));
  });
}

export class Bgm {
  constructor(pcm, { frameBytes = 3840 } = {}) {
    this.pcm = pcm;              // 連続 48k/stereo/s16le PCM
    this.frameBytes = frameBytes;
    this.offset = 0;
    this.player = null;
  }

  static async load(path, opts) { return new Bgm(await decodeToPcm(path), opts); }

  // ミキサ用 pull: samplesPerChannel 分（= frameBytes）を返す。末尾を跨いだらループ。
  pull(samplesPerChannel) {
    const need = samplesPerChannel * 2 /*ch*/ * 2 /*byte*/;
    if (this.pcm.length === 0) return Buffer.alloc(need);
    const out = Buffer.allocUnsafe(need);
    let written = 0;
    while (written < need) {
      const chunk = Math.min(need - written, this.pcm.length - this.offset);
      this.pcm.copy(out, written, this.offset, this.offset + chunk);
      written += chunk;
      this.offset += chunk;
      if (this.offset >= this.pcm.length) this.offset = 0; // ループ
    }
    return out;
  }

  // PCM Buffer を「1 チャンク → EOF」の binary Readable にする。
  // 注意: Readable.from(buffer) は objectMode になりバイト単位（数値）で流れて壊れる。
  // StreamType.Raw は s16le/48k/stereo の連続バイト列を期待するので明示的に binary で push する。
  _pcmStream() {
    const s = new Readable({ read() {} }); // objectMode: false（binary）
    s.push(this.pcm);
    s.push(null);
    return s;
  }

  // VC 送出: 同一 PCM バッファから raw リソースを作り、idle でループ再生成。
  attachPlayer(connection) {
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    const playOnce = () => {
      const resource = createAudioResource(this._pcmStream(), { inputType: StreamType.Raw });
      this.player.play(resource);
    };
    this.player.on(AudioPlayerStatus.Idle, () => playOnce()); // ループ
    this.player.on('error', (e) => console.error('bgm player error', e.message));
    connection.subscribe(this.player);
    playOnce();
    return this.player;
  }

  stop() { try { this.player?.stop(true); } catch {} }
}
