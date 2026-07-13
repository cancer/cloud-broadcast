import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import { URL } from 'node:url';
import { discordVoiceProbe } from './voicetest.mjs';
import { joinForReceive, joinForPlay, subscribeAll } from './receive.mjs';
import { startFfmpeg, writePcm } from './rtmpout.mjs';
import { Mixer } from './mixer.mjs';
import { Bgm, decodeToPcm } from './bgm.mjs';
import { LoadGen, loadOpusFrames } from './loadgen.mjs';
import { Metrics } from './metrics.mjs';

// 既定は Google STUN。DNS を排除して transport だけ見たい時は IP を渡す（PoC-0）
const DEFAULT_STUN_HOST = process.env.STUN_HOST || 'stun.l.google.com';
const DEFAULT_STUN_PORT = Number(process.env.STUN_PORT || 19302);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 5000);

const DISCORD = () => ({
  token: process.env.DISCORD_BOT_TOKEN,
  guildId: process.env.DISCORD_GUILD_ID,
  channelId: process.env.DISCORD_CHANNEL_ID,
});
const STREAM_KEY = () => process.env.YOUTUBE_STREAM_KEY;
const VCPUS = Number(process.env.VCPUS || 1);
const INSTANCE_TYPE = process.env.INSTANCE_TYPE || 'unknown';

const FRAME_BYTES = 3840; // 20ms = 960 sample × 2ch × 2byte（48kHz/stereo/s16le）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// STUN Binding Request（20バイトヘッダのみ）
function buildStunBindingRequest() {
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(0x0001, 0);
  buf.writeUInt16BE(0x0000, 2);
  buf.writeUInt32BE(0x2112a442, 4);
  for (let i = 8; i < 20; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}
function stunProbe(host, port) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const started = Date.now();
    const done = (r) => { try { sock.close(); } catch {} resolve({ ...r, elapsedMs: Date.now() - started }); };
    const timer = setTimeout(() => done({ ok: false, reason: 'timeout' }), TIMEOUT_MS);
    sock.on('message', (msg) => {
      clearTimeout(timer);
      const type = msg.readUInt16BE(0);
      done({ ok: type === 0x0101, reason: type === 0x0101 ? 'binding-success' : `unexpected-type-0x${type.toString(16)}` });
    });
    sock.on('error', (err) => { clearTimeout(timer); done({ ok: false, reason: `socket-error: ${err.message}` }); });
    sock.send(buildStunBindingRequest(), port, host, (err) => {
      if (err) { clearTimeout(timer); done({ ok: false, reason: `send-error: ${err.message}` }); }
    });
  });
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ── H1a: /receivetest?durationSec=60 ─────────────────────────────────────────
async function receivetest(res, durationSec) {
  const cfg = DISCORD();
  if (!cfg.token || !cfg.guildId || !cfg.channelId) return json(res, 200, { ok: false, reason: 'missing-config' });
  const stats = { speakingStarts: 0, bytesByUser: {}, reconnects: 0, decodeErrors: 0 };
  let client, connection;
  try {
    ({ client, connection } = await joinForReceive(cfg));
    subscribeAll(connection, () => {}, stats);
    await sleep(durationSec * 1000);
    const totalBytes = Object.values(stats.bytesByUser).reduce((a, b) => a + b, 0);
    json(res, 200, { ok: totalBytes > 0, durationSec, totalBytes, ...stats });
  } catch (err) {
    json(res, 200, { ok: false, reason: `error: ${err.message}`, ...stats });
  } finally {
    try { connection?.destroy(); } catch {}
    await client?.destroy().catch(() => {});
  }
}

// ── H1a（人の発話なし）: /recvselftest?durationSec=60 ─────────────────────────
// プレイヤー Bot（2 体目トークン DISCORD_BOT_TOKEN_2）が音源を再生し、受信 Bot がそれを購読して
// デコード PCM > 0 を計測する。CF の戻り UDP で「他参加者の音声」を持続受信できるか（H1a の核心）を
// 人の発話なしで反復測定する。合格条件は spec §1 の「PCM > 0」。
async function recvselftest(res, durationSec) {
  const cfg = DISCORD();
  const token2 = process.env.DISCORD_BOT_TOKEN_2;
  if (!cfg.token || !cfg.guildId || !cfg.channelId) return json(res, 200, { ok: false, reason: 'missing-config' });
  if (!token2) return json(res, 200, { ok: false, reason: 'missing-DISCORD_BOT_TOKEN_2 (2体目のBotトークン)' });
  const stats = { speakingStarts: 0, bytesByUser: {}, reconnects: 0, decodeErrors: 0 };
  let player, receiver, bgm;
  const joinReqAt = Date.now();
  let firstPcmAt = null;
  try {
    // 1) プレイヤー Bot を先に join させて音源ループ再生
    player = await joinForPlay({ token: token2, guildId: cfg.guildId, channelId: cfg.channelId });
    bgm = await Bgm.load('/app/assets/sample.opus', { frameBytes: FRAME_BYTES });
    bgm.attachPlayer(player.connection);
    // 2) 受信 Bot が join して購読
    receiver = await joinForReceive(cfg);
    subscribeAll(receiver.connection, () => { if (firstPcmAt === null) firstPcmAt = Date.now(); }, stats);
    await sleep(durationSec * 1000);
    const totalBytes = Object.values(stats.bytesByUser).reduce((a, b) => a + b, 0);
    json(res, 200, {
      ok: totalBytes > 0, durationSec, totalBytes, ...stats,
      playerUserId: player.userId,
      receivedFromPlayer: (stats.bytesByUser[player.userId] ?? 0),
      firstPcmMs: firstPcmAt ? firstPcmAt - joinReqAt : null,
    });
  } catch (err) {
    json(res, 200, { ok: false, reason: `error: ${err.message}`, ...stats });
  } finally {
    try { bgm?.stop(); } catch {}
    try { player?.connection?.destroy(); } catch {}
    try { await player?.client?.destroy(); } catch {}
    try { receiver?.connection?.destroy(); } catch {}
    try { await receiver?.client?.destroy(); } catch {}
  }
}

// ── 送受信同時（§2.2 の核心）: /dualtest?durationSec=60 ────────────────────────
// 1 体の Bot が同一接続で BGM を VC へ送出(selfMute:false)しつつ、参加者の音声を受信する。
// 併せて H2c（自分の送出 BGM が自分の受信に混入しないか）も測る:
//   - あなたが無言の区間 → 受信バイトが増えなければ「自 BGM は受信に現れない」(§2.2 前提OK)
//   - あなたが発話した区間 → 受信バイトが増える（他者音声は受信できる）
async function dualtest(res, durationSec) {
  const cfg = DISCORD();
  if (!cfg.token || !cfg.guildId || !cfg.channelId) return json(res, 200, { ok: false, reason: 'missing-config' });
  const stats = { speakingStarts: 0, bytesByUser: {}, reconnects: 0, decodeErrors: 0 };
  let client, connection, bgm, stageSpeaker = false;
  let playerState = 'none';
  try {
    ({ client, connection, stageSpeaker } = await joinForReceive({ ...cfg, selfMute: false })); // full-duplex
    bgm = await Bgm.load('/app/assets/bgm.opus', { frameBytes: FRAME_BYTES });
    const player = bgm.attachPlayer(connection);           // 送出: BGM を VC へ
    player.on('stateChange', (_o, n) => { playerState = n.status; });
    subscribeAll(connection, () => {}, stats);             // 受信: 参加者音声
    // 10 秒ごとに受信バイトのスナップショットを取り、無言/発話区間を後から見分けられるようにする
    const snapshots = [];
    const snap = setInterval(() => {
      const total = Object.values(stats.bytesByUser).reduce((a, b) => a + b, 0);
      snapshots.push({ t: snapshots.length * 10, totalBytes: total, playerState });
    }, 10000);
    await sleep(durationSec * 1000);
    clearInterval(snap);
    const selfId = client.user.id;
    const totalBytes = Object.values(stats.bytesByUser).reduce((a, b) => a + b, 0);
    json(res, 200, {
      ok: true, durationSec, selfBotUserId: selfId,
      stageSpeaker, // Stage で speaker 昇格したか（VC は false=該当なし）
      sentBgm: playerState, // 'playing' なら送出できている
      totalBytesReceived: totalBytes,
      selfBytesReceived: stats.bytesByUser[selfId] ?? 0, // 自分のIDで受信したバイト（0 であるべき=BGM非混入）
      ...stats, snapshots,
    });
  } catch (err) {
    json(res, 200, { ok: false, reason: `error: ${err.message}`, ...stats });
  } finally {
    try { bgm?.stop(); } catch {}
    try { connection?.destroy(); } catch {}
    await client?.destroy().catch(() => {});
  }
}

// ── H1b: /streamtest?durationSec=60（静止画+無音でRTMPS送出）──────────────────
async function streamtest(res, durationSec) {
  const streamKey = STREAM_KEY();
  if (!streamKey) return json(res, 200, { ok: false, reason: 'missing-YOUTUBE_STREAM_KEY' });
  let proc;
  try {
    proc = startFfmpeg({ streamKey, silent: true });
    let exited = null;
    proc.on('close', (code) => { exited = code; });
    await sleep(durationSec * 1000);
    const stillRunning = exited === null;
    try { proc.kill('SIGINT'); } catch {}
    json(res, 200, { ok: stillRunning, durationSec, ffmpegExitedEarly: exited, progress: proc.progress });
  } catch (err) {
    json(res, 200, { ok: false, reason: `error: ${err.message}` });
  }
}

// ── H1c: /pipetest?durationSec=1800（受信PCM→FIFO→FFmpeg。暫定パイプ §5.3）─────
async function pipetest(res, durationSec) {
  const cfg = DISCORD();
  const streamKey = STREAM_KEY();
  if (!cfg.token || !streamKey) return json(res, 200, { ok: false, reason: 'missing-config-or-streamKey' });
  const stats = { speakingStarts: 0, bytesByUser: {}, reconnects: 0, decodeErrors: 0 };
  let client, connection, proc, pacer;
  const joinReqAt = Date.now();
  let firstWriteAt = null, framesWritten = 0, silenceFrames = 0, underruns = 0;
  let fifo = Buffer.alloc(0);
  const silence = Buffer.alloc(FRAME_BYTES);
  try {
    ({ client, connection } = await joinForReceive(cfg));
    subscribeAll(connection, (_uid, pcm) => { fifo = Buffer.concat([fifo, pcm]); }, stats);
    proc = startFfmpeg({ streamKey, silent: false });
    proc.on('close', (c) => console.log('pipetest ffmpeg close', c));
    // 20ms 実時間ペースで 3840B（無ければ無音）を書く（ドリフト補正は PoC-2）
    pacer = setInterval(() => {
      let frame;
      if (fifo.length >= FRAME_BYTES) { frame = fifo.subarray(0, FRAME_BYTES); fifo = fifo.subarray(FRAME_BYTES); }
      else { frame = silence; silenceFrames++; }
      if (firstWriteAt === null) firstWriteAt = Date.now();
      if (!writePcm(proc, frame, () => underruns++)) {} // 背圧は underruns で集計
      framesWritten++;
    }, 20);
    await sleep(durationSec * 1000);
    const totalBytes = Object.values(stats.bytesByUser).reduce((a, b) => a + b, 0);
    json(res, 200, {
      ok: true, durationSec, totalBytes, ...stats,
      provisioningMs: firstWriteAt ? firstWriteAt - joinReqAt : null,
      framesWritten, silenceFrames, underruns, progress: proc.progress,
    });
  } catch (err) {
    json(res, 200, { ok: false, reason: `error: ${err.message}`, ...stats });
  } finally {
    if (pacer) clearInterval(pacer);
    try { proc?.stdin.end(); } catch {}
    try { proc?.kill('SIGINT'); } catch {}
    try { connection?.destroy(); } catch {}
    await client?.destroy().catch(() => {});
  }
}

// ── H2: /mixtest?durationSec=1800&bgmGain=0.3[&player=1]（BGM+ミックス連続性）────
// player=1: プレイヤー Bot(token2)が sample.opus を再生し「会話」を注入（H2a/b・H1c を人なしで）。
// player 無し: BGM 単独＝H2c（受信バイト 0 の裏取り）。
async function mixtest(res, durationSec, bgmGain, withPlayer) {
  const cfg = DISCORD();
  const streamKey = STREAM_KEY();
  const token2 = process.env.DISCORD_BOT_TOKEN_2;
  if (!cfg.token || !streamKey) return json(res, 200, { ok: false, reason: 'missing-config-or-streamKey' });
  if (withPlayer && !token2) return json(res, 200, { ok: false, reason: 'missing-DISCORD_BOT_TOKEN_2 (player=1 requires it)' });
  const stats = { speakingStarts: 0, bytesByUser: {}, reconnects: 0, decodeErrors: 0 };
  let client, connection, proc, mixer, bgm, player, playerBgm;
  const joinReqAt = Date.now();
  let firstFrameAt = null;
  try {
    if (withPlayer) {
      player = await joinForPlay({ token: token2, guildId: cfg.guildId, channelId: cfg.channelId });
      playerBgm = await Bgm.load('/app/assets/sample.opus', { frameBytes: FRAME_BYTES });
      playerBgm.attachPlayer(player.connection); // 「会話」相当の音源を VC に流す
    }
    ({ client, connection } = await joinForReceive({ ...cfg, selfMute: false })); // full-duplex: BGM を VC へ送る(§2.2)
    proc = startFfmpeg({ streamKey, silent: false });
    mixer = new Mixer({
      jitterMs: 60,
      onFrame: (frame) => {
        if (firstFrameAt === null) firstFrameAt = Date.now();
        return writePcm(proc, frame); // false → mixer が underruns 計上
      },
    });
    bgm = await Bgm.load('/app/assets/bgm.opus', { frameBytes: FRAME_BYTES });
    bgm.attachPlayer(connection);           // (a) VC へ送出
    mixer.setBgm((n) => bgm.pull(n), bgmGain); // (b) 手元 PCM をミックスへ
    subscribeAll(connection, (uid, pcm) => mixer.pushUser(uid, pcm), stats);
    mixer.start();
    await sleep(durationSec * 1000);
    const totalBytes = Object.values(stats.bytesByUser).reduce((a, b) => a + b, 0);
    json(res, 200, {
      ok: true, durationSec, bgmGain, withPlayer: !!withPlayer, playerUserId: player?.userId ?? null,
      totalBytesReceived: totalBytes, ...stats,
      provisioningMs: firstFrameAt ? firstFrameAt - joinReqAt : null,
      mixer: mixer.stats(), progress: proc.progress,
    });
  } catch (err) {
    json(res, 200, { ok: false, reason: `error: ${err.message}`, mixer: mixer?.stats(), ...stats });
  } finally {
    try { mixer?.stop(); } catch {}
    try { bgm?.stop(); } catch {}
    try { playerBgm?.stop(); } catch {}
    try { proc?.stdin.end(); } catch {}
    try { proc?.kill('SIGINT'); } catch {}
    try { connection?.destroy(); } catch {}
    await client?.destroy().catch(() => {});
    try { player?.connection?.destroy(); } catch {}
    try { await player?.client?.destroy(); } catch {}
  }
}

// ── instance-sizing PoC: /sysinfo（インスタンススペックの実測確認）──────────────
// rollout 後に新 instance_type が実際に反映されたかを、コンテナ内から見える CPU 数・
// メモリ総量・cgroup 上限で確認する（wrangler の設定値ではなく実機値で判定する）。
function readTrim(path) {
  try { return fs.readFileSync(path, 'utf8').trim(); } catch { return null; }
}
function sysinfo() {
  const memTotalKb = Number(readTrim('/proc/meminfo')?.match(/MemTotal:\s+(\d+) kB/)?.[1] ?? 0);
  return {
    instanceType: INSTANCE_TYPE, vcpusVar: VCPUS,
    cpus: os.cpus().length,
    memTotalMiB: Math.round(memTotalKb / 1024),
    cgroupMemMax: readTrim('/sys/fs/cgroup/memory.max'),
    cgroupCpuMax: readTrim('/sys/fs/cgroup/cpu.max'),
  };
}

// ── instance-sizing PoC 1+2: /sizetest?durationSec=1800&player=1&prefetch=20&trackSec=240&switchEverySec=600 ──
// フルワークロード（Discord 接続 + BGM 再生（VC 送出 + ミックス） + 1080p エンコード + RTMPS 送出）に
// CPU/RSS 計測（PoC 1: 実時間維持）とプリフェッチ相当のメモリ保持 + BGM 切替（PoC 2: OOM なし）を加える。
// R2 が未有効化のため、プリフェッチは「デコード済み PCM を曲数分メモリ保持」で代替する。製品想定
// （エンコード済みファイル保持）よりメモリを多く使う worst case なので、これが収まれば十分条件になる。
let lastResult = null; // 30 分の in-flight 応答が失われた場合に /lastresult で回収する
// player=1 はプレイヤー Bot（要: 対象 guild への招待）。Bot が guild に居ない環境では loadgen=N で
// 代替する（実受信と同一の prism Opus デコード経路で N 話者ぶんの PCM を mixer に注入する）。
async function sizetest(res, { durationSec, bgmGain, withPlayer, prefetch, trackSec, switchEverySec, loadgenN, fps }) {
  const cfg = DISCORD();
  const streamKey = STREAM_KEY();
  const token2 = process.env.DISCORD_BOT_TOKEN_2;
  if (!cfg.token || !streamKey) return json(res, 200, { ok: false, reason: 'missing-config-or-streamKey' });
  if (withPlayer && !token2) return json(res, 200, { ok: false, reason: 'missing-DISCORD_BOT_TOKEN_2' });
  const stats = { speakingStarts: 0, bytesByUser: {}, reconnects: 0, decodeErrors: 0 };
  let client, connection, proc, mixer, bgm, player, playerBgm, metrics, progressPoll, switchTimer, gen;
  let speedMin = Infinity, dropFramesMax = 0, switches = 0;
  const t0 = Date.now();
  try {
    metrics = new Metrics({ vcpus: VCPUS, ffmpegPidFn: () => proc?.pid });
    metrics.start(); // プリフェッチ・起動ピークも計測に含める（PoC 2 の「起動時ピーク」）

    // プリフェッチ: 1 曲 trackSec 秒ぶんの PCM バッファを prefetch 曲分メモリに保持する。
    // 曲データはバンドル済み bgm.opus のデコード結果をタイルして曲長まで伸ばす（実データで埋め、
    // RSS に確実に計上させる）。
    const base = await decodeToPcm('/app/assets/bgm.opus');
    const bytesPerTrack = 48000 * 2 * 2 * trackSec; // 48kHz/stereo/s16le
    const tracks = Array.from({ length: prefetch }, () => {
      const buf = Buffer.allocUnsafe(bytesPerTrack);
      for (let off = 0; off < bytesPerTrack; off += base.length) {
        base.copy(buf, off, 0, Math.min(base.length, bytesPerTrack - off));
      }
      return buf;
    });
    const prefetchMs = Date.now() - t0;

    if (withPlayer) {
      player = await joinForPlay({ token: token2, guildId: cfg.guildId, channelId: cfg.channelId });
      playerBgm = await Bgm.load('/app/assets/sample.opus', { frameBytes: FRAME_BYTES });
      playerBgm.attachPlayer(player.connection); // 「会話」相当の音源を注入
    }
    let stageSpeaker = false;
    ({ client, connection, stageSpeaker } = await joinForReceive({ ...cfg, selfMute: false })); // full-duplex
    proc = startFfmpeg({ streamKey, silent: false, fps });
    mixer = new Mixer({ jitterMs: 60, onFrame: (frame) => writePcm(proc, frame) });
    bgm = new Bgm(tracks[0], { frameBytes: FRAME_BYTES });
    bgm.attachPlayer(connection);              // (a) VC へ送出
    mixer.setBgm((n) => bgm.pull(n), bgmGain); // (b) ミックスへ
    subscribeAll(connection, (uid, pcm) => mixer.pushUser(uid, pcm), stats);
    mixer.start();
    if (loadgenN > 0) {
      const frames = await loadOpusFrames('/app/assets/sample.opus');
      gen = new LoadGen({ frames, n: loadgenN, mixer });
      gen.start();
    }
    // BGM 切替（新曲を先頭から）。切替時にフェッチは発生しない（全曲プリフェッチ済み）
    switchTimer = setInterval(() => { switches++; bgm.swap(tracks[switches % tracks.length]); }, switchEverySec * 1000);
    progressPoll = setInterval(() => {
      const sp = parseFloat(proc.progress.speed); // "1.02x" → 1.02
      if (!Number.isNaN(sp)) speedMin = Math.min(speedMin, sp);
      if (proc.progress.drop_frames != null) dropFramesMax = Math.max(dropFramesMax, proc.progress.drop_frames);
    }, 1000);
    await sleep(durationSec * 1000);
    const m = metrics.summary();
    const result = {
      ok: true, durationSec, sysinfo: sysinfo(),
      prefetch: { tracks: prefetch, trackSec, totalMiB: Math.round(prefetch * bytesPerTrack / (1024 * 1024)), prefetchMs },
      stageSpeaker, switches, withPlayer: !!withPlayer, loadgenN, bgmGain, fps,
      cpu: m.cpu, rssMaxMiB: m.rssMaxMiB,
      mixer: mixer.stats(),
      ffmpeg: { dropFrames: dropFramesMax, speedMin: speedMin === Infinity ? null : `${speedMin}x` },
      discord: stats,
    };
    lastResult = result;
    console.log('sizetest result', JSON.stringify(result));
    json(res, 200, result);
  } catch (err) {
    const m = metrics?.summary();
    const failed = { ok: false, reason: `error: ${err.message}`, cpu: m?.cpu, rssMaxMiB: m?.rssMaxMiB, mixer: mixer?.stats(), ...stats };
    lastResult = failed;
    console.log('sizetest failed', JSON.stringify(failed));
    json(res, 200, failed);
  } finally {
    if (switchTimer) clearInterval(switchTimer);
    if (progressPoll) clearInterval(progressPoll);
    try { gen?.stop(); } catch {}
    try { metrics?.stop(); } catch {}
    try { mixer?.stop(); } catch {}
    try { bgm?.stop(); } catch {}
    try { playerBgm?.stop(); } catch {}
    try { proc?.stdin.end(); } catch {}
    try { proc?.kill('SIGINT'); } catch {}
    try { connection?.destroy(); } catch {}
    await client?.destroy().catch(() => {});
    try { player?.connection?.destroy(); } catch {}
    try { await player?.client?.destroy(); } catch {}
  }
}

// ── H3: /loadtest?n=N&durationSec=600[&sink=null]（合成負荷）───────────────────
// sink=null: YouTube キー無しで encode CPU 負荷だけを測る（RTMPS 送出は encode に比べ微小）。
async function loadtest(res, n, durationSec, nullSink) {
  const streamKey = STREAM_KEY();
  if (!nullSink && !streamKey) return json(res, 200, { ok: false, reason: 'missing-YOUTUBE_STREAM_KEY (or pass sink=null)' });
  let proc, mixer, bgm, gen, metrics, progressPoll;
  let speedMin = Infinity, dropFramesMax = 0;
  try {
    proc = startFfmpeg({ streamKey, silent: false, nullSink });
    mixer = new Mixer({ jitterMs: 60, onFrame: (frame) => writePcm(proc, frame) });
    bgm = await Bgm.load('/app/assets/bgm.opus', { frameBytes: FRAME_BYTES });
    mixer.setBgm((s) => bgm.pull(s), 0.3);
    const frames = await loadOpusFrames('/app/assets/sample.opus');
    gen = new LoadGen({ frames, n, mixer });
    metrics = new Metrics({ vcpus: VCPUS, ffmpegPidFn: () => proc?.pid });
    mixer.start(); gen.start(); metrics.start();
    progressPoll = setInterval(() => {
      const sp = parseFloat(proc.progress.speed); // "1.02x" → 1.02
      if (!Number.isNaN(sp)) speedMin = Math.min(speedMin, sp);
      if (proc.progress.drop_frames != null) dropFramesMax = Math.max(dropFramesMax, proc.progress.drop_frames);
    }, 1000);
    await sleep(durationSec * 1000);
    const m = metrics.summary();
    const mx = mixer.stats();
    json(res, 200, {
      n, durationSec, sink: nullSink ? 'null' : 'rtmps', instanceType: INSTANCE_TYPE, vcpus: VCPUS,
      cpu: m.cpu, rssMaxMiB: m.rssMaxMiB,
      mixer: { underruns: mx.underruns, gapFrames: mx.gapFrames, clockDriftMsMax: mx.clockDriftMsMax, peakClip: mx.peakClip },
      ffmpeg: { dropFrames: dropFramesMax, speedMin: speedMin === Infinity ? null : `${speedMin}x` },
      opusFramesLoaded: frames.length,
    });
  } catch (err) {
    json(res, 200, { ok: false, reason: `error: ${err.message}` });
  } finally {
    if (progressPoll) clearInterval(progressPoll);
    try { gen?.stop(); } catch {}
    try { mixer?.stop(); } catch {}
    try { proc?.stdin.end(); } catch {}
    try { proc?.kill('SIGINT'); } catch {}
  }
}

// ── PoC-2 音量: /voltest?durationSec=60&gains=0.2,0.6,1.0&vol=on|off&sink=null ──
// inlineVolume で BGM 音量を再生中に可変にできるか + その CPU コストを実測する。
// - BGM を AudioPlayer で再生（inlineVolume=on/off）。VC 接続は張らない（NoSubscriberBehavior.Play
//   でプレイヤーは消費を続けるため、VC 無しでも VolumeTransformer の CPU コストが計上される）。
// - durationSec を gains 個の区間に等分し、区間ごとに bgm.setVolume(gain) を適用。
// - ミックス出力（onFrame）の区間別 RMS を集計し、音量が数値的に追随した証拠を返す。
//   RTMP 出力経路は AudioResource を通らないので、音量は bgm.pull 内で PCM に適用される（bgm.mjs）。
// - vol=on/off の CPU 差分が VolumeTransformer のコスト。判定閾値は指揮者側（辻褄合わせしない）。
async function voltest(res, { durationSec, gains, inlineVolume, nullSink }) {
  const streamKey = STREAM_KEY();
  if (!nullSink && !streamKey) return json(res, 200, { ok: false, reason: 'missing-YOUTUBE_STREAM_KEY (or pass sink=null)' });
  let proc, mixer, bgm, metrics, volTimer, progressPoll;
  const segMs = Math.floor((durationSec * 1000) / gains.length);
  const seg = gains.map(() => ({ sumSq: 0, samples: 0 }));
  let startAt = null;
  let speedMin = Infinity, dropFramesMax = 0;
  try {
    proc = startFfmpeg({ streamKey, silent: false, nullSink });
    mixer = new Mixer({
      jitterMs: 60,
      onFrame: (frame) => {
        if (startAt === null) startAt = Date.now();
        const idx = Math.min(gains.length - 1, Math.floor((Date.now() - startAt) / segMs));
        const bucket = seg[idx];
        for (let i = 0; i < frame.length; i += 2) { const v = frame.readInt16LE(i); bucket.sumSq += v * v; bucket.samples++; }
        return writePcm(proc, frame);
      },
    });
    bgm = await Bgm.load('/app/assets/bgm.opus', { frameBytes: FRAME_BYTES });
    bgm.setVolume(gains[0]);
    bgm.attachPlayer(null, { inlineVolume }); // VC 無しで inlineVolume の CPU を計測
    mixer.setBgm((n) => bgm.pull(n), 1.0);    // base gain=1.0。音量変化は bgm.volume 側で起こす
    metrics = new Metrics({ vcpus: VCPUS, ffmpegPidFn: () => proc?.pid });
    mixer.start(); metrics.start();
    // gains を時間分割して順次適用（RMS 集計は onFrame 側が経過時間で区間分けする）
    let gi = 0;
    volTimer = setInterval(() => { gi++; if (gi < gains.length) bgm.setVolume(gains[gi]); }, segMs);
    progressPoll = setInterval(() => {
      const sp = parseFloat(proc.progress.speed);
      if (!Number.isNaN(sp)) speedMin = Math.min(speedMin, sp);
      if (proc.progress.drop_frames != null) dropFramesMax = Math.max(dropFramesMax, proc.progress.drop_frames);
    }, 1000);
    await sleep(durationSec * 1000);
    const m = metrics.summary();
    const rmsBySegment = seg.map((s, i) => ({
      gain: gains[i],
      rms: s.samples ? +Math.sqrt(s.sumSq / s.samples).toFixed(1) : null,
      samples: s.samples,
    }));
    const result = {
      ok: true, durationSec, vol: inlineVolume ? 'on' : 'off', gains,
      sink: nullSink ? 'null' : 'rtmps', instanceType: INSTANCE_TYPE, vcpus: VCPUS,
      cpu: m.cpu, rssMaxMiB: m.rssMaxMiB,
      rmsBySegment,
      mixer: mixer.stats(),
      ffmpeg: { dropFrames: dropFramesMax, speedMin: speedMin === Infinity ? null : `${speedMin}x` },
    };
    lastResult = result;
    console.log('voltest result', JSON.stringify(result));
    json(res, 200, result);
  } catch (err) {
    const failed = { ok: false, reason: `error: ${err.message}`, cpu: metrics?.summary().cpu };
    lastResult = failed;
    json(res, 200, failed);
  } finally {
    if (volTimer) clearInterval(volTimer);
    if (progressPoll) clearInterval(progressPoll);
    try { metrics?.stop(); } catch {}
    try { mixer?.stop(); } catch {}
    try { bgm?.stop(); } catch {}
    try { proc?.stdin.end(); } catch {}
    try { proc?.kill('SIGINT'); } catch {}
  }
}

const server = http.createServer(async (req, res) => {
  const params = new URL(req.url || '/', 'http://localhost').searchParams;
  const durationSec = Number(params.get('durationSec') || 60);
  try {
    if (req.url?.startsWith('/udptest')) {
      const host = params.get('host') || DEFAULT_STUN_HOST;
      const port = Number(params.get('port') || DEFAULT_STUN_PORT);
      const result = await stunProbe(host, port);
      json(res, 200, { target: `${host}:${port}`, ...result });
    } else if (req.url?.startsWith('/voicetest')) {
      json(res, 200, await discordVoiceProbe(DISCORD()));
    } else if (req.url?.startsWith('/receivetest')) {
      await receivetest(res, durationSec);
    } else if (req.url?.startsWith('/recvselftest')) {
      await recvselftest(res, durationSec);
    } else if (req.url?.startsWith('/dualtest')) {
      await dualtest(res, durationSec);
    } else if (req.url?.startsWith('/streamtest')) {
      await streamtest(res, durationSec);
    } else if (req.url?.startsWith('/pipetest')) {
      await pipetest(res, durationSec);
    } else if (req.url?.startsWith('/mixtest')) {
      await mixtest(res, durationSec, Number(params.get('bgmGain') || 0.3), params.get('player') === '1');
    } else if (req.url?.startsWith('/sysinfo')) {
      json(res, 200, sysinfo());
    } else if (req.url?.startsWith('/lastresult')) {
      json(res, 200, lastResult ?? { ok: false, reason: 'no-result' });
    } else if (req.url?.startsWith('/sizetest')) {
      await sizetest(res, {
        durationSec,
        bgmGain: Number(params.get('bgmGain') || 0.3),
        withPlayer: params.get('player') === '1',
        prefetch: Number(params.get('prefetch') || 20),
        trackSec: Number(params.get('trackSec') || 240),
        switchEverySec: Number(params.get('switchEverySec') || 600),
        loadgenN: Number(params.get('loadgen') || 0),
        fps: Number(params.get('fps') || 15),
      });
    } else if (req.url?.startsWith('/voltest')) {
      const gains = (params.get('gains') || '0.2,0.6,1.0').split(',').map(Number).filter((x) => !Number.isNaN(x));
      await voltest(res, {
        durationSec,
        gains: gains.length ? gains : [0.2, 0.6, 1.0],
        inlineVolume: (params.get('vol') || 'on') !== 'off',
        nullSink: params.get('sink') === 'null',
      });
    } else if (req.url?.startsWith('/loadtest')) {
      await loadtest(res, Number(params.get('n') || 1), Number(params.get('durationSec') || 600), params.get('sink') === 'null');
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('cloud-broadcast poc ok\n');
    }
  } catch (err) {
    if (!res.headersSent) json(res, 500, { ok: false, reason: `unhandled: ${err.message}` });
  }
});
server.listen(8080, () => console.log('listening :8080'));
