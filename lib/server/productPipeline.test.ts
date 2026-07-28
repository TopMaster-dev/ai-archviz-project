import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { resolveProductsFromUrls } from './productResolver.js';
import { mergeResolvedIntoRecommendations } from './visionProductSearchCore.js';

/**
 * 260728 クライアント要望②③のエンドツーエンド検証。
 *
 * 「Vision が返した実在ページURL → サーバでページ取得 → 構造化データから
 *   商品名/メーカー/価格/品番/サムネイル/個別URL を確定 → 推薦カードへ反映」
 * が本当に通るかを、ネットワークだけ差し替えて実際に走らせる。
 *
 * ここが緑なら「実装されているか」は証明できる。実際に値が出るかは、
 * 相手サイトが構造化データを持っているかに依存する（その差もテストで明示する）。
 */

// DNS は実際に引かない（safeFetchPage は取得前に解決結果を検査する）。
vi.mock('node:dns/promises', () => ({
  lookup: async (hostname: string) => {
    if (hostname.includes('blocked')) return [{ address: '10.0.0.5', family: 4 }];
    return [{ address: '93.184.216.34', family: 4 }];
  },
}));

const htmlResponse = (html: string, url: string) =>
  ({
    ok: true,
    status: 200,
    url,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    body: null,
    text: async () => html,
  }) as unknown as Response;

/** 実在ECサイト相当（schema.org/Product あり）。 */
const PRODUCT_PAGE = `<!doctype html><html><head>
<title>カリモク60 Kチェア | 公式</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product",
 "name":"カリモク60 Kチェア2シーター",
 "brand":{"@type":"Brand","name":"カリモク家具"},
 "sku":"K-CHAIR-2S",
 "image":"https://img.example.jp/kchair.jpg",
 "offers":{"@type":"Offer","price":"98000","priceCurrency":"JPY","availability":"https://schema.org/InStock"}}
</script></head><body><h1>Kチェア</h1></body></html>`;

/** まとめ記事（構造化データ無し・OGPのみ）＝商品ページではない。 */
const ARTICLE_PAGE = `<!doctype html><html><head>
<title>【2026年版】おしゃれなソファおすすめ20選</title>
<meta property="og:title" content="【2026年版】おしゃれなソファおすすめ20選">
<meta property="og:image" content="https://img.example.jp/mag.jpg">
</head><body><article>まとめ記事</article></body></html>`;

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('②③ パイプライン（ページ取得→構造化抽出→推薦へ反映）', () => {
  it('商品ページから 商品名/メーカー/価格/品番/サムネイル/個別URL を全て取得する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => htmlResponse(PRODUCT_PAGE, String(url))),
    );

    const resolved = await resolveProductsFromUrls(['https://shop.example.jp/item/kchair']);

    expect(resolved).toHaveLength(1);
    const p = resolved[0];
    expect(p.name).toBe('カリモク60 Kチェア2シーター'); // 商品名
    expect(p.brand).toBe('カリモク家具'); // メーカー名
    expect(p.price).toBe(98000); // 価格
    expect(p.sku).toBe('K-CHAIR-2S'); // 品番
    expect(p.imageUrl).toBe('https://img.example.jp/kchair.jpg'); // サムネイル
    expect(p.finalUrl).toBe('https://shop.example.jp/item/kchair'); // 個別URL（到達確認済み）
    expect(p.availability).toContain('InStock');
  });

  it('取得した確定値が推薦カードの各項目へ反映される（見積へそのまま渡る形）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => htmlResponse(PRODUCT_PAGE, String(url))));
    const resolved = await resolveProductsFromUrls(['https://shop.example.jp/item/kchair']);

    // モデルは名前しか返せていない想定。実測値で埋まることを確認する。
    const cards = mergeResolvedIntoRecommendations(
      [{ name: '椅子', productUrl: 'https://shop.example.jp/guess' }],
      resolved,
    );
    const card = cards[0];
    expect(card.name).toBe('カリモク60 Kチェア2シーター');
    expect(card.brand).toBe('カリモク家具');
    expect(card.price).toBe(98000);
    expect(card.modelNumber).toBe('K-CHAIR-2S');
    expect(card.imageUrl).toBe('https://img.example.jp/kchair.jpg');
    expect(card.productUrl).toBe('https://shop.example.jp/item/kchair');
    expect(card.verified).toBe(true); // 「商品ページ確認済み」バッジの根拠
  });

  it('まとめ記事は商品として提示しない（記事URLを個別商品URLにしない）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => htmlResponse(ARTICLE_PAGE, String(url))));
    const resolved = await resolveProductsFromUrls(['https://mag.example.jp/archives/12345']);
    expect(resolved).toHaveLength(0);
  });

  it('到達できないURLは提示しない（リンク切れを出さない）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        url: 'https://shop.example.jp/gone',
        headers: new Headers({ 'content-type': 'text/html' }),
        body: null,
        text: async () => '',
      }) as unknown as Response),
    );
    const resolved = await resolveProductsFromUrls(['https://shop.example.jp/gone']);
    expect(resolved).toHaveLength(0);
  });

  it('内部アドレスへ解決されるURLは取得しない（SSRF防御が効いている）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const resolved = await resolveProductsFromUrls(['https://blocked.example.jp/p']);
    expect(resolved).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
