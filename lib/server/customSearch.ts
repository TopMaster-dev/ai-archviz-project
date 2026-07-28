/**
 * Google Programmable Search（Custom Search JSON API）による商品ページ検索（260728 クライアント承認）。
 *
 * なぜ必要か:
 *   Vision の逆画像検索は「その画像が載っているページ」を返すため、Pinterest やインテリア写真の
 *   まとめサイト（Foter 等）がヒットしやすい。これらには商品の構造化データが無く、
 *   価格・品番・メーカーが取得できない＝クライアントの求める5項目が埋まらない。
 *   そこで Vision が推定した商品名・キーワードで「実際に売っているページ」を検索し直し、
 *   候補URLの質を上げる。
 *
 * 重要な位置づけ:
 *   ここが返すのは **候補URLだけ**。値の確定は従来どおり productResolver（実際にページを開いて
 *   構造化データを読む＋到達確認）が行う。したがって、この経路が増えても
 *   「未検証の情報が利用者に出る」ことはない。検索は候補の質を上げるためだけに使う。
 *
 * 運用（従量課金・運営負担）:
 *   - GOOGLE_CUSTOM_SEARCH_API_KEY と GOOGLE_CUSTOM_SEARCH_CX の両方が設定されたときだけ有効。
 *     未設定なら何もせず空配列を返す（＝従来どおり Vision/grounding の結果だけで動く）。
 *   - 1リクエストあたりのクエリ数を厳しく制限する（既定2件）。ここを緩めると費用が線形に増える。
 */

/** 検索1件（候補URLのみ。値の確定はしない）。 */
export interface CustomSearchHit {
  url: string;
  title: string;
  /** pagemap から拾えた画像（あくまで参考。正式なサムネイルはページ取得側で確定する）。 */
  thumbnailUrl?: string;
}

export interface CustomSearchOptions {
  /** 1クエリあたりの取得件数（既定5・APIの上限は10）。 */
  num?: number;
  /** タイムアウト(ms)。既定4000。 */
  timeoutMs?: number;
}

function readEnv(name: string): string {
  return (typeof process !== 'undefined' ? (process.env?.[name] ?? '') : '').trim();
}

/** 設定済みか（キーとエンジンIDの両方が必要）。未設定なら機能ごとスキップする。 */
export function isCustomSearchConfigured(): boolean {
  return !!readEnv('GOOGLE_CUSTOM_SEARCH_API_KEY') && !!readEnv('GOOGLE_CUSTOM_SEARCH_CX');
}

/**
 * 検索クエリを組み立てる（純関数・テスト対象）。
 * 余計な記号や長すぎる語はノイズになり、無関係なページを引く原因になるので削る。
 */
export function buildProductQuery(parts: Array<string | undefined>): string {
  const cleaned = parts
    .map((p) => (p ?? '').replace(/[\r\n\t"'`|]+/g, ' ').trim())
    .filter((p) => p.length > 0)
    // 同じ語の重複を落とす（「ソファ ソファ」のような無意味なクエリを避ける）
    .filter((p, i, arr) => arr.findIndex((x) => x.toLowerCase() === p.toLowerCase()) === i);
  return cleaned.join(' ').slice(0, 200).trim();
}

/**
 * Custom Search を1回だけ実行して候補URLを返す。
 * 失敗・未設定・0件は空配列（呼び出し側は「候補が増えなかった」として扱えばよい）。
 */
export async function searchProductPages(
  query: string,
  opts: CustomSearchOptions = {},
): Promise<CustomSearchHit[]> {
  const key = readEnv('GOOGLE_CUSTOM_SEARCH_API_KEY');
  const cx = readEnv('GOOGLE_CUSTOM_SEARCH_CX');
  const q = (query ?? '').trim();
  if (!key || !cx || !q) return [];

  const num = Math.max(1, Math.min(10, opts.num ?? 5));
  const url =
    `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}` +
    `&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(q)}&num=${num}&hl=ja&gl=jp`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, opts.timeoutMs ?? 4000));
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      // 403 は多くの場合クォータ超過。費用に直結するのでログには残す（利用者には見せない）。
      console.error('[customSearch] failed', res.status);
      return [];
    }
    const data = (await res.json()) as { items?: unknown };
    const items = Array.isArray(data.items) ? (data.items as unknown[]) : [];
    const hits: CustomSearchHit[] = [];
    for (const raw of items) {
      const it = raw as {
        link?: unknown;
        title?: unknown;
        pagemap?: { cse_thumbnail?: Array<{ src?: unknown }>; cse_image?: Array<{ src?: unknown }> };
      };
      const link = typeof it.link === 'string' ? it.link : '';
      if (!/^https?:\/\//i.test(link)) continue;
      const thumb = it.pagemap?.cse_thumbnail?.[0]?.src ?? it.pagemap?.cse_image?.[0]?.src;
      hits.push({
        url: link,
        title: typeof it.title === 'string' ? it.title : link,
        thumbnailUrl: typeof thumb === 'string' && /^https?:\/\//i.test(thumb) ? thumb : undefined,
      });
    }
    return hits;
  } catch (e) {
    console.error('[customSearch] threw', (e as Error)?.message || e);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 商品ページ候補を集める（複数クエリ・件数上限つき）。
 * クエリ数の上限で費用を抑える（既定2クエリ＝1リクエストで最大2カウント）。
 */
export async function findProductPageCandidates(
  queries: string[],
  opts: CustomSearchOptions & { maxQueries?: number } = {},
): Promise<CustomSearchHit[]> {
  if (!isCustomSearchConfigured()) return [];
  const maxQueries = Math.max(1, Math.min(4, opts.maxQueries ?? 2));
  const uniqueQueries = Array.from(new Set(queries.map((q) => q.trim()).filter(Boolean))).slice(0, maxQueries);
  if (uniqueQueries.length === 0) return [];

  const results = await Promise.all(uniqueQueries.map((q) => searchProductPages(q, opts)));
  const seen = new Set<string>();
  const merged: CustomSearchHit[] = [];
  for (const list of results) {
    for (const hit of list) {
      if (seen.has(hit.url)) continue;
      seen.add(hit.url);
      merged.push(hit);
    }
  }
  return merged;
}
