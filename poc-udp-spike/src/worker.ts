import { Container, getContainer } from '@cloudflare/containers';

interface Env {
  UDP_SPIKE: DurableObjectNamespace<UdpSpikeContainer>;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_GUILD_ID?: string;
  DISCORD_CHANNEL_ID?: string;
  DISCORD_BOT_TOKEN_2?: string;
  YOUTUBE_STREAM_KEY?: string;
  VCPUS?: string;
  INSTANCE_TYPE?: string;
  WORKER_URL?: string;
}

export class UdpSpikeContainer extends Container<Env> {
  defaultPort = 8080;
  // 実行中(in-flight)リクエストはコンテナを起こし続けるため 30 分テストでも 2m で足りる
  // （600s loadtest が sleepAfter=2m で完走済み）。45m にすると旧インスタンスが sleep せず
  // 新イメージへの rollout が進まないため、短めに保つ。
  sleepAfter = '2m';
  enableInternet = true; // コンテナのインターネット egress を有効化（必須）

  // secret として設定した値をコンテナ起動時の環境変数として渡す（PoC-0 と同一機構）。
  envVars = {
    DISCORD_BOT_TOKEN: this.env.DISCORD_BOT_TOKEN ?? '',
    DISCORD_GUILD_ID: this.env.DISCORD_GUILD_ID ?? '',
    DISCORD_CHANNEL_ID: this.env.DISCORD_CHANNEL_ID ?? '',
    DISCORD_BOT_TOKEN_2: this.env.DISCORD_BOT_TOKEN_2 ?? '',
    YOUTUBE_STREAM_KEY: this.env.YOUTUBE_STREAM_KEY ?? '',
    VCPUS: this.env.VCPUS ?? '2',
    INSTANCE_TYPE: this.env.INSTANCE_TYPE ?? 'standard-3',
    WORKER_URL: this.env.WORKER_URL ?? '',
  };

  // PoC-1 上り到達性: コンテナ→DO 往復の DO 側終端。コンテナを起こさず DO 単体で応答する。
  async heartbeat() {
    return { pong: true, from: 'do', name: 'ctrl', ts: Date.now(), nonce: crypto.randomUUID() };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // PoC-1: /heartbeat は固定名 'ctrl' の DO に委譲し、コンテナを起こさず DO 単体で応答する
    // （既定名 'cf-singleton-container' とは別インスタンス）。
    if (new URL(request.url).pathname === '/heartbeat') {
      return Response.json(await getContainer(env.UDP_SPIKE, 'ctrl').heartbeat());
    }
    return getContainer(env.UDP_SPIKE).fetch(request);
  },
};
