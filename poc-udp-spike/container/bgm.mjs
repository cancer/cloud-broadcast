import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { createAudioPlayer, createAudioResource, StreamType, NoSubscriberBehavior, AudioPlayerStatus } from '@discordjs/voice';

// PoC-2 BGM (§5.3): opus ファイルを 48kHz/stereo/s16le PCM に一度だけデコードしてメモリ保持。
// 同じバッファを (a) ミキサへの pull と (b) AudioPlayer での VC 送出の両方に使う（二重デコードしない）。

const S16_MAX = 32767;
const S16_MIN = -32768;

// s16le バッファの各サンプルに gain を掛けて飽和させる（in-place）。
function applyVolumeInPlace(buf, gain) {
  for (let i = 0; i < buf.length; i += 2) {
    let s = Math.round(buf.readInt16LE(i) * gain);
    if (s > S16_MAX) s = S16_MAX;
    else if (s < S16_MIN) s = S16_MIN;
    buf.writeInt16LE(s, i);
  }
}

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
    this.resource = null;        // inlineVolume 時の現行 AudioResource（音量再適用のため保持）
    this.volume = 1;             // BGM の現行音量。VC 送出（inlineVolume）とミックス pull の両経路に効かせる
  }

  static async load(path, opts) { return new Bgm(await decodeToPcm(path), opts); }

  // ミキサ用 pull: samplesPerChannel 分（= frameBytes）を返す。末尾を跨いだらループ。
  // RTMP 出力経路は VC 用 AudioResource を通らないので、BGM 音量はここで直接 PCM に適用する
  // （volume=1 のときは無加工＝既存挙動そのまま）。
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
    if (this.volume !== 1) applyVolumeInPlace(out, this.volume);
    return out;
  }

  // BGM 音量を再生中に変更する。VC 送出は inlineVolume の VolumeTransformer（resource.volume）で、
  // ミックス出力は pull 内スケールで、同一の音量に追随する。
  setVolume(volume) {
    this.volume = volume;
    this.resource?.volume?.setVolume?.(volume);
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
  // inlineVolume=true で AudioResource に prism VolumeTransformer が挿さり、再生中に音量を変えられる
  // （その分 CPU コストが増える。PoC-2 の検証対象）。ループ再生成のたびに現行音量を再適用する。
  // connection 省略時は subscribe しない（NoSubscriberBehavior.Play によりプレイヤーは消費を続けるため、
  // VC 無しでも inlineVolume の CPU コストを計測できる）。
  attachPlayer(connection, { inlineVolume = true } = {}) {
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    const playOnce = () => {
      this.resource = createAudioResource(this._pcmStream(), { inputType: StreamType.Raw, inlineVolume });
      this.resource.volume?.setVolume(this.volume); // 現行音量を（inlineVolume 時のみ）再適用
      this.player.play(this.resource);
    };
    this.player.on(AudioPlayerStatus.Idle, () => playOnce()); // ループ
    this.player.on('error', (e) => console.error('bgm player error', e.message));
    connection?.subscribe(this.player);
    playOnce();
    return this.player;
  }

  // 曲を先頭から差し替える（instance-sizing PoC の BGM 切替）。ミキサへの pull は次フレームから
  // 新曲になる。VC 側は stop(true) → Idle → attachPlayer 内 playOnce の経路で新 PCM に切り替わる。
  swap(pcm) {
    this.pcm = pcm;
    this.offset = 0;
    try { this.player?.stop(true); } catch {}
  }

  stop() { try { this.player?.stop(true); } catch {} }
}
