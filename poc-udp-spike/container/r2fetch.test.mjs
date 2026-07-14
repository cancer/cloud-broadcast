import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { R2Prefetcher } from './r2fetch.mjs';
import { Bgm } from './bgm.mjs';

// ListObjectsV2 の XML 応答を組み立てる。
function listXml(keys, { truncated = false, nextToken } = {}) {
  const contents = keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('');
  const trunc = `<IsTruncated>${truncated}</IsTruncated>`;
  const next = nextToken ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${contents}${trunc}${next}</ListBucketResult>`;
}

// fetch スタブ: list は XML、object GET は key ごとの擬似バイト列を返す。呼び出しURLを記録する。
function makeFetchStub(pages) {
  const calls = [];
  let listCall = 0;
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(String(url));
      const u = new URL(String(url));
      if (u.searchParams.has('list-type')) {
        const page = pages[listCall++];
        return new Response(page, { status: 200 });
      }
      // object GET: パスの最後のセグメントを本文として返す
      const key = decodeURIComponent(u.pathname.split('/').pop());
      return new Response(new TextEncoder().encode(`bytes:${key}`), { status: 200 });
    },
  };
}

const creds = { accountId: 'acct', accessKeyId: 'ak', secretAccessKey: 'sk', bucket: 'bgm' };
// decode スタブ: バイト列をそのまま「PCM」とみなす（ffmpeg 非依存でロジックを検証）
const decodeStub = async (buf) => Buffer.concat([Buffer.from('pcm:'), buf]);

test('listKeys は XML から Key を抽出する', async () => {
  const stub = makeFetchStub([listXml(['a.mp3', 'b.mp3'])]);
  const p = new R2Prefetcher({ ...creds, fetchImpl: stub.fetchImpl, decodeImpl: decodeStub });
  assert.deepEqual(await p.listKeys(), ['a.mp3', 'b.mp3']);
});

test('listKeys は継続トークンでページングする', async () => {
  const stub = makeFetchStub([
    listXml(['a.mp3'], { truncated: true, nextToken: 'tok2' }),
    listXml(['b.mp3'], { truncated: false }),
  ]);
  const p = new R2Prefetcher({ ...creds, fetchImpl: stub.fetchImpl, decodeImpl: decodeStub });
  assert.deepEqual(await p.listKeys(), ['a.mp3', 'b.mp3']);
  // 2 ページ目の list に continuation-token が乗ること
  assert.ok(stub.calls[1].includes('continuation-token=tok2'));
});

test('prefetchAll は mp3 のみを GET してデコード済み PCM をキー順で保持する', async () => {
  const stub = makeFetchStub([listXml(['b.mp3', 'a.mp3', 'note.txt'])]);
  const p = new R2Prefetcher({ ...creds, fetchImpl: stub.fetchImpl, decodeImpl: decodeStub });
  const { keys, pcms } = await p.prefetchAll();
  assert.deepEqual(keys, ['a.mp3', 'b.mp3']); // ソート済み・txt 除外
  assert.equal(p.getCount, 2);                // mp3 2 本ぶんだけ GET
  assert.equal(pcms[0].toString(), 'pcm:bytes:a.mp3');
  assert.equal(pcms[1].toString(), 'pcm:bytes:b.mp3');
});

test('prefetchAll({limit}) は先頭 N 曲だけ取得する', async () => {
  const stub = makeFetchStub([listXml(['a.mp3', 'b.mp3', 'c.mp3'])]);
  const p = new R2Prefetcher({ ...creds, fetchImpl: stub.fetchImpl, decodeImpl: decodeStub });
  const { keys } = await p.prefetchAll({ limit: 2 });
  assert.deepEqual(keys, ['a.mp3', 'b.mp3']);
  assert.equal(p.getCount, 2);
});

test('list が非 200 なら例外を投げる', async () => {
  const fetchImpl = async () => new Response('nope', { status: 403 });
  const p = new R2Prefetcher({ ...creds, fetchImpl, decodeImpl: decodeStub });
  await assert.rejects(() => p.listKeys(), /R2 list failed: 403/);
});

test('object GET が非 200 なら例外を投げ getCount を増やさない', async () => {
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    if (u.searchParams.has('list-type')) return new Response(listXml(['a.mp3']), { status: 200 });
    return new Response('nope', { status: 500 });
  };
  const p = new R2Prefetcher({ ...creds, fetchImpl, decodeImpl: decodeStub });
  await assert.rejects(() => p.prefetchAll(), /R2 get failed/);
  assert.equal(p.getCount, 0); // 成功 GET 0
});

test('truncated なのに継続トークンが無ければ例外を投げる（黙って一部だけ返さない）', async () => {
  const fetchImpl = async () => new Response(listXml(['a.mp3'], { truncated: true }), { status: 200 });
  const p = new R2Prefetcher({ ...creds, fetchImpl, decodeImpl: decodeStub });
  await assert.rejects(() => p.listKeys(), /truncated but no NextContinuationToken/);
});

// 統合: 実 ffmpeg デコード → bgm.swap まで通し、切替が R2 フェッチ0・先頭からであることを確認する。
test('実バイト列をプリフェッチ→デコードし、切替は R2 GET 0・offset=0 で成立する', async () => {
  // object GET は実際の音声バイト列（assets/bgm.opus）を返す。key は .mp3 名だが ffmpeg は中身で判定する。
  const audio = readFileSync(new URL('./assets/bgm.opus', import.meta.url));
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    if (u.searchParams.has('list-type')) return new Response(listXml(['s1.mp3', 's2.mp3']), { status: 200 });
    return new Response(audio, { status: 200 });
  };
  const p = new R2Prefetcher({ ...creds, fetchImpl }); // 実 decodeBufferToPcm を使う
  const { keys, pcms } = await p.prefetchAll();
  assert.deepEqual(keys, ['s1.mp3', 's2.mp3']);
  assert.equal(p.getCount, 2);
  assert.ok(pcms[0].length > 0 && pcms[1].length > 0);

  const getCountAfterPrefetch = p.getCount;
  const bgm = new Bgm(pcms[0]);
  bgm.pull(480);                 // 再生位置を進める
  bgm.swap(pcms[1]);             // プリフェッチ済み配列から切替
  assert.equal(bgm.offset, 0);   // 先頭から
  assert.equal(p.getCount - getCountAfterPrefetch, 0); // 切替で R2 GET は発生しない
});
