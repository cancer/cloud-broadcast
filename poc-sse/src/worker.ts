/**
 * PoC: 監視の SSE（docs/sse-monitoring.md）
 *
 * - PoC 1: 長時間 SSE の維持（Worker → ブラウザ）。30 分継続受信・EventSource 自動再接続。
 * - PoC 2: DO の複数購読者ファンアウト。1 状態変化を全接続へ配る。
 *
 * アーキテクチャ（重要な PoC 知見）:
 *   browser ⟷SSE⟷ Worker ⟷WebSocket⟷ DO
 *
 *   DO への plain fetch サブリクエストは、応答ボディをストリーミング中でも DO を常駐させない
 *   （https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/）。
 *   そのため「Worker→DO を plain fetch で貼り、DO が SSE ストリームを返す」構成は成立しない
 *   （実測: snapshot も flush されず、DO 内のポンプも進まず seq が 0 のまま・接続は Canceled）。
 *
 *   解決: SSE は Worker で終端する（Worker はブラウザへストリーミング中 active に保たれる）。
 *   Worker↔DO は WebSocket にする（WebSocket は DO を常駐させ hibernation も効く）。
 *   - 継続性（PoC1）: Worker 側ポンプが keepalive + tick を定期送出。DO 非依存。
 *   - ファンアウト（PoC2）: /bump で DO が全 WebSocket（=各購読者の Worker invocation）へ配信し、
 *     各 Worker が自分のブラウザへ SSE の state イベントとして転送する。
 */

import { DurableObject } from "cloudflare:workers";
import { createRemoteJWKSet, jwtVerify } from "jose";

interface Env {
  SSE_HUB: DurableObjectNamespace<SseHub>;
  // Cloudflare Access（有効時のみ設定）。両方揃ったときだけ JWT 検証を有効化する。
  POLICY_AUD?: string; // Access アプリの AUD tag
  TEAM_DOMAIN?: string; // https://<team>.cloudflareaccess.com
}

// team domain ごとに JWKS をキャッシュ（createRemoteJWKSet が内部で証明書を再利用する）。
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksFor = "";

// Access JWT を検証する。未設定なら null（=ゲート無効）、検証失敗なら 403 Response、成功なら true。
async function verifyAccess(request: Request, env: Env): Promise<Response | true | null> {
  if (!env.POLICY_AUD || !env.TEAM_DOMAIN) return null; // Access 未設定 = 素通し
  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ??
    (request.headers.get("Cookie")?.match(/CF_Authorization=([^;]+)/)?.[1] ?? "");
  if (!token) return new Response("Missing CF Access JWT", { status: 403 });
  try {
    if (!jwks || jwksFor !== env.TEAM_DOMAIN) {
      jwks = createRemoteJWKSet(new URL(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`));
      jwksFor = env.TEAM_DOMAIN;
    }
    await jwtVerify(token, jwks, { issuer: env.TEAM_DOMAIN, audience: env.POLICY_AUD });
    return true;
  } catch (e) {
    return new Response(`Invalid CF Access JWT: ${(e as Error).message}`, { status: 403 });
  }
}

const enc = new TextEncoder();
const TICK_MS = 15_000;

export class SseHub extends DurableObject<Env> {
  private seq = 0; // 状態変化の連番（in-memory・PoC 用）

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") return this.acceptWs();
    if (url.pathname === "/bump") return this.bump();
    if (url.pathname === "/kick") return this.kick();
    if (url.pathname === "/stats") {
      return Response.json({ subscribers: this.ctx.getWebSockets().length, seq: this.seq });
    }
    return new Response("not found", { status: 404 });
  }

  // 購読者（の Worker invocation）からの WebSocket を hibernation API で受ける。
  private acceptWs(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ kind: "snapshot", seq: this.seq, subscribers: this.ctx.getWebSockets().length }));
    return new Response(null, { status: 101, webSocket: client });
  }

  // 1 つの状態変化を全 WebSocket へファンアウトする。
  private bump(): Response {
    const seq = ++this.seq;
    const payload = JSON.stringify({ kind: "bump", seq, ts: Date.now() });
    let delivered = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
        delivered++;
      } catch {
        /* 切断済み */
      }
    }
    console.log(`bump seq=${seq} delivered=${delivered}`);
    return Response.json({ seq, delivered });
  }

  // 全 WebSocket を強制切断する（EventSource 自動再接続の検証用）。
  private kick(): Response {
    let kicked = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "kick");
        kicked++;
      } catch {
        /* noop */
      }
    }
    return Response.json({ kicked });
  }

  webSocketClose(ws: WebSocket): void {
    ws.close();
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Cloudflare Access ゲート（設定時のみ）。エッジで Access を通過した上に、
    // origin 直叩きを弾くための二重防御（docs 準拠: JWT を検証してから処理する）。
    const gate = await verifyAccess(request, env);
    if (gate instanceof Response) return gate;

    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/sse") return handleSse(request, env, ctx);
    if (url.pathname === "/bump" || url.pathname === "/stats" || url.pathname === "/kick") {
      return env.SSE_HUB.getByName("hub").fetch(request);
    }
    return new Response("not found", { status: 404 });
  },
};

async function handleSse(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // DO への WebSocket を張る（ファンアウト受信用）。
  const wsResp = await env.SSE_HUB.getByName("hub").fetch(
    new Request("https://do/ws", { headers: { Upgrade: "websocket" } }),
  );
  const ws = wsResp.webSocket;
  if (!ws) return new Response("ws upgrade failed", { status: 500 });
  ws.accept();

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  const write = (chunk: string) => writer.write(enc.encode(chunk)).catch(() => {});

  // DO から届いた状態変化を SSE の state イベントとしてブラウザへ転送。
  ws.addEventListener("message", (ev: MessageEvent) => {
    const data = typeof ev.data === "string" ? ev.data : "";
    let seq = "";
    try {
      const o = JSON.parse(data);
      if (o.kind === "snapshot") {
        void write(`event: snapshot\ndata: ${data}\n\n`);
        return;
      }
      seq = o.seq != null ? `id: ${o.seq}\n` : "";
    } catch {
      /* そのまま流す */
    }
    void write(`${seq}event: state\ndata: ${data}\n\n`);
  });
  ws.addEventListener("close", () => void writer.close().catch(() => {}));

  // Worker 側ポンプ: keepalive + tick を定期送出（継続性=PoC1・DO 非依存）。
  // ブラウザがストリーム受信中は Worker invocation は active に保たれる。
  const pump = (async () => {
    let n = 0;
    try {
      while (!request.signal.aborted) {
        await scheduler.wait(TICK_MS);
        if (request.signal.aborted) break;
        await write(`: ka\nid: t${++n}\nevent: tick\ndata: ${JSON.stringify({ n, ts: Date.now() })}\n\n`);
      }
    } finally {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      await writer.close().catch(() => {});
    }
  })();
  ctx.waitUntil(pump);

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

const HTML = `<!doctype html><meta charset=utf-8><title>SSE PoC</title>
<style>body{font-family:monospace;margin:1rem}#log{white-space:pre-wrap;font-size:12px}
button{font-size:14px;padding:.3rem .6rem}</style>
<h1>SSE monitoring PoC</h1>
<div><button id=bump>POST /bump</button>
<span id=stat>connecting…</span></div>
<div id=log></div>
<script>
const log=(m)=>{document.getElementById('log').textContent+=new Date().toISOString()+' '+m+'\\n'};
let ticks=0,states=0,opens=0;
const es=new EventSource('/sse');
es.onopen=()=>{opens++;log('open #'+opens);stat()};
es.onerror=()=>{log('error/reconnecting (readyState='+es.readyState+')')};
es.addEventListener('snapshot',e=>log('snapshot '+e.data));
es.addEventListener('tick',e=>{ticks++;stat()});
es.addEventListener('state',e=>{states++;log('STATE '+e.data+' lastId='+e.lastEventId);stat()});
function stat(){document.getElementById('stat').textContent='opens='+opens+' ticks='+ticks+' states='+states}
document.getElementById('bump').onclick=()=>fetch('/bump',{method:'POST'}).then(r=>r.json()).then(j=>log('bump ->'+JSON.stringify(j)));
window.__sse={get:()=>({opens,ticks,states,readyState:es.readyState})};
</script>`;
