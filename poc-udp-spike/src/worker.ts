import { Container, getContainer } from '@cloudflare/containers';

interface Env {
  UDP_SPIKE: DurableObjectNamespace<UdpSpikeContainer>;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_GUILD_ID?: string;
  DISCORD_CHANNEL_ID?: string;
}

export class UdpSpikeContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '2m';
  enableInternet = true; // コンテナのインターネット egress を有効化（必須）

  // §7 任意追試用。secret として設定した値をコンテナ起動時の環境変数として渡す。
  envVars = {
    DISCORD_BOT_TOKEN: this.env.DISCORD_BOT_TOKEN ?? '',
    DISCORD_GUILD_ID: this.env.DISCORD_GUILD_ID ?? '',
    DISCORD_CHANNEL_ID: this.env.DISCORD_CHANNEL_ID ?? '',
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return getContainer(env.UDP_SPIKE).fetch(request);
  },
};
