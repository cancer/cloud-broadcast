import http from 'node:http';
import dgram from 'node:dgram';
import { URL } from 'node:url';
import { discordVoiceProbe } from './voicetest.mjs';

// 既定は Google STUN。DNS を排除して transport だけ見たい時は IP を渡す（§9 参照）
const DEFAULT_STUN_HOST = process.env.STUN_HOST || 'stun.l.google.com';
const DEFAULT_STUN_PORT = Number(process.env.STUN_PORT || 19302);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 5000);

// STUN Binding Request（20バイトヘッダのみ、body なし）
function buildStunBindingRequest() {
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(0x0001, 0);      // Message Type: Binding Request
  buf.writeUInt16BE(0x0000, 2);      // Message Length: 0
  buf.writeUInt32BE(0x2112a442, 4);  // Magic Cookie
  for (let i = 8; i < 20; i++) buf[i] = Math.floor(Math.random() * 256); // Transaction ID
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

const server = http.createServer(async (req, res) => {
  if (req.url && req.url.startsWith('/udptest')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const host = params.get('host') || DEFAULT_STUN_HOST;
    const port = Number(params.get('port') || DEFAULT_STUN_PORT);
    const result = await stunProbe(host, port);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ target: `${host}:${port}`, ...result }));
    console.log('udptest', JSON.stringify(result));
  } else if (req.url && req.url.startsWith('/voicetest')) {
    const result = await discordVoiceProbe({
      token: process.env.DISCORD_BOT_TOKEN,
      guildId: process.env.DISCORD_GUILD_ID,
      channelId: process.env.DISCORD_CHANNEL_ID,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
    console.log('voicetest', JSON.stringify(result));
  } else {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('udp-spike ok\n');
  }
});
server.listen(8080, () => console.log('listening :8080'));
