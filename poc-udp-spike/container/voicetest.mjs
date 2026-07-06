import { Client, GatewayIntentBits } from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus } from '@discordjs/voice';

// PoC-0 §7 任意追試: UDP transport の合否とは別に、Discord voice 固有の
// ハンドシェイク（UDP IP discovery + 暗号化ネゴシエーション）が同じコンテナで完了するかを見る。
// stateChange を全て記録することで、途中で詰まった場合にどの段階か切り分けられるようにする。
export async function discordVoiceProbe({ token, guildId, channelId, timeoutMs = 20000 }) {
  const steps = [];
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  let connection;

  try {
    if (!token || !guildId || !channelId) {
      return { ok: false, reason: 'missing-config', steps };
    }

    await client.login(token);
    steps.push('gateway-login-ok');

    if (!client.isReady()) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('client-ready-timeout')), timeoutMs);
        client.once('ready', () => { clearTimeout(t); resolve(); });
      });
    }
    steps.push('client-ready');

    const guild = await client.guilds.fetch(guildId);
    steps.push('guild-fetched');

    connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    connection.on('stateChange', (oldState, newState) => {
      steps.push(`voice-state:${oldState.status}->${newState.status}`);
    });
    steps.push('join-requested');

    // Connecting 状態の間に UDP ソケット確立・IP discovery・暗号化モードのネゴシエーションが走る。
    await entersState(connection, VoiceConnectionStatus.Ready, timeoutMs);
    steps.push('voice-ready');

    return { ok: true, reason: 'voice-ready', steps };
  } catch (err) {
    return { ok: false, reason: `error: ${err.message}`, steps };
  } finally {
    try { connection?.destroy(); } catch {}
    await client.destroy().catch(() => {});
  }
}
