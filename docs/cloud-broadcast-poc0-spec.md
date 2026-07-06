# PoC-0 仕様書 — Cloudflare Containers アウトバウンド UDP 検証

## 0. この文書について

`cloud-broadcast-poc-plan.md` の **PoC-0** を、そのまま実装・実行・判定できる粒度に落とした実装仕様。

- **目的**: Cloudflare Containers から **アウトバウンド UDP の往復（双方向）が成立するか**を yes/no で確定する。
- **位置づけ**: 基盤選定の分岐点。成立 → メディアプレーンも Cloudflare に統一。不成立 → Fly.io 等の常駐基盤へ。
- **前提知見**: `knowledge: containers/cloudflare-containers-mechanics`（inbound TCP/UDP 不可・outbound は HTTP/HTTPS 中心で説明・`image` は Dockerfile ビルド/レジストリ参照の2経路・`sleepAfter` で常駐可）。
- **PoC-1 以降（Discord 実接続・BGM・ミックス・RTMPS）は本 PoC の結果確定後に別途仕様化する。**

---

## 1. 検証仮説と判定基準

- **H0**: Cloudflare Container 内から UDP ソケットを開き、外部 UDP サーバへ送信し、**戻りパケットを受信できる**。
- **合格**: STUN Binding Success Response（メッセージ種別 `0x0101`）を受信。
- **不合格**: 送信エラー、または `TIMEOUT_MS` 内に無応答。

### なぜ STUN か

公開された UDP 応答サーバへ **1 パケットの往復**を投げるだけで「アウトバウンド UDP 送信 + 戻り経路」の生死を最小コストで確認できる。エコー実装不要・認証不要・軽量。

> discriminating fact: CF の egress が Workers 仲介なら（Workers ソケットは TCP 専用のため）UDP は不可能。コンテナが直接 egress を持つなら通る。本テストがそこを実測で切り分ける。

---

## 2. スコープ

- **In**: transport 単体テスト（`dgram` + STUN）を **deploy 済みの CF ネットワーク上**で実行し yes/no を得る。
- **Out**: Discord bot 実装・BGM・ミックス・RTMPS 送出（すべて PoC-1 以降）。@discordjs/voice の実接続確認は「合格後の任意追試」として §7 に置く。

---

## 3. アーキテクチャ

```
[HTTPリクエスト] ─► Worker ─(getContainer.fetch)─► Container(:8080)
                                                     │ GET /udptest
                                                     ▼
                                           dgram(udp4) ──► STUN サーバ:19302
                                                     ◄── Binding Response?
                                                     │
                                           結果を JSON で返す ◄─────────┘
```

Worker はリクエストをコンテナへ委譲するだけ。UDP テストの実体はコンテナ内で走る（＝CF のネットワークから出る UDP を測る）。

---

## 4. リポジトリ構成

```
poc-udp-spike/
├── wrangler.jsonc
├── package.json
├── src/
│   └── worker.ts          # Worker: getContainer → fetch 委譲
└── container/
    ├── Dockerfile
    └── index.mjs          # HTTP サーバ + dgram/STUN テスト（依存ゼロ）
```

---

## 5. 実装仕様（参照実装込み）

### 5.1 コンテナアプリ `container/index.mjs`

Node 標準モジュール（`http` / `dgram`）のみ。npm 依存ゼロ。

```js
import http from 'node:http';
import dgram from 'node:dgram';

// 既定は Google STUN。DNS を排除して transport だけ見たい時は IP を渡す（§9 参照）
const STUN_HOST = process.env.STUN_HOST || 'stun.l.google.com';
const STUN_PORT = Number(process.env.STUN_PORT || 19302);
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

function stunProbe() {
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
    sock.send(buildStunBindingRequest(), STUN_PORT, STUN_HOST, (err) => {
      if (err) { clearTimeout(timer); done({ ok: false, reason: `send-error: ${err.message}` }); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url && req.url.startsWith('/udptest')) {
    const result = await stunProbe();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ target: `${STUN_HOST}:${STUN_PORT}`, ...result }));
    console.log('udptest', JSON.stringify(result));
  } else {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('udp-spike ok\n');
  }
});
server.listen(8080, () => console.log('listening :8080'));
```

### 5.2 Worker `src/worker.ts`

```ts
import { Container, getContainer } from '@cloudflare/containers';

export class UdpSpikeContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '2m';
  enableInternet = true; // コンテナのインターネット egress を有効化（必須）
}

interface Env {
  UDP_SPIKE: DurableObjectNamespace<UdpSpikeContainer>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return getContainer(env.UDP_SPIKE).fetch(request);
  },
};
```

### 5.3 `wrangler.jsonc`

```jsonc
{
  "name": "poc-udp-spike",
  "main": "src/worker.ts",
  "compatibility_date": "2026-07-01",
  "containers": [
    {
      "class_name": "UdpSpikeContainer",
      "image": "./container/Dockerfile",
      "max_instances": 1
    }
  ],
  "durable_objects": {
    "bindings": [{ "name": "UDP_SPIKE", "class_name": "UdpSpikeContainer" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["UdpSpikeContainer"] }
  ]
}
```

### 5.4 `container/Dockerfile`

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY index.mjs .
EXPOSE 8080
CMD ["node", "index.mjs"]
```

> **linux/amd64 必須**。Apple Silicon(arm64) では `docker buildx --platform linux/amd64` か `colima start --arch x86_64` で amd64 を明示（`knowledge: containers/container-fundamentals-*` のアーキ境界参照）。

---

## 6. 実行手順

前提（`cloud-broadcast-poc-plan.md` の準備物 1〜3）: Colima/Docker 起動・Workers Paid・`wrangler login`。

```bash
# 1. デプロイ（image=Dockerfile なのでローカルでビルド→CF Registry へ push）
npx wrangler deploy

# 2. 本番 URL を叩く（必ず deploy 済み CF ネットワーク上で）
curl https://poc-udp-spike.<subdomain>.workers.dev/udptest
```

> **⚠️ ローカル開発（`wrangler dev`）で測らないこと。** コンテナが手元マシンで動き「あなたのマシンの UDP」を測ってしまい、CF の egress を検証できない（`knowledge: containers/*`）。必ず `wrangler deploy` 後の本番 URL で測定する。

期待レスポンス例（合格時）:

```json
{ "target": "stun.l.google.com:19302", "ok": true, "reason": "binding-success", "elapsedMs": 42 }
```

---

## 7. 判定と分岐

| 結果 | 意味 | 次アクション |
|---|---|---|
| `ok: true` | アウトバウンド UDP 往復が成立 | **（任意追試）** 同コンテナで `@discordjs/voice` の VC join → UDP IP discovery + 暗号化ネゴまで到達するか確認 → 通れば **メディアプレーンを CF に統一**して PoC-1 へ |
| `ok: false, reason: timeout` | 送信は出たが戻りが来ない/UDP が遮断 | §9 の切り分け（DNS か transport か）→ 切り分け後も不成立なら **Fly.io 等の常駐基盤**へ移り、同テストで確認 |
| `ok: false, reason: send-error/socket-error` | ソケット確立・送信自体が失敗 | 同上（基盤側の UDP 非対応の可能性が高い） |

任意追試（実プロトコル）で initに失敗する場合、transport は通っても暗号化(A-2)や Discord 固有ハンドシェイクが原因の可能性があるため、`feasibility-check.md` A-2 を参照して切り分ける。

---

## 8. 結果記録様式

判定は必ず記録に残す（後日の基盤再検討で参照）。

| 試行 | 送信先 | enableInternet | 結果(ok) | reason | elapsedMs | 備考 |
|---|---|---|---|---|---|---|
| 1 | stun.l.google.com:19302 | true | true | binding-success | 35 | ホスト名（DNS 経由） |
| 2 | 74.125.250.129:19302 | true | true | binding-success | 24 | ①のIP直指定、DNS を排除した再試験（§9） |
| 3 | global.stun.twilio.com:3478 | true | true | binding-success | 47 | 別ベンダーの STUN、単一サーバ依存を排除 |

**H0: 合格**（2026-07-03、`poc-udp-spike.cancer6.workers.dev`）。

任意追試（§7、実プロトコル）も合格: `@discordjs/voice` で実際に VC join し
`VoiceConnectionStatus.Ready` まで到達（UDP IP discovery + AEAD 暗号化ネゴシエーション成立）。
実装は `poc-udp-spike/container/voicetest.mjs`。

---

## 9. リスク・注意点

- **DNS と transport の切り分け**: `dgram.send` にホスト名を渡すと名前解決（getaddrinfo, 実質 UDP/53）が先に走る。STUN 失敗が「UDP transport 全遮断」なのか「DNS 解決失敗」なのか切り分けるため、**STUN サーバの IP を直接指定した再試験**（試行2）を行う。IP 直で成功すれば transport は生きており DNS 側の問題、IP 直でも失敗なら transport が原因。
- **STUN 特別扱いの否定**: STUN が通っても「任意の UDP 宛先」が通る保証は厳密には無い。最終確認は §7 の実プロトコル追試（Discord voice の実 UDP）で行う。
- **`enableInternet`**: 未設定だとコンテナがインターネットへ出られず、UDP 以前に失敗する。`true` を必ず設定。
- **課金**: `sleepAfter: '2m'` で短時間停止。テスト後 `max_instances` は 1、放置しても idle で寝る。
- **単一サーバ依存**: STUN サーバ側の一時障害を結果と誤認しないよう、別 STUN でも試す（試行3）。

---

## 10. 完了の定義（Definition of Done）

- [x] deploy 済み CF ネットワーク上で `/udptest` を実行し、§8 の表に**最低 3 試行**の結果を記録した。
- [x] H0 の yes/no が確定し、§7 の分岐のどちらへ進むかが決まった（→ 合格、CF でメディアプレーン統一）。
- [x] 結果を `feasibility-check.md` の A-1 に反映した（「未決」→「実測で決着」）。
- [x]（任意追試・実施済み）`@discordjs/voice` での VC join が `VoiceConnectionStatus.Ready` まで到達することを確認した。
