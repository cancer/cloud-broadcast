import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus, EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';

// Stage は join 直後 audience(suppress) で送出できない。送出するなら speaker へ昇格する
// （PATCH /guilds/{id}/voice-states/@me suppress:false 相当）。live な Stage Instance と
// Bot の Stage モデレーター/Mute Members 権限が前提。VC では no-op で false を返す。
async function unsuppressIfStage(guild, channelId) {
  const channel = await guild.channels.fetch(channelId);
  if (channel?.type !== ChannelType.GuildStageVoice) return false;
  const me = await guild.members.fetchMe();
  await me.voice.setSuppressed(false);
  return true;
}

// PoC-1 H1a: VC の他参加者の Opus ストリームを購読し、デコードした PCM が取れるか。
// receive API は Discord 未保証(D-1)・@discordjs/voice 0.19.0 で subscribe/EndBehaviorType/
// speaking('start') の現行シグネチャを context7 で確認済み(2026-07-06)。
//
// 重要: 受信するので selfDeaf: false（PoC-0 の voicetest は true。true だと受信しない）。

// Gateway ログイン → guild fetch → VC join。connection と client を返す。
// selfMute: true=受信専用（PoC-1）/ false=送受信同時(full-duplex、§2.2 の BGM を VC へ送る構成)。
export async function joinForReceive({ token, guildId, channelId, timeoutMs = 20000, selfMute = true }) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  await client.login(token);
  if (!client.isReady()) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('client-ready-timeout')), timeoutMs);
      client.once('ready', () => { clearTimeout(t); resolve(); });
    });
  }
  const guild = await client.guilds.fetch(guildId);
  const connection = joinVoiceChannel({
    channelId, guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, selfMute, // 受信するので selfDeaf は常に false
  });
  await entersState(connection, VoiceConnectionStatus.Ready, timeoutMs);
  // 送出する時だけ speaker 昇格（Stage のみ）。受信専用(selfMute:true)は audience のまま受信できる。
  const stageSpeaker = selfMute ? false : await unsuppressIfStage(guild, channelId);
  return { client, connection, userId: client.user.id, stageSpeaker };
}

// H1a を人の発話なしで測るためのプレイヤー Bot。2 体目のトークンで同じ VC に join し、
// 音源を再生する（= 受信 Bot から見た「他参加者」）。selfMute:false / selfDeaf:true。
export async function joinForPlay({ token, guildId, channelId, timeoutMs = 20000 }) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  await client.login(token);
  if (!client.isReady()) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('player-client-ready-timeout')), timeoutMs);
      client.once('ready', () => { clearTimeout(t); resolve(); });
    });
  }
  const guild = await client.guilds.fetch(guildId);
  const connection = joinVoiceChannel({
    channelId, guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true, selfMute: false, // 送出するので mute しない
  });
  await entersState(connection, VoiceConnectionStatus.Ready, timeoutMs);
  return { client, connection, userId: client.user.id };
}

// speaking 開始ごとに購読し、Opus→PCM(48kHz/stereo/s16le) にデコードして onPcm へ渡す。
// stats.reconnects / stats.speakingStarts / stats.bytesByUser を更新する。
export function subscribeAll(connection, onPcm, stats) {
  const receiver = connection.receiver;

  connection.on('stateChange', (oldState, newState) => {
    if (oldState.status === VoiceConnectionStatus.Ready && newState.status !== VoiceConnectionStatus.Ready) {
      stats.reconnects = (stats.reconnects ?? 0);
    }
    if (newState.status === VoiceConnectionStatus.Ready && oldState.status !== VoiceConnectionStatus.Ready) {
      // Ready への復帰は初回 join を除き再接続とみなす
      if (stats._wasReady) stats.reconnects = (stats.reconnects ?? 0) + 1;
      stats._wasReady = true;
    }
  });

  receiver.speaking.on('start', (userId) => {
    stats.speakingStarts = (stats.speakingStarts ?? 0) + 1;
    if (receiver.subscriptions.has(userId)) return;
    const opus = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    opus.pipe(decoder).on('data', (pcm) => {
      stats.bytesByUser[userId] = (stats.bytesByUser[userId] ?? 0) + pcm.length;
      onPcm(userId, pcm);
    });
    decoder.on('error', (err) => { stats.decodeErrors = (stats.decodeErrors ?? 0) + 1; console.error('decode error', userId, err.message); });
  });
}
