// 30 分継続受信リーダー（PoC1）。EventSource 相当の自動再接続つき。
// usage: node reader.mjs <url> <durationSec>
const url = process.argv[2] ?? "https://poc-sse.cancer6.workers.dev/sse";
const durationMs = (Number(process.argv[3]) || 1800) * 1000;

const start = Date.now();
let ticks = 0,
  states = 0,
  opens = 0,
  lastEventAt = start,
  maxGapMs = 0,
  lastId = "";
const log = (m) => console.log(`${new Date().toISOString()} +${Math.round((Date.now() - start) / 1000)}s ${m}`);

function summary(tag) {
  log(
    `[${tag}] opens=${opens} ticks=${ticks} states=${states} maxGapMs=${maxGapMs} elapsedSec=${Math.round(
      (Date.now() - start) / 1000,
    )}`,
  );
}

async function connectOnce() {
  const headers = { Accept: "text/event-stream" };
  if (lastId) headers["Last-Event-ID"] = lastId;
  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
  opens++;
  log(`open #${opens} (status ${res.status})`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      log("stream ended (server closed)");
      return;
    }
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const now = Date.now();
      const gap = now - lastEventAt;
      if (gap > maxGapMs) maxGapMs = gap;
      lastEventAt = now;
      let ev = "message";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("id:")) lastId = line.slice(3).trim();
      }
      if (ev === "tick") ticks++;
      else if (ev === "state") states++;
      else if (ev === "snapshot") log(`snapshot: ${raw.replace(/\n/g, " ")}`);
      if ((ticks + states) % 20 === 0 && (ticks + states) > 0) summary("progress");
    }
  }
}

(async () => {
  log(`reader start url=${url} durationSec=${durationMs / 1000}`);
  while (Date.now() - start < durationMs) {
    try {
      await connectOnce();
    } catch (e) {
      log(`connect error: ${e.message}`);
    }
    if (Date.now() - start < durationMs) {
      log("reconnecting in 3s…");
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  summary("FINAL");
  const okContinuity = ticks >= 100; // 15s 間隔で 30 分なら ~120 tick
  log(`RESULT continuity(>=100 ticks)=${okContinuity} reconnectsObserved=${opens > 1}`);
})();
