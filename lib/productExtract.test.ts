import { describe, it, expect } from 'vitest';
import { extractProductFromHtml, normalizePrice, absolutizeUrl } from './productExtract.js';

/**
 * 260728 クライアント要望:「商品名 / メーカー名 / 価格 / 品番 / 個別商品URL / サムネイル」を正確に出す。
 * ここは実ページのHTMLを解析する側のテスト（取得＝fetch は別モジュール）。
 * 相手は第三者サイトの壊れたHTMLと悪意あるHTMLなので、「落ちない・止まらない・嘘を作らない」を検証する。
 */

const PAGE_URL = 'https://shop.example.jp/items/sf-100?utm_source=agent';

/** <head> と <body> を与えて最小限のHTMLを組み立てる。 */
function page(head: string, body = '<h1>商品ページ</h1>'): string {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
}

function ldJson(json: string): string {
  return `<script type="application/ld+json">${json}</script>`;
}

describe('extractProductFromHtml — JSON-LD', () => {
  it('一般的な日本のECページ（Product + offers）から全項目を取り出す', () => {
    const html = page(
      `<title>カリモク 3人掛けソファ SF-100 | 家具ショップ</title>
       <link rel="canonical" href="https://shop.example.jp/items/sf-100">` +
        ldJson(`{
          "@context": "https://schema.org/",
          "@type": "Product",
          "name": "カリモク 3人掛けソファ SF-100",
          "brand": "カリモク",
          "sku": "SF-100-BR",
          "image": "/img/sf-100.jpg",
          "url": "https://shop.example.jp/items/sf-100",
          "offers": {
            "@type": "Offer",
            "price": "128000",
            "priceCurrency": "JPY",
            "availability": "https://schema.org/InStock"
          }
        }`),
    );

    expect(extractProductFromHtml(html, PAGE_URL)).toEqual({
      name: 'カリモク 3人掛けソファ SF-100',
      brand: 'カリモク',
      price: 128000,
      currency: 'JPY',
      sku: 'SF-100-BR',
      imageUrl: 'https://shop.example.jp/img/sf-100.jpg',
      // canonical が最優先（取得URLの utm パラメータは商品の個別URLではない）
      url: 'https://shop.example.jp/items/sf-100',
      availability: 'InStock',
      source: 'json-ld',
    });
  });

  it('@graph でラップされていても Product を見つける', () => {
    const html = page(
      ldJson(`{
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "BreadcrumbList", "itemListElement": [{ "@type": "ListItem", "name": "ソファ" }] },
          { "@type": "WebSite", "name": "家具ショップ" },
          {
            "@type": "Product",
            "name": "ラウンジチェア LC-10",
            "offers": { "@type": "Offer", "price": 48000, "priceCurrency": "JPY" }
          }
        ]
      }`),
    );
    const facts = extractProductFromHtml(html, PAGE_URL);
    expect(facts?.name).toBe('ラウンジチェア LC-10');
    expect(facts?.price).toBe(48000);
    expect(facts?.source).toBe('json-ld');
  });

  it('@type が配列（["Product","Thing"]）でも Product として扱う', () => {
    const html = page(
      ldJson(`{ "@type": ["Product", "Thing"], "name": "スツール ST-1", "sku": "ST-1" }`),
    );
    const facts = extractProductFromHtml(html, PAGE_URL);
    expect(facts?.name).toBe('スツール ST-1');
    expect(facts?.sku).toBe('ST-1');
  });

  it('配列トップレベルの JSON-LD でも Product を見つける', () => {
    const html = page(
      ldJson(`[
        { "@type": "Organization", "name": "家具ショップ" },
        { "@type": "Product", "name": "サイドテーブル SD-3" }
      ]`),
    );
    expect(extractProductFromHtml(html, PAGE_URL)?.name).toBe('サイドテーブル SD-3');
  });

  it('brand は文字列でもオブジェクト（{"@type":"Brand","name":...}）でも取れる', () => {
    const asString = page(ldJson(`{ "@type": "Product", "name": "椅子", "brand": "カリモク" }`));
    expect(extractProductFromHtml(asString, PAGE_URL)?.brand).toBe('カリモク');

    const asObject = page(
      ldJson(`{ "@type": "Product", "name": "椅子", "brand": { "@type": "Brand", "name": "カリモク" } }`),
    );
    expect(extractProductFromHtml(asObject, PAGE_URL)?.brand).toBe('カリモク');
  });

  it('image は文字列 / 配列 / {"url":...} のいずれでも絶対URLになる', () => {
    const asString = page(ldJson(`{ "@type": "Product", "name": "椅子", "image": "/a.jpg" }`));
    expect(extractProductFromHtml(asString, PAGE_URL)?.imageUrl).toBe('https://shop.example.jp/a.jpg');

    const asArray = page(
      ldJson(`{ "@type": "Product", "name": "椅子", "image": ["/a.jpg", "/b.jpg"] }`),
    );
    expect(extractProductFromHtml(asArray, PAGE_URL)?.imageUrl).toBe('https://shop.example.jp/a.jpg');

    const asObject = page(
      ldJson(
        `{ "@type": "Product", "name": "椅子", "image": { "@type": "ImageObject", "url": "https://cdn.example.jp/a.jpg" } }`,
      ),
    );
    expect(extractProductFromHtml(asObject, PAGE_URL)?.imageUrl).toBe('https://cdn.example.jp/a.jpg');
  });

  it('offers が配列なら先頭のオファーを採用する', () => {
    const html = page(
      ldJson(`{
        "@type": "Product",
        "name": "デスク DK-5",
        "offers": [
          { "@type": "Offer", "price": "98000", "priceCurrency": "JPY", "availability": "InStock" },
          { "@type": "Offer", "price": "120000", "priceCurrency": "JPY" }
        ]
      }`),
    );
    const facts = extractProductFromHtml(html, PAGE_URL);
    expect(facts?.price).toBe(98000);
    expect(facts?.availability).toBe('InStock'); // 素の単語もそのまま通す
  });

  it('品番は sku → mpn → model の順で拾う', () => {
    const mpn = page(ldJson(`{ "@type": "Product", "name": "棚", "mpn": "MPN-1" }`));
    expect(extractProductFromHtml(mpn, PAGE_URL)?.sku).toBe('MPN-1');

    const model = page(ldJson(`{ "@type": "Product", "name": "棚", "model": "MODEL-9" }`));
    expect(extractProductFromHtml(model, PAGE_URL)?.sku).toBe('MODEL-9');
  });

  it('在庫切れ（schema.org URL）を OutOfStock に正規化する', () => {
    const html = page(
      ldJson(`{
        "@type": "Product",
        "name": "ラグ RG-2",
        "offers": { "@type": "Offer", "price": "12800", "availability": "http://schema.org/OutOfStock" }
      }`),
    );
    expect(extractProductFromHtml(html, PAGE_URL)?.availability).toBe('OutOfStock');
  });

  it('壊れた JSON-LD が先にあっても例外を投げず、後続の正しい Product を採る', () => {
    const html = page(
      ldJson(`{ "@type": "Product", "name": "壊れた", }`) + // 末尾カンマ（実在サイトに頻出）
        ldJson(`{ this is not json at all }`) +
        ldJson(`{ "@type": "Product", "name": "正しい商品 OK-1", "sku": "OK-1" }`),
    );
    const facts = extractProductFromHtml(html, PAGE_URL);
    expect(facts?.name).toBe('正しい商品 OK-1');
    expect(facts?.sku).toBe('OK-1');
  });

  it('名前の無い Product は「使える結果」とみなさず次の手段（OGP）へ落ちる', () => {
    const html = page(
      ldJson(`{ "@type": "Product", "sku": "NO-NAME" }`) +
        `<meta property="og:title" content="名無し商品 NN-1">
         <meta property="product:price:amount" content="3000">`,
    );
    const facts = extractProductFromHtml(html, PAGE_URL);
    expect(facts?.source).toBe('ogp');
    expect(facts?.name).toBe('名無し商品 NN-1');
  });

  it('サムネイルが JSON-LD に無ければ og:image で補う', () => {
    const html = page(
      ldJson(`{ "@type": "Product", "name": "照明 LT-1" }`) +
        `<meta property="og:image" content="https://cdn.example.jp/lt-1.jpg">`,
    );
    expect(extractProductFromHtml(html, PAGE_URL)?.imageUrl).toBe('https://cdn.example.jp/lt-1.jpg');
  });

  it('JSON-LD 定番のスラッシュエスケープ（https:\\/\\/…）を正しく読む', () => {
    const html = page(
      ldJson(
        `{ "@type": "Product", "name": "ベンチ BN-2", "url": "https:\\/\\/shop.example.jp\\/items\\/bn-2", "image": "https:\\/\\/cdn.example.jp\\/bn-2.jpg" }`,
      ),
    );
    const facts = extractProductFromHtml(html, 'https://shop.example.jp/items/bn-2');
    expect(facts?.url).toBe('https://shop.example.jp/items/bn-2');
    expect(facts?.imageUrl).toBe('https://cdn.example.jp/bn-2.jpg');
  });

  it('JSON文字列内に生の </script> がある壊れたページでも落ちず OGP へ退避する', () => {
    // ブラウザ同様この時点で script が終わるため JSON-LD は読めない。落ちずに次の手段へ行くことが要件。
    const html = page(
      ldJson(`{ "@type": "Product", "name": "切れる商品", "description": "</script>" }`) +
        `<meta property="og:title" content="退避できた商品 FB-1">`,
    );
    const facts = extractProductFromHtml(html, PAGE_URL);
    expect(facts?.name).toBe('退避できた商品 FB-1');
    expect(facts?.source).toBe('ogp');
  });

  it('canonical も og:url も無ければ取得URLを個別商品URLにする', () => {
    const html = page(ldJson(`{ "@type": "Product", "name": "椅子 CH-1" }`));
    expect(extractProductFromHtml(html, 'https://shop.example.jp/items/ch-1')?.url).toBe(
      'https://shop.example.jp/items/ch-1',
    );
  });
});

describe('extractProductFromHtml — microdata', () => {
  it('microdata だけのページから抽出し source は microdata', () => {
    const body = `
      <div itemscope itemtype="https://schema.org/Product">
        <div itemprop="brand" itemscope itemtype="https://schema.org/Brand">
          <span itemprop="name">日進木工</span>
        </div>
        <h1 itemprop="name">オーク材 ダイニングテーブル DT-200</h1>
        <img itemprop="image" src="//cdn.example.jp/img/dt-200.jpg" alt="">
        <span itemprop="sku">DT-200-OAK</span>
        <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
          <meta itemprop="priceCurrency" content="JPY">
          <span itemprop="price" content="98000">¥98,000（税込）</span>
          <link itemprop="availability" href="https://schema.org/OutOfStock">
        </div>
        <a itemprop="url" href="/items/dt-200">商品ページ</a>
      </div>`;
    const html = page('<title>ダイニングテーブル | 家具ショップ</title>', body);

    expect(extractProductFromHtml(html, 'https://shop.example.jp/items/dt-200')).toEqual({
      // 入れ子の brand スコープ内の name を商品名と取り違えないこと（brand が先に出現している）
      name: 'オーク材 ダイニングテーブル DT-200',
      brand: '日進木工',
      price: 98000,
      currency: 'JPY',
      sku: 'DT-200-OAK',
      imageUrl: 'https://cdn.example.jp/img/dt-200.jpg',
      url: 'https://shop.example.jp/items/dt-200',
      availability: 'OutOfStock',
      source: 'microdata',
    });
  });

  it('content 属性が無ければ要素のテキストを値にする', () => {
    const body = `
      <div itemscope itemtype="http://schema.org/Product">
        <h1 itemprop="name">スツール <em>ST-9</em></h1>
        <div itemprop="offers" itemscope itemtype="http://schema.org/Offer">
          <span itemprop="price">12,800円</span>
        </div>
      </div>`;
    const facts = extractProductFromHtml(page('', body), PAGE_URL);
    expect(facts?.name).toBe('スツール ST-9'); // 子要素をまたいでテキストを取れる
    expect(facts?.price).toBe(12800);
    expect(facts?.source).toBe('microdata');
  });

  it('name が無い microdata は採用しない', () => {
    const body = `
      <div itemscope itemtype="https://schema.org/Product">
        <span itemprop="sku">NO-NAME-1</span>
      </div>`;
    expect(extractProductFromHtml(page('', body), PAGE_URL)).toBeNull();
  });
});

describe('extractProductFromHtml — OGP フォールバック', () => {
  it('OGP だけのページから抽出し source は ogp', () => {
    const html = page(`
      <title>ペンダントライト PL-30 | あかり商店</title>
      <meta property="og:type" content="product">
      <meta property="og:title" content="ペンダントライト PL-30">
      <meta property="og:image" content="https://cdn.example.jp/pl-30.jpg">
      <meta property="og:url" content="https://light.example.jp/p/pl-30">
      <meta property="product:price:amount" content="24800">
      <meta property="product:price:currency" content="JPY">
      <meta property="product:brand" content="オーデリック">
      <meta property="product:retailer_item_id" content="PL-30-WH">
      <meta property="product:availability" content="https://schema.org/InStock">`);

    expect(extractProductFromHtml(html, 'https://light.example.jp/p/pl-30')).toEqual({
      name: 'ペンダントライト PL-30',
      brand: 'オーデリック',
      price: 24800,
      currency: 'JPY',
      sku: 'PL-30-WH',
      imageUrl: 'https://cdn.example.jp/pl-30.jpg',
      url: 'https://light.example.jp/p/pl-30',
      availability: 'InStock',
      source: 'ogp',
    });
  });

  it('og:title が無ければ <title> を最後の手段として名前に使う', () => {
    const html = page(`
      <title>ミラー MR-4 | 通販</title>
      <meta property="og:image" content="https://cdn.example.jp/mr-4.jpg">
      <meta property="product:price:amount" content="8,800円">`);
    const facts = extractProductFromHtml(html, PAGE_URL);
    expect(facts?.name).toBe('ミラー MR-4 | 通販');
    expect(facts?.price).toBe(8800);
    expect(facts?.source).toBe('ogp');
  });

  it('属性内のHTMLエンティティを復号する（&amp; を含むURLが壊れない）', () => {
    const html = page(`
      <meta property="og:title" content="カーテン &amp; レール CR-1">
      <meta property="og:url" content="https://shop.example.jp/p?id=1&amp;c=2">`);
    const facts = extractProductFromHtml(html, PAGE_URL);
    expect(facts?.name).toBe('カーテン & レール CR-1');
    expect(facts?.url).toBe('https://shop.example.jp/p?id=1&c=2');
  });

  it('meta が name 属性（property でない）でも読む', () => {
    const html = page(`<meta name="og:title" content="ワゴン WG-2">`);
    expect(extractProductFromHtml(html, PAGE_URL)?.name).toBe('ワゴン WG-2');
  });

  it('構造化データが何も無いページは null（部分的に埋めたオブジェクトを返さない）', () => {
    const html = page(
      '<title>会社概要 | 例株式会社</title>',
      '<h1>会社概要</h1><p>当社は家具の企画を行っています。</p>',
    );
    expect(extractProductFromHtml(html, 'https://example.co.jp/about')).toBeNull();
  });

  it('空文字・非文字列でも投げずに null', () => {
    expect(extractProductFromHtml('', PAGE_URL)).toBeNull();
    expect(extractProductFromHtml(undefined as unknown as string, PAGE_URL)).toBeNull();
    expect(extractProductFromHtml('<html><body>', PAGE_URL)).toBeNull();
  });
});

describe('normalizePrice', () => {
  it('数値・数字文字列をそのまま通す', () => {
    expect(normalizePrice(128000)).toBe(128000);
    expect(normalizePrice('128000')).toBe(128000);
    expect(normalizePrice(' 12800 ')).toBe(12800);
  });

  it('通貨記号・カンマ・単位を落とす', () => {
    expect(normalizePrice('¥128,000')).toBe(128000);
    expect(normalizePrice('128,000円')).toBe(128000);
    expect(normalizePrice('税込 128,000 円')).toBe(128000);
    expect(normalizePrice('JPY 128000')).toBe(128000);
    expect(normalizePrice('¥1,280.50')).toBe(1280.5);
  });

  it('全角数字を半角に直して読む', () => {
    expect(normalizePrice('１２８０００')).toBe(128000);
    expect(normalizePrice('￥１２８，０００円')).toBe(128000);
  });

  it('価格帯は先頭の値を採る（記号一括除去で桁が化けないこと）', () => {
    expect(normalizePrice('128,000〜150,000円')).toBe(128000);
  });

  it('値段として使えないものは undefined', () => {
    expect(normalizePrice('')).toBeUndefined();
    expect(normalizePrice(null)).toBeUndefined();
    expect(normalizePrice(undefined)).toBeUndefined();
    expect(normalizePrice('お問い合わせ')).toBeUndefined();
    expect(normalizePrice('0')).toBeUndefined();
    expect(normalizePrice('-5')).toBeUndefined();
    expect(normalizePrice(0)).toBeUndefined();
    expect(normalizePrice(-5)).toBeUndefined();
    expect(normalizePrice(Number.NaN)).toBeUndefined();
    expect(normalizePrice(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizePrice(true)).toBeUndefined();
    expect(normalizePrice({})).toBeUndefined();
  });

  it('JSON-LD の {"@value": ...} 形式も読む', () => {
    expect(normalizePrice({ '@value': '128,000' })).toBe(128000);
  });
});

describe('absolutizeUrl', () => {
  const base = 'https://shop.example.jp/items/sf-100';

  it('相対・ルート相対・プロトコル相対を解決する', () => {
    expect(absolutizeUrl('/img/a.jpg', base)).toBe('https://shop.example.jp/img/a.jpg');
    expect(absolutizeUrl('./a.jpg', base)).toBe('https://shop.example.jp/items/a.jpg');
    expect(absolutizeUrl('a.jpg', base)).toBe('https://shop.example.jp/items/a.jpg');
    expect(absolutizeUrl('//cdn.example.jp/a.jpg', base)).toBe('https://cdn.example.jp/a.jpg');
  });

  it('絶対URLはそのまま通す', () => {
    expect(absolutizeUrl('https://cdn.example.jp/a.jpg', base)).toBe('https://cdn.example.jp/a.jpg');
    expect(absolutizeUrl('http://cdn.example.jp/a.jpg', base)).toBe('http://cdn.example.jp/a.jpg');
  });

  it('危険・非対応スキームは undefined（http/https のみ許可）', () => {
    expect(absolutizeUrl('javascript:alert(1)', base)).toBeUndefined();
    expect(absolutizeUrl('JavaScript:alert(1)', base)).toBeUndefined();
    expect(absolutizeUrl('data:image/png;base64,AAAA', base)).toBeUndefined();
    expect(absolutizeUrl('mailto:a@example.com', base)).toBeUndefined();
    expect(absolutizeUrl('ftp://example.com/a.jpg', base)).toBeUndefined();
  });

  it('空・undefined・壊れた値は undefined', () => {
    expect(absolutizeUrl(undefined, base)).toBeUndefined();
    expect(absolutizeUrl('', base)).toBeUndefined();
    expect(absolutizeUrl('   ', base)).toBeUndefined();
    expect(absolutizeUrl('/a.jpg', 'not a url')).toBeUndefined();
    expect(absolutizeUrl('x'.repeat(5000), base)).toBeUndefined();
  });

  it('基準URLが壊れていても絶対URLなら解決できる', () => {
    expect(absolutizeUrl('https://cdn.example.jp/a.jpg', '')).toBe('https://cdn.example.jp/a.jpg');
  });
});

describe('敵対的なHTML（第三者サイト前提）', () => {
  it('1MB の JSON-LD と 100 個の script があっても素早く返り、例外を投げない', () => {
    const huge = `<script type="application/ld+json">{"@type":"Product","name":"${'あ'.repeat(500_000)}"}</script>`;
    const junk = '<script type="application/ld+json">{ broken json ]</script>'.repeat(100);
    const html = page('<title>罠</title>' + huge + junk);

    const started = Date.now();
    const facts = extractProductFromHtml(html, PAGE_URL);
    const elapsed = Date.now() - started;

    expect(facts).toBeNull(); // 巨大ブロックは読まない・壊れたJSONは無視
    expect(elapsed).toBeLessThan(2000);
  });

  it('閉じられていないタグや大量の <（不正HTML）でも止まらない', () => {
    const started = Date.now();
    expect(() => extractProductFromHtml('<div ' + 'a'.repeat(500_000), PAGE_URL)).not.toThrow();
    expect(() => extractProductFromHtml('<'.repeat(200_000), PAGE_URL)).not.toThrow();
    expect(() => extractProductFromHtml('<!--' + 'x'.repeat(200_000), PAGE_URL)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('スクリプト実行や危険URLを結果に混ぜない', () => {
    const html = page(
      ldJson(`{
        "@type": "Product",
        "name": "罠商品",
        "image": "javascript:alert(document.cookie)",
        "url": "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
        "offers": { "@type": "Offer", "price": "お問い合わせください" }
      }`),
    );
    const facts = extractProductFromHtml(html, PAGE_URL);
    expect(facts?.name).toBe('罠商品');
    expect(facts?.imageUrl).toBeUndefined();
    expect(facts?.price).toBeUndefined();
    // url は危険な値を捨てて取得元URLに落ちる
    expect(facts?.url).toBe(PAGE_URL);
  });

  it('属性名による prototype 汚染を起こさない', () => {
    const body = `
      <div itemscope itemtype="https://schema.org/Product" __proto__="polluted">
        <span itemprop="name" __proto__="polluted">椅子</span>
      </div>`;
    extractProductFromHtml(page('', body), PAGE_URL);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });
});
