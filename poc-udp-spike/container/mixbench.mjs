import fs from 'node:fs';
import { Mixer } from './mixer.mjs';

// PoC-2 §5.4: 実 VC を使わず、合成した不連続 PCM をミキサへ注入してミキサ単体の設計を潰す
// ローカル検証ハーネス。合格条件: clockDriftMs 非発散(±20ms オーダー) / underruns=0 /
// 出力 PCM を試聴してバースト境界にクリック・欠落がないこと。
//
//   node mixbench.mjs [durationSec] [outPath]

const durationSec = Number(process.argv[2] || 600);
const outPath = process.argv[3] || '/tmp/mixbench.pcm';

const SR = 48000, CH = 2, FRAME_MS = 20;
const SAMP = Math.round(SR * FRAME_MS / 1000);     // 960
const CHUNK_BYTES = SAMP * CH * 2;                  // 3840 = 20ms 分

// user ごとに「発話2〜5秒 / 無音3〜10秒」をランダムに繰り返し、発話中は 20ms 刻みで正弦波を push
const users = [
  { id: 'u1', freq: 220, phase: 0, speaking: false, until: 0 },
  { id: 'u2', freq: 440, phase: 0, speaking: false, until: 0 },
  { id: 'u3', freq: 660, phase: 0, speaking: false, until: 0 },
];
const rand = (a, b) => a + Math.random() * (b - a);

function makeChunk(u) {
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  for (let s = 0; s < SAMP; s++) {
    const v = Math.round(Math.sin(u.phase) * 8000); // 控えめ振幅（加算クリップを避ける）
    u.phase += (2 * Math.PI * u.freq) / SR;
    buf.writeInt16LE(v, (s * CH) * 2);
    buf.writeInt16LE(v, (s * CH + 1) * 2);
  }
  return buf;
}

const out = fs.createWriteStream(outPath);
const mixer = new Mixer({ sampleRate: SR, channels: CH, frameMs: FRAME_MS, jitterMs: 60, onFrame: (f) => out.write(f) });
mixer.start();

// 注入タイマ（受信到着を模す。ミキサの出力ペースとは独立）
const inject = setInterval(() => {
  const now = Date.now();
  for (const u of users) {
    if (now >= u.until) { // 状態遷移
      u.speaking = !u.speaking;
      u.until = now + (u.speaking ? rand(2000, 5000) : rand(3000, 10000));
    }
    if (u.speaking) mixer.pushUser(u.id, makeChunk(u));
  }
}, FRAME_MS);

const t0 = Date.now();
const mon = setInterval(() => {
  const s = mixer.stats();
  console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, JSON.stringify(s));
}, 10000);

setTimeout(() => {
  clearInterval(inject); clearInterval(mon); mixer.stop(); out.end();
  const s = mixer.stats();
  const elapsedMs = Date.now() - t0;
  const expectedFrames = Math.floor(elapsedMs / FRAME_MS);
  const driftOk = Math.abs(s.clockDriftMsMax) <= 60;         // ±3 フレーム以内で振動（発散していない）
  const underrunOk = s.underruns === 0;
  const framesOk = Math.abs(s.framesOut - expectedFrames) <= 2;
  console.log('=== mixbench result ===');
  console.log(JSON.stringify({ durationSec, ...s, expectedFrames, elapsedMs, outPath }, null, 2));
  console.log(`driftOk(±60ms)=${driftOk} underrunOk=${underrunOk} framesOk=${framesOk}`);
  const pass = driftOk && underrunOk && framesOk;
  console.log(pass ? 'PASS' : 'FAIL');
  process.exit(pass ? 0 : 1);
}, durationSec * 1000);
