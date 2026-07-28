import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { safeFetchImage, safeFetchPage } from './safeFetchPage.js';

/**
 * 実際にソケットを開いて確かめる統合テスト（260728）。
 *
 * 他のテストは fetch をモックしているので「我々のコードが何を呼ぶつもりか」しか検証できない。
 * SSRF ゲートで本当に大事なのは「本当に繋がる先が目の前にあっても、繋ぎに行かないこと」。
 * そこでローカルに実サーバを立て、リクエストが 1 本も届かないことをサーバ側の計測で確認する。
 * （届いてしまったら、それは本番なら社内アドレスやクラウドのメタデータに届いたということ）
 */

let server: http.Server;
let port = 0;
let hits: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url || '');
    if ((req.url || '').endsWith('.png')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      // 最小の PNG シグネチャ（中身は問わない。届いたかどうかだけが論点）
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>secret internal page</title></head><body>internal</body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('実サーバに対する SSRF ゲート（本当に繋がる先でも繋ぎに行かない）', () => {
  it('ループバックの画像URLへは 1 本もリクエストが飛ばない', async () => {
    hits = [];
    const result = await safeFetchImage(`http://127.0.0.1:${port}/secret.png`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('blocked-url');
    expect(hits).toEqual([]); // サーバは待ち受けているのに、届いていない
  });

  it('ループバックのページURLへも 1 本も飛ばない（既存経路の再確認）', async () => {
    hits = [];
    const result = await safeFetchPage(`http://127.0.0.1:${port}/internal`);
    expect(result.ok).toBe(false);
    expect(hits).toEqual([]);
  });

  it('localhost 表記でも、別表記の 127.1 でも塞がっている', async () => {
    hits = [];
    for (const host of ['localhost', '127.1', '0.0.0.0', '[::1]']) {
      const result = await safeFetchImage(`http://${host}:${port}/secret.png`);
      expect(result.ok).toBe(false);
    }
    expect(hits).toEqual([]);
  });

  it('サーバ自体は生きている（テストが「誰も待ち受けていないから通らなかった」でないことの確認）', async () => {
    hits = [];
    const res = await fetch(`http://127.0.0.1:${port}/secret.png`);
    expect(res.status).toBe(200);
    expect(hits).toEqual(['/secret.png']); // 素の fetch なら当然届く
  });
});
