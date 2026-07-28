import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { buildProductQuery, isCustomSearchConfigured, searchProductPages, findProductPageCandidates } from './customSearch.js';

/**
 * 260728 クライアント承認: Custom Search を「候補URLの供給源」として追加した。
 *
 * 重要な性質:
 *  - 未設定なら完全に無効（従来動作を一切変えない）＝キーが無い環境で壊れない。
 *  - 1リクエストのクエリ数に上限がある（従量課金なので費用が線形に増えないこと）。
 *  - ここが返すのは候補URLだけ。値の確定は productResolver（実ページ取得）が行う。
 */
const ENV_KEYS = ['GOOGLE_CUSTOM_SEARCH_API_KEY', 'GOOGLE_CUSTOM_SEARCH_CX'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  vi.unstubAllGlobals();
});

const okResponse = (items: unknown[]) =>
  ({ ok: true, status: 200, json: async () => ({ items }) }) as unknown as Response;

describe('buildProductQuery', () => {
  it('語を連結し、記号・重複・空を除く', () => {
    expect(buildProductQuery(['カリモク', 'Kチェア', undefined, ''])).toBe('カリモク Kチェア');
    expect(buildProductQuery(['ソファ', 'ソファ'])).toBe('ソファ'); // 重複除去
    expect(buildProductQuery(['a"b', 'c|d'])).toBe('a b c d'); // 記号除去
  });

  it('長すぎるクエリは切り詰める（ノイズと費用の抑制）', () => {
    expect(buildProductQuery(['あ'.repeat(500)]).length).toBeLessThanOrEqual(200);
  });

  it('全て空なら空文字（呼び出し側が検索をスキップできる）', () => {
    expect(buildProductQuery([undefined, '', '  '])).toBe('');
  });
});

describe('未設定時は完全に無効（既存動作を変えない）', () => {
  it('設定されていなければ configured=false', () => {
    delete process.env.GOOGLE_CUSTOM_SEARCH_API_KEY;
    delete process.env.GOOGLE_CUSTOM_SEARCH_CX;
    expect(isCustomSearchConfigured()).toBe(false);
  });

  it('片方だけでは有効にならない', () => {
    process.env.GOOGLE_CUSTOM_SEARCH_API_KEY = 'k';
    delete process.env.GOOGLE_CUSTOM_SEARCH_CX;
    expect(isCustomSearchConfigured()).toBe(false);
  });

  it('未設定なら検索せず空配列（fetch を呼ばない＝課金しない）', async () => {
    delete process.env.GOOGLE_CUSTOM_SEARCH_API_KEY;
    delete process.env.GOOGLE_CUSTOM_SEARCH_CX;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await findProductPageCandidates(['カリモク ソファ'])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('searchProductPages', () => {
  beforeEach(() => {
    process.env.GOOGLE_CUSTOM_SEARCH_API_KEY = 'test-key';
    process.env.GOOGLE_CUSTOM_SEARCH_CX = 'test-cx';
  });

  it('検索結果からURL・タイトル・参考サムネイルを取り出す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        okResponse([
          {
            link: 'https://shop.example.jp/item/1',
            title: 'Kチェア | ショップ',
            pagemap: { cse_thumbnail: [{ src: 'https://img.example.jp/t.jpg' }] },
          },
        ]),
      ),
    );
    const hits = await searchProductPages('カリモク Kチェア');
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('https://shop.example.jp/item/1');
    expect(hits[0].thumbnailUrl).toBe('https://img.example.jp/t.jpg');
  });

  it('http(s) 以外のリンクは捨てる', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse([{ link: 'javascript:alert(1)' }, { link: 'https://ok.example/p' }])),
    );
    expect((await searchProductPages('x')).map((h) => h.url)).toEqual(['https://ok.example/p']);
  });

  it('APIエラー・例外でも落ちず空配列（本体の応答を止めない）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 }) as unknown as Response));
    expect(await searchProductPages('x')).toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    expect(await searchProductPages('x')).toEqual([]);
  });

  it('空クエリでは検索しない', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await searchProductPages('   ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('findProductPageCandidates（費用の上限）', () => {
  beforeEach(() => {
    process.env.GOOGLE_CUSTOM_SEARCH_API_KEY = 'test-key';
    process.env.GOOGLE_CUSTOM_SEARCH_CX = 'test-cx';
  });

  it('クエリ数に上限がある（1リクエストで課金が増え続けない）', async () => {
    const fetchMock = vi.fn(async () => okResponse([{ link: 'https://a.example/p' }]));
    vi.stubGlobal('fetch', fetchMock);
    await findProductPageCandidates(['q1', 'q2', 'q3', 'q4', 'q5'], { maxQueries: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('同じURLは重複排除する', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse([{ link: 'https://same.example/p' }])));
    const hits = await findProductPageCandidates(['q1', 'q2']);
    expect(hits).toHaveLength(1);
  });

  it('重複クエリは1回にまとめる', async () => {
    const fetchMock = vi.fn(async () => okResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    await findProductPageCandidates(['同じ', '同じ', '同じ']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
