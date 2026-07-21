import fs from 'node:fs';

// PoC-3 §5.2: 1 秒ごとに自プロセス + ffmpeg 子プロセスの CPU / RSS をサンプルし、vCPU 上限に対する
// 使用率へ換算して p50/p95/max を集計する。測定自体の CPU 汚染を避けるため間隔は 1 秒に留める。

// /proc/<pid>/stat の utime+stime（clock ticks）。Linux 前提（CF Containers は Linux）。
function readProcCpuTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm に空白/括弧が含まれ得るので最後の ')' 以降を使う
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // stat フィールド 14=utime,15=stime（1-indexed）。after[0] が field3(state) なので utime=after[11],stime=after[12]
    const utime = Number(after[11]), stime = Number(after[12]);
    return utime + stime;
  } catch { return null; }
}

function readProcRssBytes(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
    return m ? Number(m[1]) * 1024 : null;
  } catch { return null; }
}

const CLK_TCK = 100; // 通常 sysconf(_SC_CLK_TCK)=100。Linux コンテナの既定

export class Metrics {
  // vcpus: コンテナに割り当てられた vCPU 数（wrangler の instance_type 由来）
  constructor({ vcpus = 1, ffmpegPidFn = () => null } = {}) {
    this.vcpus = vcpus;
    this.ffmpegPidFn = ffmpegPidFn;
    this.timer = null;
    this.cpuSamples = []; // vCPU 上限に対する使用率(0..1)
    this.rssSamples = []; // bytes（自分 + ffmpeg）
    this._lastSelf = process.cpuUsage();
    this._lastFfTicks = null;
    this._lastT = Date.now();
  }

  start() {
    this.timer = setInterval(() => this._sample(), 1000);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  _sample() {
    const now = Date.now();
    const dtSec = (now - this._lastT) / 1000;
    this._lastT = now;

    // 自プロセス CPU（マイクロ秒）
    const self = process.cpuUsage(this._lastSelf);
    this._lastSelf = process.cpuUsage();
    let cpuSec = (self.user + self.system) / 1e6;

    // ffmpeg 子プロセス CPU（/proc から ticks 差分）
    const ffPid = this.ffmpegPidFn();
    if (ffPid) {
      const ticks = readProcCpuTicks(ffPid);
      if (ticks !== null && this._lastFfTicks !== null) cpuSec += (ticks - this._lastFfTicks) / CLK_TCK;
      this._lastFfTicks = ticks;
    } else {
      this._lastFfTicks = null;
    }

    const usage = dtSec > 0 ? (cpuSec / dtSec) / this.vcpus : 0; // vCPU 上限比
    this.cpuSamples.push(usage);

    let rss = readProcRssBytes(process.pid) ?? process.memoryUsage().rss;
    if (ffPid) { const ffRss = readProcRssBytes(ffPid); if (ffRss) rss += ffRss; }
    this.rssSamples.push(rss);
  }

  _pct(arr, p) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  }

  summary() {
    const cpu = this.cpuSamples;
    return {
      cpu: {
        p50: +this._pct(cpu, 0.5).toFixed(3),
        p95: +this._pct(cpu, 0.95).toFixed(3),
        max: +(cpu.length ? Math.max(...cpu) : 0).toFixed(3),
      },
      rssMaxMiB: Math.round((this.rssSamples.length ? Math.max(...this.rssSamples) : 0) / (1024 * 1024)),
      samples: cpu.length,
    };
  }
}
