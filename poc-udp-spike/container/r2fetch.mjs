import { AwsClient } from 'aws4fetch';
import { decodeBufferToPcm } from './bgm.mjs';

// PoC-3（BGM プレイリスト）: 起動時に R2 バケットの全曲を取得しデコード済み PCM で保持する。
// コンテナは Worker ではないため R2 バインディングを使えず、S3 互換 API を aws4fetch(SigV4) で
// 直叩きする（endpoint https://<ACCOUNT_ID>.r2.cloudflarestorage.com、region=auto）。
// 資格情報（R2 API トークンから発行した Access Key ID / Secret Access Key）は
// wrangler secret → worker.ts の envVars 経由でコンテナ環境変数として渡る。
//
// 「切替時に R2 フェッチが発生しない」ことを検証するため GET 回数を getCount で数える。
// 切替はプリフェッチ済みの PCM 配列を差し替えるだけなので、切替中に getCount は増えない。

// ListObjectsV2 の XML から <Key> を取り出す。PoC のキー名は制御下（英数と拡張子）なので
// 単純な正規表現で十分。エンティティは基本的なものだけ戻す。
function parseKeys(xml) {
  const keys = [];
  for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
    keys.push(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  }
  return keys;
}

// truncated でなければ null。truncated なのにトークンが無いのは異常なので投げる
// （黙って一部の曲だけ prefetch して成功扱いにしない＝フェイルファスト）。
function parseNextToken(xml) {
  if (!/<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml)) return null;
  const token = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1];
  if (!token) throw new Error('R2 list truncated but no NextContinuationToken');
  return token;
}

export class R2Prefetcher {
  // fetchImpl / decodeImpl はテスト差し替え用。既定は SigV4 署名付き fetch と ffmpeg デコード。
  constructor({ accountId, accessKeyId, secretAccessKey, bucket, fetchImpl, decodeImpl, concurrency = 4 }) {
    this.endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
    this.bucket = bucket;
    this.concurrency = concurrency;
    this.getCount = 0;
    this.decode = decodeImpl ?? decodeBufferToPcm;
    if (fetchImpl) {
      this.doFetch = fetchImpl;
    } else {
      const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
      this.doFetch = (url, init) => client.fetch(url, init);
    }
  }

  // バケットの全キーを list（1000 件超はページング）。
  async listKeys() {
    const keys = [];
    let token = null;
    do {
      const url = new URL(`${this.endpoint}/${this.bucket}`);
      url.searchParams.set('list-type', '2');
      if (token) url.searchParams.set('continuation-token', token);
      const res = await this.doFetch(url.toString());
      if (!res.ok) throw new Error(`R2 list failed: ${res.status}`);
      const xml = await res.text();
      keys.push(...parseKeys(xml));
      token = parseNextToken(xml);
    } while (token);
    return keys;
  }

  // 1 オブジェクトを GET してバイト列で返す。成功した GET 回数を数える
  // （切替中に成功 GET が 0 回であることの検証指標に使う）。
  async getObject(key) {
    const res = await this.doFetch(`${this.endpoint}/${this.bucket}/${encodeURIComponent(key)}`);
    if (!res.ok) throw new Error(`R2 get failed (${key}): ${res.status}`);
    this.getCount++;
    return Buffer.from(await res.arrayBuffer());
  }

  // 起動時プリフェッチ: list → mp3 のみをキー順に並列 GET → デコード済み PCM をキー順で保持。
  // limit 指定時は先頭 N 曲のみ（起動時間・メモリ曲線を N 段階で取るため）。
  async prefetchAll({ limit } = {}) {
    let keys = (await this.listKeys()).filter((k) => k.endsWith('.mp3')).sort();
    if (limit != null) keys = keys.slice(0, limit);

    const pcms = new Array(keys.length);
    let next = 0;
    const worker = async () => {
      while (next < keys.length) {
        const idx = next++;
        const bytes = await this.getObject(keys[idx]);
        pcms[idx] = await this.decode(bytes);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, keys.length) }, worker));
    return { keys, pcms };
  }
}
