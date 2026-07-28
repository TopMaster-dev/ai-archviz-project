import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  isFetchableUrl,
  isBlockedIpAddress,
  resolveHostAddresses,
  safeFetchPage,
  safeFetchPages,
} from './safeFetchPage.js';

/**
 * SSRF/DoS の砦なので、ここが緩むと本番のサーバ権限で内部アドレスを読まれる。
 * 「将来だれかが正規表現を雑に直しても即座に落ちる」ことを狙って、境界値まで含めて網羅する。
 */

// ---------------------------------------------------------------------------
// DNS 層のスタブ
//
// safeFetchPage は fetch の前に必ず名前解決するようになったので、DNS を差し替えないと
// ①テストが実ネットワークに依存して不安定になる、
// ②「公開ドメインの A レコードが私設 IP を指す」という攻撃そのものを再現できない。
// vi.hoisted で状態を作るのは、vi.mock のファクトリが巻き上げられて TDZ に当たるのを避けるため。
// ---------------------------------------------------------------------------

const dns = vi.hoisted(() => ({
  /** ホスト名 -> 返すアドレス列。未登録は既定の公開 IP を返す。 */
  addresses: new Map<string, string[]>(),
  /** true なら lookup 自体が失敗する（ENOTFOUND 相当）。 */
  fail: false,
  /** 既定＝公開 IP（example.com の実アドレス）。 */
  fallback: ['93.184.216.34'],
  calls: [] as string[],
}));

vi.mock('node:dns/promises', () => ({
  lookup: async (hostname: string, _opts?: unknown) => {
    dns.calls.push(hostname);
    if (dns.fail) {
      const err = new Error('getaddrinfo ENOTFOUND') as Error & { code?: string };
      err.code = 'ENOTFOUND';
      throw err;
    }
    const list = dns.addresses.get(hostname) ?? dns.fallback;
    return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  },
}));

beforeEach(() => {
  dns.addresses.clear();
  dns.fail = false;
  dns.calls = [];
});

// ---------------------------------------------------------------------------
// テスト用の Response ダミー（jsdom には fetch/Headers が無いので構造だけ真似る）
// ---------------------------------------------------------------------------

function fakeHeaders(map: Record<string, string>): Headers {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v;
  return {
    get: (name: string): string | null => lower[name.toLowerCase()] ?? null,
  } as unknown as Headers;
}

interface FakeStream {
  stream: unknown;
  wasCancelled: () => boolean;
  readCount: () => number;
}

/** チャンクを順に吐く疑似 ReadableStream。cancel されたかどうかを観測できるようにする。 */
function fakeStream(chunks: Uint8Array[]): FakeStream {
  let index = 0;
  let cancelled = false;
  let reads = 0;
  const stream = {
    getReader: () => ({
      read: async () => {
        reads += 1;
        if (cancelled || index >= chunks.length) return { done: true, value: undefined };
        const value = chunks[index];
        index += 1;
        return { done: false, value };
      },
      cancel: async () => {
        cancelled = true;
      },
      releaseLock: () => {},
    }),
  };
  return { stream, wasCancelled: () => cancelled, readCount: () => reads };
}

function fakeResponse(init: {
  status?: number;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  text?: string;
}): Response {
  return {
    status: init.status ?? 200,
    url: init.url ?? '',
    headers: fakeHeaders(init.headers ?? {}),
    body: init.body ?? null,
    text: async () => init.text ?? '',
  } as unknown as Response;
}

function htmlResponse(html: string, url: string, status = 200): Response {
  return fakeResponse({
    status,
    url,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: fakeStream([new TextEncoder().encode(html)]).stream,
    text: html,
  });
}

function redirectResponse(location: string, status = 302): Response {
  return fakeResponse({ status, headers: { location } });
}

function stubFetch(impl: (url: string) => Promise<Response>) {
  const mock = vi.fn(async (input: unknown, _init?: RequestInit) => impl(String(input)));
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// isFetchableUrl
// ---------------------------------------------------------------------------

describe('isFetchableUrl: 通してよい URL', () => {
  const allowed = [
    'https://www.karimoku.co.jp/item/1',
    'http://example.jp/a?b=1',
    'https://shop.example.com/p/1#detail',
    'https://example.com:8443/p/1', // ポートは制限しない（内部ホストはホスト名側で落ちるため）
    'http://172.32.0.1/', // 172.16.0.0/12 の外＝公開レンジ（境界）
    'http://100.63.255.255/', // 100.64.0.0/10 の外（境界）
    'http://11.0.0.1/', // 10.0.0.0/8 の外（境界）
    'https://[2404:6800:4004:800::200e]/', // 公開 IPv6
  ];
  for (const url of allowed) {
    it(`許可: ${url}`, () => {
      expect(isFetchableUrl(url)).toBe(true);
    });
  }
});

describe('isFetchableUrl: 拒否すべき URL', () => {
  const blocked: Array<[string, string]> = [
    ['非 http スキーム', 'javascript:alert(1)'],
    ['非 http スキーム', 'data:text/html,<b>x</b>'],
    ['非 http スキーム', 'file:///etc/passwd'],
    ['非 http スキーム', 'ftp://example.com/a.txt'],
    ['非 http スキーム', 'about:blank'],
    ['認証情報つき', 'https://user:pass@example.com'],
    ['認証情報つき', 'http://admin:@example.com/'],
    ['ループバック', 'http://127.0.0.1/'],
    ['ループバック', 'http://127.1.2.3:8080/x'],
    ['ループバック(10進表記)', 'http://2130706433/'],
    ['ループバック(8進表記)', 'http://0177.0.0.1/'],
    ['0.0.0.0/8', 'http://0.0.0.0/'],
    ['10.0.0.0/8', 'http://10.1.2.3/'],
    ['172.16.0.0/12', 'http://172.16.0.1/'],
    ['172.16.0.0/12', 'http://172.31.255.254/'],
    ['192.168.0.0/16', 'http://192.168.1.1/'],
    ['169.254.0.0/16', 'http://169.254.0.1/'],
    ['クラウドメタデータ', 'http://169.254.169.254/latest/meta-data/'],
    ['100.64.0.0/10 (CGNAT)', 'http://100.64.0.1/'],
    ['100.64.0.0/10 (CGNAT)', 'http://100.127.255.255/'],
    ['IPv6 ループバック', 'http://[::1]/'],
    ['IPv6 未指定', 'http://[::]/'],
    ['fc00::/7', 'http://[fc00::1]/'],
    ['fc00::/7', 'http://[fd12:3456:789a::1]/'],
    ['fe80::/10', 'http://[fe80::1]/'],
    ['IPv4-mapped IPv6', 'https://[::ffff:127.0.0.1]/'],
    ['IPv4-mapped IPv6(16進正規化形)', 'https://[::ffff:7f00:1]/'],
    ['IPv4-mapped IPv6', 'https://[::ffff:169.254.169.254]/'],
    ['URL ですらない', '::ffff:127.0.0.1'],
    ['localhost', 'https://localhost'],
    ['localhost(末尾ドット)', 'https://localhost./'],
    ['localhost 大文字', 'https://LOCALHOST/'],
    ['.localhost', 'https://api.localhost/x'],
    ['.local (mDNS)', 'https://printer.local/'],
    ['.internal', 'https://db.internal/'],
    ['GCP メタデータ名', 'https://metadata.google.internal/computeMetadata/v1/'],
    ['単一ラベル（社内 DNS に解決される）', 'https://intranet'],
    ['単一ラベル', 'http://instance-data/latest/'],
    ['空文字', ''],
    ['空白のみ', '   '],
    ['URL でない文字列', 'not a url'],
    ['相対パス', '/item/1'],
  ];
  for (const [why, url] of blocked) {
    it(`拒否(${why}): ${JSON.stringify(url)}`, () => {
      expect(isFetchableUrl(url)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// isBlockedIpAddress（DNS が返したアドレスの判定）
// ---------------------------------------------------------------------------

describe('isBlockedIpAddress', () => {
  const blocked = [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254', // クラウドメタデータ
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ];
  for (const ip of blocked) {
    it(`内部と判定: ${ip}`, () => {
      expect(isBlockedIpAddress(ip)).toBe(true);
    });
  }

  const allowed = ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'];
  for (const ip of allowed) {
    it(`公開と判定: ${ip}`, () => {
      expect(isBlockedIpAddress(ip)).toBe(false);
    });
  }

  it('IP として解釈できない入力は危険側（true）へ倒す', () => {
    // 「わからないものは通さない」。ここを false にすると解決結果の細工で穴が開く。
    expect(isBlockedIpAddress('')).toBe(true);
    expect(isBlockedIpAddress('   ')).toBe(true);
    expect(isBlockedIpAddress('not-an-ip')).toBe(true);
    expect(isBlockedIpAddress('999.1.1.1')).toBe(true);
    expect(isBlockedIpAddress(undefined as unknown as string)).toBe(true);
  });

  it('大文字・[] 囲み・末尾ドットでも判定が崩れない', () => {
    expect(isBlockedIpAddress('FE80::1')).toBe(true);
    expect(isBlockedIpAddress('[::1]')).toBe(true);
    expect(isBlockedIpAddress('127.0.0.1.')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveHostAddresses
// ---------------------------------------------------------------------------

describe('resolveHostAddresses', () => {
  it('解決結果を全件返す（1 件目だけ見ない）', async () => {
    dns.addresses.set('multi.example.com', ['93.184.216.34', '10.0.0.5']);
    await expect(resolveHostAddresses('multi.example.com')).resolves.toEqual([
      '93.184.216.34',
      '10.0.0.5',
    ]);
  });

  it('DNS が失敗しても throw せず空配列', async () => {
    dns.fail = true;
    await expect(resolveHostAddresses('example.jp')).resolves.toEqual([]);
  });

  it('空ホスト名は解決しに行かない', async () => {
    await expect(resolveHostAddresses('')).resolves.toEqual([]);
    expect(dns.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// safeFetchPage: DNS 層（文字列検査をすり抜ける SSRF の本命）
// ---------------------------------------------------------------------------

describe('safeFetchPage: DNS 解決による SSRF 防御', () => {
  it('公開ドメインでも A レコードがメタデータ IP なら blocked-dns、fetch は一度も呼ばれない', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    dns.addresses.set('meta.attacker.com', ['169.254.169.254']);
    const mock = stubFetch(async (url) => htmlResponse('<html>SECRET</html>', url));

    const res = await safeFetchPage('https://meta.attacker.com/whatever');

    expect(res).toMatchObject({ ok: false, reason: 'blocked-dns' });
    expect(mock).not.toHaveBeenCalled(); // 取得前に止まっていること
    expect(errorSpy).toHaveBeenCalled(); // 進行中の攻撃なのでログに残す
  });

  it('私設 IPv4 に解決される公開ドメインも拒否', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    dns.addresses.set('intranet.attacker.com', ['10.1.2.3']);
    const mock = stubFetch(async (url) => htmlResponse('<html>x</html>', url));

    const res = await safeFetchPage('https://intranet.attacker.com/');

    expect(res).toMatchObject({ ok: false, reason: 'blocked-dns' });
    expect(mock).not.toHaveBeenCalled();
  });

  it('私設 IPv6 に解決される公開ドメインも拒否', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    dns.addresses.set('v6.attacker.com', ['fd12:3456:789a::1']);
    const mock = stubFetch(async (url) => htmlResponse('<html>x</html>', url));

    const res = await safeFetchPage('https://v6.attacker.com/');

    expect(res).toMatchObject({ ok: false, reason: 'blocked-dns' });
    expect(mock).not.toHaveBeenCalled();
  });

  it('公開 IP と私設 IP を併記したホストは拒否（全件検査していること）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // 1 件目だけ見る実装だと通ってしまう並び
    dns.addresses.set('mixed.attacker.com', ['93.184.216.34', '169.254.169.254']);
    const mock = stubFetch(async (url) => htmlResponse('<html>SECRET</html>', url));

    const res = await safeFetchPage('https://mixed.attacker.com/');

    expect(res).toMatchObject({ ok: false, reason: 'blocked-dns' });
    expect(mock).not.toHaveBeenCalled();
  });

  it('DNS が失敗したら fetch しない（検証できないものは取りに行かない）', async () => {
    dns.fail = true;
    const mock = stubFetch(async (url) => htmlResponse('<html>ok</html>', url));

    const res = await safeFetchPage('https://example.jp/p/1');

    expect(res).toMatchObject({ ok: false, reason: 'network' });
    expect(mock).not.toHaveBeenCalled();
  });

  it('DNS が空配列でも fetch しない', async () => {
    dns.addresses.set('empty.example.jp', []);
    const mock = stubFetch(async (url) => htmlResponse('<html>ok</html>', url));

    const res = await safeFetchPage('https://empty.example.jp/p/1');

    expect(res).toMatchObject({ ok: false, reason: 'network' });
    expect(mock).not.toHaveBeenCalled();
  });

  it('リダイレクト先ホストが私設 IP に解決されるなら 2 回目の fetch 前に止める', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const evil = 'https://internal.attacker.com/admin';
    dns.addresses.set('internal.attacker.com', ['10.0.0.5']);
    const mock = stubFetch(async (url) => {
      if (url === 'https://shop.example.com/p/1') return redirectResponse(evil);
      return htmlResponse('<html>SECRET</html>', url);
    });

    const res = await safeFetchPage('https://shop.example.com/p/1');

    expect(res).toMatchObject({ ok: false, reason: 'blocked-dns' });
    expect(mock).toHaveBeenCalledTimes(1); // 内部ホストへの 2 回目は起きていない
    expect(mock.mock.calls.map((c) => String(c[0]))).not.toContain(evil);
  });

  it('公開 IP に解決される通常のホストは従来どおり取得できる（回帰）', async () => {
    dns.addresses.set('www.karimoku.co.jp', ['203.0.113.10']);
    const html = '<html><body>いす 12,000円</body></html>';
    const mock = stubFetch(async (url) => htmlResponse(html, url));

    const res = await safeFetchPage('https://www.karimoku.co.jp/item/1');

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.html).toBe(html);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(dns.calls).toContain('www.karimoku.co.jp');
  });

  it('文字列検査で落ちる URL では DNS も引かない（無駄な名前解決をしない）', async () => {
    const mock = stubFetch(async (url) => htmlResponse('<html></html>', url));
    const res = await safeFetchPage('http://169.254.169.254/latest/meta-data/');
    expect(res).toMatchObject({ ok: false, reason: 'blocked-url' });
    expect(mock).not.toHaveBeenCalled();
    expect(dns.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// safeFetchPage
// ---------------------------------------------------------------------------

describe('safeFetchPage', () => {
  it('200 + text/html なら HTML と finalUrl を返す', async () => {
    const html = '<html><body>いす 12,000円</body></html>';
    const mock = stubFetch(async (url) => htmlResponse(html, url));

    const res = await safeFetchPage('https://www.karimoku.co.jp/item/1');

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.html).toBe(html);
    expect(res.finalUrl).toBe('https://www.karimoku.co.jp/item/1');
    expect(res.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('Cookie/認証を送らず、正体を明かす UA と text/html を要求する', async () => {
    const mock = stubFetch(async (url) => htmlResponse('<html></html>', url));
    await safeFetchPage('https://example.jp/p/1');

    const init = mock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(init.redirect).toBe('manual'); // follow だと SSRF 検査をすり抜ける
    expect(headers['User-Agent']).toBeTruthy();
    expect(headers.Accept).toContain('text/html');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('cookie');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('302 で内部 IP に飛ばされたら blocked-host、かつそのホストへは fetch しない', async () => {
    const evil = 'http://169.254.169.254/latest/meta-data/';
    const mock = stubFetch(async (url) => {
      if (url === 'https://shop.example.com/p/1') return redirectResponse(evil);
      return htmlResponse('<html>SECRET</html>', url);
    });

    const res = await safeFetchPage('https://shop.example.com/p/1');

    expect(res).toMatchObject({ ok: false, reason: 'blocked-host' });
    expect(mock).toHaveBeenCalledTimes(1); // 2 回目＝メタデータへの取得は起きていない
    const requested = mock.mock.calls.map((c) => String(c[0]));
    expect(requested).not.toContain(evil);
    expect(requested.some((u) => u.includes('169.254.169.254'))).toBe(false);
  });

  it('相対 Location で内部ホストへ誘導されても検査する（絶対 URL に解決してから判定）', async () => {
    const mock = stubFetch(async (url) => {
      if (url === 'https://shop.example.com/p/1') return redirectResponse('/p/2');
      return htmlResponse('<html>ok</html>', url);
    });

    const res = await safeFetchPage('https://shop.example.com/p/1');

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.finalUrl).toBe('https://shop.example.com/p/2');
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('Location が data: など非 http なら blocked-host', async () => {
    stubFetch(async () => redirectResponse('data:text/html,<b>x</b>'));
    const res = await safeFetchPage('https://shop.example.com/p/1');
    expect(res).toMatchObject({ ok: false, reason: 'blocked-host' });
  });

  it('3 ホップを超えるリダイレクト連鎖は失敗（無限ループで関数を占有させない）', async () => {
    let n = 0;
    const mock = stubFetch(async () => {
      n += 1;
      return redirectResponse(`https://shop.example.com/hop/${n}`);
    });

    const res = await safeFetchPage('https://shop.example.com/hop/0');

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('bad-status');
    expect(mock).toHaveBeenCalledTimes(4); // 初回 + 3 ホップまで
  });

  it('404 は bad-status（ステータスも返す）', async () => {
    stubFetch(async (url) =>
      fakeResponse({ status: 404, url, headers: { 'content-type': 'text/html' } }),
    );
    const res = await safeFetchPage('https://example.jp/missing');
    expect(res).toMatchObject({ ok: false, reason: 'bad-status', status: 404 });
  });

  it('application/pdf は not-html（PDF を HTML として解析させない）', async () => {
    stubFetch(async (url) =>
      fakeResponse({
        status: 200,
        url,
        headers: { 'content-type': 'application/pdf' },
        body: fakeStream([new TextEncoder().encode('%PDF-1.7')]).stream,
      }),
    );
    const res = await safeFetchPage('https://example.jp/spec.pdf');
    expect(res).toMatchObject({ ok: false, reason: 'not-html', status: 200 });
  });

  it('Content-Type が無い応答も not-html（推測して解析しない）', async () => {
    stubFetch(async (url) => fakeResponse({ status: 200, url, text: '<html></html>' }));
    const res = await safeFetchPage('https://example.jp/unknown');
    expect(res).toMatchObject({ ok: false, reason: 'not-html' });
  });

  it('application/xhtml+xml は受け入れる', async () => {
    stubFetch(async (url) =>
      fakeResponse({
        status: 200,
        url,
        headers: { 'content-type': 'application/xhtml+xml' },
        body: fakeStream([new TextEncoder().encode('<html>x</html>')]).stream,
      }),
    );
    const res = await safeFetchPage('https://example.jp/x');
    expect(res.ok).toBe(true);
  });

  it('maxBytes を超える本文は too-large、かつ全部読まずに打ち切る', async () => {
    const chunk = new Uint8Array(1024).fill(65); // 'A' × 1024
    const stream = fakeStream([chunk, chunk, chunk, chunk, chunk, chunk, chunk, chunk]);
    stubFetch(async (url) =>
      fakeResponse({
        status: 200,
        url,
        headers: { 'content-type': 'text/html' },
        body: stream.stream,
      }),
    );

    const res = await safeFetchPage('https://example.jp/huge', { maxBytes: 2048 });

    expect(res).toMatchObject({ ok: false, reason: 'too-large' });
    expect(stream.wasCancelled()).toBe(true); // 残りをダウンロードしていない（OOM 防止の要）
    expect(stream.readCount()).toBeLessThan(8);
  });

  it('本文が上限ぎりぎりなら成功する（境界）', async () => {
    const body = 'a'.repeat(2048);
    stubFetch(async (url) =>
      fakeResponse({
        status: 200,
        url,
        headers: { 'content-type': 'text/html' },
        body: fakeStream([new TextEncoder().encode(body)]).stream,
      }),
    );
    const res = await safeFetchPage('https://example.jp/edge', { maxBytes: 2048 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.html).toHaveLength(2048);
  });

  it('body が無い応答は text() にフォールバックし、上限で切り詰める', async () => {
    stubFetch(async (url) =>
      fakeResponse({
        status: 200,
        url,
        headers: { 'content-type': 'text/html' },
        text: 'b'.repeat(5000),
      }),
    );
    const res = await safeFetchPage('https://example.jp/notstream', { maxBytes: 1500 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.html).toHaveLength(1500);
  });

  it('AbortError は timeout', async () => {
    stubFetch(async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    const res = await safeFetchPage('https://example.jp/slow', { timeoutMs: 300 });
    expect(res).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('その他の例外は network（throw させない）', async () => {
    stubFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    const res = await safeFetchPage('https://example.jp/down');
    expect(res).toMatchObject({ ok: false, reason: 'network' });
  });

  it('ブロック対象の URL では fetch を 1 度も呼ばない', async () => {
    const mock = stubFetch(async (url) => htmlResponse('<html></html>', url));
    const res = await safeFetchPage('http://169.254.169.254/latest/meta-data/');
    expect(res).toMatchObject({ ok: false, reason: 'blocked-url' });
    expect(mock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// safeFetchPages
// ---------------------------------------------------------------------------

describe('safeFetchPages', () => {
  it('limit 本までしか取得しない（エージェント応答のファンアウト防止）', async () => {
    const mock = stubFetch(async (url) => htmlResponse('<html>ok</html>', url));
    const urls = Array.from({ length: 8 }, (_, i) => `https://example.jp/p/${i}`);

    const out = await safeFetchPages(urls, { limit: 3 });

    expect(out).toHaveLength(3);
    expect(mock).toHaveBeenCalledTimes(3);
    expect(out.map((r) => r.url)).toEqual([
      'https://example.jp/p/0',
      'https://example.jp/p/1',
      'https://example.jp/p/2',
    ]);
  });

  it('既定の limit は 6 本', async () => {
    const mock = stubFetch(async (url) => htmlResponse('<html>ok</html>', url));
    const urls = Array.from({ length: 20 }, (_, i) => `https://example.jp/p/${i}`);
    const out = await safeFetchPages(urls);
    expect(out).toHaveLength(6);
    expect(mock).toHaveBeenCalledTimes(6);
  });

  it('完了順がばらついても入力順を保つ', async () => {
    const delays: Record<string, number> = {
      'https://example.jp/a': 30,
      'https://example.jp/b': 5,
      'https://example.jp/c': 20,
      'https://example.jp/d': 0,
    };
    stubFetch(async (url) => {
      await new Promise((r) => setTimeout(r, delays[url] ?? 0));
      return htmlResponse(`<html>${url}</html>`, url);
    });

    const out = await safeFetchPages(
      [
        'https://example.jp/a',
        'https://example.jp/b',
        'https://example.jp/c',
        'https://example.jp/d',
      ],
      { concurrency: 4 },
    );

    expect(out.map((r) => r.url)).toEqual([
      'https://example.jp/a',
      'https://example.jp/b',
      'https://example.jp/c',
      'https://example.jp/d',
    ]);
    expect(out.every((r) => r.result.ok)).toBe(true);
  });

  it('一部が失敗しても reject せず、URL ごとに理由を返す', async () => {
    stubFetch(async (url) => {
      if (url.includes('/404')) return fakeResponse({ status: 404, url, headers: {} });
      if (url.includes('/boom')) throw new Error('socket hang up');
      return htmlResponse('<html>ok</html>', url);
    });

    const out = await safeFetchPages([
      'https://example.jp/ok',
      'http://127.0.0.1/secret', // fetch に到達すらしない
      'https://example.jp/404',
      'https://example.jp/boom',
    ]);

    expect(out.map((r) => r.result.ok)).toEqual([true, false, false, false]);
    expect(out[1].result).toMatchObject({ ok: false, reason: 'blocked-url' });
    expect(out[2].result).toMatchObject({ ok: false, reason: 'bad-status', status: 404 });
    expect(out[3].result).toMatchObject({ ok: false, reason: 'network' });
  });

  it('同時実行数を超えて並列に走らせない', async () => {
    let inFlight = 0;
    let peak = 0;
    stubFetch(async (url) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return htmlResponse('<html>ok</html>', url);
    });

    await safeFetchPages(
      Array.from({ length: 6 }, (_, i) => `https://example.jp/p/${i}`),
      { concurrency: 2 },
    );

    expect(peak).toBeLessThanOrEqual(2);
  });

  it('空配列は空配列（fetch を呼ばない）', async () => {
    const mock = stubFetch(async (url) => htmlResponse('<html></html>', url));
    expect(await safeFetchPages([])).toEqual([]);
    expect(mock).not.toHaveBeenCalled();
  });
});
