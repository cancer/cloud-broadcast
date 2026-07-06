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
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return getContainer(env.UDP_SPIKE).fetch(request);
  },
};
