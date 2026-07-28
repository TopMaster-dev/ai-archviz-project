import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { signUrlToken, verifyUrlToken } from './urlToken.js';

/**
 * 260728 敵対レビュー H1 の対策。
 *
 * 守りたい性質はひとつ:「サーバが提示していないURLは、絶対に取得対象にならない」。
 * ここが破れると /api/agent が任意の公開URLを取得する代行窓口（リクエスト・ロンダリング／
 * 増幅DoS の踏み台）になる。総当たり・改ざん・期限切れ・鍵替えのすべてで null に倒れること。
 */

const ENV_KEYS = ['URL_SIGNING_SECRET', 'GOOGLE_VISION_API_KEY', 'GOOGLE_CLOUD_VISION_API_KEY', 'VISION_API_KEY'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.URL_SIGNING_SECRET = 'test-secret';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
});

const URL_A = 'https://shop.example.jp/item/1';

describe('署名トークンの往復', () => {
  it('署名したURLはそのまま取り出せる', async () => {
    const token = await signUrlToken(URL_A);
    expect(token).toBeTruthy();
    expect(await verifyUrlToken(token)).toBe(URL_A);
  });

  it('URLはトークンから復元される（クライアントの申告を信じない）', async () => {
    const token = await signUrlToken('https://a.example/p');
    expect(await verifyUrlToken(token)).toBe('https://a.example/p');
  });

  it('http(s) 以外は署名しない', async () => {
    expect(await signUrlToken('javascript:alert(1)')).toBeNull();
    expect(await signUrlToken('file:///etc/passwd')).toBeNull();
    expect(await signUrlToken('')).toBeNull();
  });
});

describe('改ざん・偽造は必ず拒否する', () => {
  it('ペイロードだけ差し替えても通らない（別URLへのすり替え）', async () => {
    const token = (await signUrlToken(URL_A)) as string;
    const sig = token.slice(token.lastIndexOf('.') + 1);
    // 攻撃者が自分の狙ったURLでペイロードを作り直し、署名は元のまま流用する
    const forgedPayload = Buffer.from(
      JSON.stringify({ u: 'https://victim.example/internal', e: Date.now() + 10_000 }),
      'utf8',
    ).toString('base64url');
    expect(await verifyUrlToken(`${forgedPayload}.${sig}`)).toBeNull();
  });

  it('署名だけ差し替えても通らない', async () => {
    const token = (await signUrlToken(URL_A)) as string;
    const payload = token.slice(0, token.lastIndexOf('.'));
    expect(await verifyUrlToken(`${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`)).toBeNull();
  });

  it('署名の無い素のURLは受け付けない（これが本丸）', async () => {
    expect(await verifyUrlToken(URL_A)).toBeNull();
    expect(await verifyUrlToken('https://victim.example/x.y')).toBeNull();
  });

  it('壊れた形・型違いは拒否', async () => {
    for (const bad of ['', '.', 'abc', 'abc.', '.sig', null, undefined, 42, {}]) {
      expect(await verifyUrlToken(bad as unknown)).toBeNull();
    }
  });

  it('鍵が変われば以前のトークンは失効する', async () => {
    const token = await signUrlToken(URL_A);
    process.env.URL_SIGNING_SECRET = 'rotated-secret';
    expect(await verifyUrlToken(token)).toBeNull();
  });
});

describe('期限', () => {
  it('期限切れは拒否', async () => {
    const token = await signUrlToken(URL_A, 0); // 1970年に発行された扱い
    expect(await verifyUrlToken(token, Date.now())).toBeNull();
  });

  it('履歴が残る期間（数日後）はまだ使える', async () => {
    const now = Date.now();
    const token = await signUrlToken(URL_A, now);
    expect(await verifyUrlToken(token, now + 3 * 24 * 60 * 60 * 1000)).toBe(URL_A);
  });
});

describe('鍵の解決', () => {
  it('専用の環境変数が無ければ Vision キーから派生させる（新しい設定を増やさない）', async () => {
    delete process.env.URL_SIGNING_SECRET;
    process.env.GOOGLE_VISION_API_KEY = 'vision-key';
    const token = await signUrlToken(URL_A);
    expect(token).toBeTruthy();
    expect(await verifyUrlToken(token)).toBe(URL_A);
  });

  it('鍵が一切無ければ署名も検証もしない（フェイルクローズ）', async () => {
    delete process.env.URL_SIGNING_SECRET;
    expect(await signUrlToken(URL_A)).toBeNull();
    expect(await verifyUrlToken('anything.anything')).toBeNull();
  });
});
