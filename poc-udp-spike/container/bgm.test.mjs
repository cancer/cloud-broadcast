import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Bgm, decodeBufferToPcm } from './bgm.mjs';

// 定数振幅の 1 フレーム PCM（480 sample/ch × 2ch, 全サンプル値 value）を作る。
function constPcm(value, samplesPerChannel = 480) {
  const buf = Buffer.alloc(samplesPerChannel * 2 * 2);
  for (let i = 0; i < samplesPerChannel * 2; i++) buf.writeInt16LE(value, i * 2);
  return buf;
}

// pull 出力の先頭サンプル値（全サンプル同値なので代表値でよい）
function firstSample(buf) {
  return buf.readInt16LE(0);
}

test('既定音量(1.0)では pull はソース振幅をそのまま返す', () => {
  const bgm = new Bgm(constPcm(1000, 480));
  const out = bgm.pull(480);
  assert.equal(firstSample(out), 1000);
});

test('setVolume(0.5) で pull 出力振幅が半分になる', () => {
  const bgm = new Bgm(constPcm(1000, 480));
  bgm.setVolume(0.5);
  assert.equal(firstSample(bgm.pull(480)), 500);
});

test('setVolume(0) で pull 出力が無音になる', () => {
  const bgm = new Bgm(constPcm(1000, 480));
  bgm.setVolume(0);
  assert.equal(firstSample(bgm.pull(480)), 0);
});

test('resource 未生成でも setVolume は例外を投げず volume を保持する', () => {
  const bgm = new Bgm(constPcm(1000, 480));
  assert.doesNotThrow(() => bgm.setVolume(0.3));
  assert.equal(bgm.volume, 0.3);
});

test('inlineVolume の resource がある場合 setVolume はそれに追随させる', () => {
  const bgm = new Bgm(constPcm(1000, 480));
  const applied = [];
  bgm.resource = { volume: { setVolume: (v) => applied.push(v) } };
  bgm.setVolume(0.7);
  assert.deepEqual(applied, [0.7]);
});

test('attachPlayer は既定で inlineVolume 無効（resource に VolumeTransformer が付かない）', () => {
  const bgm = new Bgm(constPcm(1000, 480));
  bgm.attachPlayer(null); // connection 無し・既定 inlineVolume:false
  assert.equal(bgm.resource.volume, undefined);
  bgm.stop();
});

test('attachPlayer({inlineVolume:true}) は VolumeTransformer を付け現在音量を適用する', () => {
  const bgm = new Bgm(constPcm(1000, 480));
  bgm.setVolume(0.5);
  bgm.attachPlayer(null, { inlineVolume: true });
  assert.ok(bgm.resource.volume);
  assert.equal(bgm.resource.volume.volume, 0.5);
  bgm.stop();
});

test('decodeBufferToPcm はメモリ上の音声を s16le PCM にデコードする', async () => {
  const input = readFileSync(new URL('./assets/bgm.opus', import.meta.url));
  const pcm = await decodeBufferToPcm(input);
  assert.ok(pcm.length > 0);
  assert.equal(pcm.length % 4, 0); // stereo s16le は 1 フレーム 4 バイト境界
});

test('swap は offset を 0 に戻し現在音量を維持する', () => {
  const bgm = new Bgm(constPcm(1000, 480));
  bgm.setVolume(0.5);
  bgm.pull(480); // offset を進める
  bgm.swap(constPcm(2000, 480));
  assert.equal(bgm.offset, 0);
  assert.equal(bgm.volume, 0.5);
  // 新ソース 2000 に音量 0.5 が乗って 1000
  assert.equal(firstSample(bgm.pull(480)), 1000);
});
