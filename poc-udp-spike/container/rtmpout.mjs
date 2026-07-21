import { spawn } from 'node:child_process';

// PoC-1 H1b/H1c: コンテナ内 FFmpeg で静止画 + 音声を RTMPS で YouTube Live ingest へ push。
// エンコード設定は spec §5.2 の既定値（1080p / 15fps / 1000k / AAC 160k / 48kHz）。
//
// silent=true (H1b): 無音ソース(anullsrc)。stdin は使わない。
// silent=false (H1c/PoC-2): stdin から s16le/48k/stereo PCM を受ける。
// standby 画像・出力先はテスト容易性のため env で差し替え可能（既定は本番の YouTube RTMPS）。
// nullSink=true: encode まで実行して muxer で捨てる（`-f null`）。YouTube キー無しで
// エンコード CPU 負荷だけを測るための H3 用モード（RTMPS 送出負荷は encode に比べ微小）。
export function startFfmpeg({ streamKey, silent = false, nullSink = false, fps = 15 }) {
  const stillImage = process.env.STANDBY_PNG || '/app/standby.png';
  // 静止画は毎フレーム同一なので fps を下げても画質は不変、映像エンコード CPU はほぼ fps に比例して減る。
  // GOP は約 2 秒間隔のキーフレームに（YouTube 推奨）。
  const gop = Math.max(1, Math.round(fps * 2));
  const output = process.env.RTMP_OUTPUT
    ? process.env.RTMP_OUTPUT
    : `rtmps://a.rtmps.youtube.com/live2/${streamKey}`;
  const audioIn = silent
    ? ['-re', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']   // H1b: 無音ソース
    : ['-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0']; // H1c: stdin から PCM
  const outputArgs = nullSink ? ['-f', 'null', '-'] : ['-f', 'flv', output];
  const args = [
    '-loglevel', 'warning', '-progress', 'pipe:2',
    '-loop', '1', '-framerate', String(fps), '-i', stillImage,
    ...audioIn,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage',
    '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(gop), '-b:v', '1000k',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    // 映像と音声の長さが揃わないと出力が止まらない/縮む。stdin PCM 供給が本体なので shortest は付けない。
    ...outputArgs,
  ];
  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'pipe'] });

  // -progress pipe:2 の出力をパースして最新値を保持（PoC-3 の drop_frames/fps/speed 記録に使う）
  const progress = { fps: null, drop_frames: null, speed: null, frame: null };
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    for (const line of text.split('\n')) {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key === 'fps') progress.fps = Number(val);
      else if (key === 'drop_frames') progress.drop_frames = Number(val);
      else if (key === 'speed') progress.speed = val;
      else if (key === 'frame') progress.frame = Number(val);
      else if (key !== 'progress') continue;
    }
    // warning レベルのログはそのまま出す（progress 以外の行）
    if (!text.includes('=')) process.stderr.write(text);
  });

  proc.progress = progress;
  return proc;
}

// FFmpeg stdin への背圧対応書き込み。write() が false を返したら drain を待つ（spec §9 PoC-2）。
// 待たされた回数を onBackpressure で通知（underruns として集計）。
export function writePcm(proc, buf, onBackpressure) {
  const ok = proc.stdin.write(buf);
  if (!ok && onBackpressure) onBackpressure();
  return ok;
}
