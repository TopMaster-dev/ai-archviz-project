// 第三者の商品ページHTMLから「商品名 / メーカー名 / 価格 / 品番 / 個別商品URL / サムネイル / 在庫」を
// 取り出す解析専用モジュール（260728 クライアント要望）。
//
// なぜ必要か:
//   今のエージェントは Gemini に「ページのタイトルとURL」しか渡していないため、価格や品番はモデルの
//   推測（＝しばしば事実と異なる）になる。実ページを取得して "サイト自身が名乗っている構造化データ"
//   （JSON-LD / microdata / OGP）を読めば、価格・品番・在庫を『事実』として提示できる。
//
// このファイルはネットワークを一切触らない純関数だけで構成する。取得側（fetch・タイムアウト・
// robots・SSRF対策・文字コード変換）は別モジュールの責務。分離しておくことで、実サイトを叩かずに
// 固定HTMLでテストできる。
//
// セキュリティ前提: 入力は「攻撃者が自由に書けるHTML」。したがって
//   - 絶対に例外を投げない（呼び出し側は null 前提で組む）
//   - eval / DOM構築など実行系を一切使わない（サーバ側には DOM も無い）
//   - 走査量に上限を設ける（巨大な JSON-LD や大量の <script> で関数をハングさせられない）
//   - 正規表現のバックトラック爆発を避けるため、タグ走査は indexOf ベースの線形スキャンで行う

export interface ProductFacts {
  name?: string;
  brand?: string; // メーカー名
  price?: number; // 数値のみ（通貨記号・カンマ除去）
  currency?: string; // 'JPY' 等
  sku?: string; // 品番（sku / mpn / model のいずれか）
  imageUrl?: string; // サムネイル（絶対URL）
  url?: string; // 商品の個別URL（canonical / og:url 優先）
  availability?: string; // 'InStock' | 'OutOfStock' 等（在庫切れ表示に使う）
  // どこから取れたか（信頼度の判断用）。
  // 'unresolved' は「ページには到達できたが商品情報を取り出せなかった」＝
  // 見た目一致だけを根拠に提示する候補（260729 クライアント要望）。
  source: 'json-ld' | 'microdata' | 'ogp' | 'unresolved';
}

// ---------------------------------------------------------------------------
// 走査量の上限（DoS対策）。「読めない」より「返ってこない」方が事故なので、迷ったら小さめに。
// ---------------------------------------------------------------------------
const MAX_HTML_CHARS = 3_000_000; // これを超えるHTMLは先頭のみ見る（構造化データは通常 <head> 付近）
const MAX_TAGS = 40_000; // タグ走査の打ち切り
const MAX_TAG_SCAN_STEPS = 200_000; // '<' だけを大量に並べた入力でも必ず有限で終わらせる
const MAX_JSON_LD_BLOCKS = 20; // JSON-LD ブロックの読み取り上限
const MAX_JSON_LD_CHARS = 200_000; // 1ブロックの上限。超えたら JSON.parse せず捨てる
const MAX_JSON_NODES = 500; // JSON-LD ツリー探索のノード数上限
const MAX_JSON_DEPTH = 4; // 値の取り出し再帰の深さ上限（深い入れ子でスタックを潰されない）
const MAX_SCOPE_TAGS = 1_500; // microdata の商品スコープとして見るタグ数の上限
const MAX_TEXT_CHARS = 400; // 名称等の文字数上限
const MAX_INNER_TEXT_CHARS = 2_000; // 要素内テキストとして読む生HTMLの長さ上限
const MAX_URL_CHARS = 2_048;
const MAX_ATTRS_PER_TAG = 48;
const MAX_PRICE_INPUT_CHARS = 200;

// ---------------------------------------------------------------------------
// 小さなユーティリティ
// ---------------------------------------------------------------------------

/** 全角英数記号（U+FF01〜U+FF5E）を半角へ。日本のECは価格を全角で書くことがある。 */
function toHalfWidth(s: string): string {
  return s
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' '); // 全角スペース（リテラル記述は lint の irregular-whitespace に触れる）
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  yen: '¥',
  middot: '·',
};

/** HTMLエンティティを復号。未知の実体はそのまま残す（壊すより残す）。 */
function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,10});/g, (whole, body: string) => {
    if (body.charCodeAt(0) === 35 /* '#' */) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const v = NAMED_ENTITIES[body.toLowerCase()];
    return v === undefined ? whole : v;
  });
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 属性値など「すでに復号済みの文字列」を整える。 */
function clean(v: string | undefined, max = MAX_TEXT_CHARS): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = collapse(v).slice(0, max);
  return s || undefined;
}

/** 生HTMLの断片からテキストを得る。タグを落としてからエンティティを復号する（順序が逆だと偽タグが生まれる）。 */
function cleanText(fragment: string, max = MAX_TEXT_CHARS): string | undefined {
  const stripped = fragment.slice(0, MAX_INNER_TEXT_CHARS).replace(/<[^>]*>/g, ' ');
  const s = collapse(decodeEntities(stripped)).slice(0, max);
  return s || undefined;
}

// ---------------------------------------------------------------------------
// 公開ユーティリティ
// ---------------------------------------------------------------------------

/**
 * 価格文字列を数値へ。'¥128,000' / '128,000円' / '１２８０００'（全角）→ 128000。
 * 「お問い合わせ」「0」「-5」など値段として使えないものは undefined を返す
 * （0円や負値を見積へ入れてしまう方が有害なため、通す条件は厳しくする）。
 */
export function normalizePrice(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : undefined;
  if (typeof raw === 'object') {
    // JSON-LD は {"@value": "128000"} 形式で値を包むことがある
    const o = raw as Record<string, unknown>;
    return '@value' in o ? normalizePrice(o['@value']) : undefined;
  }
  if (typeof raw !== 'string') return undefined;

  const s = toHalfWidth(raw.slice(0, MAX_PRICE_INPUT_CHARS)).replace(/\s+/g, '');
  // 先頭の数値らしい並びだけを取る。'128,000〜150,000'（価格帯）でも先頭の 128000 を採る。
  // 記号を一括除去する方式だと '128000150000' のような嘘の数値ができるため採らない。
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(s);
  if (!m) return undefined;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 相対URLをページURL基準で絶対URLにする。結果が http/https 以外なら undefined。
 * javascript: や data: は「サムネイルとして表示する」用途で危険なので必ず落とす。
 */
export function absolutizeUrl(maybeUrl: string | undefined, pageUrl: string): string | undefined {
  if (typeof maybeUrl !== 'string') return undefined;
  const raw = decodeEntities(maybeUrl).trim();
  if (!raw || raw.length > MAX_URL_CHARS) return undefined;
  // 結果の protocol でも弾くが、明らかに危険なスキームは解決前にも落とす（二重防御）
  if (/^(?:javascript|data|vbscript|file|blob|about|mailto|tel):/i.test(raw)) return undefined;

  const base = typeof pageUrl === 'string' && pageUrl.trim() ? pageUrl.trim() : undefined;
  const resolved = tryUrl(raw, base) ?? tryUrl(raw, undefined);
  if (!resolved) return undefined;
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined;
  const out = resolved.toString();
  return out.length > MAX_URL_CHARS ? undefined : out;
}

function tryUrl(value: string, base: string | undefined): URL | undefined {
  try {
    return base ? new URL(value, base) : new URL(value);
  } catch {
    return undefined;
  }
}

/** 'https://schema.org/InStock' → 'InStock'。素の 'InStock' はそのまま。 */
function normalizeAvailability(raw: unknown): string | undefined {
  const s = typeof raw === 'string' ? raw : firstUrlLike(raw);
  if (!s) return undefined;
  const last = s
    .trim()
    .slice(0, 200)
    .split(/[/#]/)
    .filter(Boolean)
    .pop();
  return clean(last, 64);
}

// ---------------------------------------------------------------------------
// HTML トークナイザ（線形・バックトラック無し）
// ---------------------------------------------------------------------------

interface HtmlTag {
  /** 小文字のタグ名 */
  name: string;
  /** </div> か */
  closing: boolean;
  /** <img> 等、子を持たない（持てない）か */
  selfClosing: boolean;
  /** 小文字キー・エンティティ復号済みの属性 */
  attrs: Record<string, string | undefined>;
  /** '<' の位置 */
  start: number;
  /** '>' の直後（要素内テキストの開始） */
  textStart: number;
  /** script / style の中身（JSON-LD 用） */
  rawText?: string;
}

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/**
 * 属性文字列を辞書化。プロトタイプ汚染を避けるため Object.create(null) を使う
 * （攻撃者が itemprop="__proto__" のような属性名を仕込める）。
 */
function parseAttrs(attrStr: string): Record<string, string | undefined> {
  const out = Object.create(null) as Record<string, string | undefined>;
  if (!attrStr) return out;
  const re = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let m: RegExpExecArray | null;
  let count = 0;
  while (count < MAX_ATTRS_PER_TAG && (m = re.exec(attrStr)) !== null) {
    count += 1;
    const key = m[1].toLowerCase();
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (out[key] !== undefined) continue; // 先勝ち
    out[key] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** `</script` のような閉じタグ位置を大文字小文字無視で線形に探す。 */
function findCloseTagIndex(html: string, name: string, from: number): number {
  const re = new RegExp(`</${name}[\\s/>]`, 'gi');
  re.lastIndex = from;
  const m = re.exec(html);
  return m ? m.index : -1;
}

/**
 * HTML をタグ列に分解する。DOM は作らない（サーバに無い・攻撃対象が増える）。
 * indexOf ベースなので、閉じ '>' の無い巨大文字列を投げられても線形時間で終わる。
 * 注意: 属性値の中に生の '>' があると、その位置でタグが終わったものとして扱う（防御的な割り切り）。
 */
function tokenizeTags(html: string): HtmlTag[] {
  const tags: HtmlTag[] = [];
  let i = 0;
  let steps = 0;
  while (i < html.length && tags.length < MAX_TAGS && steps < MAX_TAG_SCAN_STEPS) {
    steps += 1;
    const lt = html.indexOf('<', i);
    if (lt < 0) break;

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const gt0 = html.indexOf('>', lt);
      if (gt0 < 0) break;
      i = gt0 + 1;
      continue;
    }

    let p = lt + 1;
    const closing = html[p] === '/';
    if (closing) p += 1;
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:_-]{0,63}/.exec(html.slice(p, p + 64));
    if (!nameMatch) {
      i = lt + 1; // '<' がタグでない（'a < b' 等）
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    const gt = html.indexOf('>', p + nameMatch[0].length);
    if (gt < 0) break;

    const attrStr = html.slice(p + nameMatch[0].length, gt);
    const selfClosing = /\/\s*$/.test(attrStr) || VOID_TAGS.has(name);
    const tag: HtmlTag = {
      name,
      closing,
      selfClosing,
      attrs: closing ? (Object.create(null) as Record<string, string | undefined>) : parseAttrs(attrStr),
      start: lt,
      textStart: gt + 1,
    };
    i = gt + 1;

    // script / style の中身は HTML ではない。中の '<' をタグと誤認しないよう丸ごと読み飛ばし、
    // 同時に中身を保持しておく（JSON-LD はここから取る）。
    if (!closing && !selfClosing && (name === 'script' || name === 'style')) {
      const closeAt = findCloseTagIndex(html, name, gt + 1);
      tag.rawText = html.slice(gt + 1, closeAt < 0 ? html.length : closeAt);
      i = closeAt < 0 ? html.length : closeAt;
    }

    tags.push(tag);
  }
  return tags;
}

/** tags[startIdx] に対応する閉じタグの添字。壊れたHTMLでも必ず有限で返す。 */
function findSubtreeEnd(tags: HtmlTag[], startIdx: number): number {
  const open = tags[startIdx];
  if (!open || open.selfClosing) return startIdx;
  let depth = 0;
  for (let i = startIdx; i < tags.length; i += 1) {
    const cur = tags[i];
    if (cur.name !== open.name) continue;
    if (cur.closing) {
      depth -= 1;
      if (depth <= 0) return i;
    } else if (!cur.selfClosing) {
      depth += 1;
    }
  }
  return tags.length - 1;
}

/** 要素内のテキスト（子要素のテキストも含む）。 */
function innerText(src: string, tags: HtmlTag[], idx: number): string | undefined {
  const t = tags[idx];
  if (!t || t.selfClosing) return undefined;
  const endIdx = findSubtreeEnd(tags, idx);
  const stop = endIdx > idx ? tags[endIdx].start : src.length;
  return cleanText(src.slice(t.textStart, Math.min(stop, t.textStart + MAX_INNER_TEXT_CHARS)));
}

// ---------------------------------------------------------------------------
// (a) JSON-LD
// ---------------------------------------------------------------------------

/** Product として扱う @type。schema.org のURL形式（http://schema.org/Product）も許す。 */
const PRODUCT_TYPES = new Set(['product', 'individualproduct', 'productmodel', 'productgroup']);

function isProductType(v: unknown): boolean {
  const list = Array.isArray(v) ? v.slice(0, 20) : [v];
  for (const t of list) {
    if (typeof t !== 'string') continue;
    const last = t.split(/[/#]/).pop() ?? '';
    if (PRODUCT_TYPES.has(last.trim().toLowerCase())) return true;
  }
  return false;
}

/** JSON-LD の「器」になりうるキー。ここだけを辿る（offers 等の中まで無差別に探さない）。 */
const NESTED_KEYS = ['@graph', 'mainentity', 'mainentityofpage', 'itemlistelement', 'item', 'about'];

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined; // 壊れた JSON-LD は実在サイトに日常的にある。黙って次のブロックへ。
  }
}

/** CDATA / HTMLコメントで包まれた JSON-LD を素の JSON に戻す。 */
function stripJsonWrappers(raw: string): string {
  return raw
    .replace(/^\s*<!--/, '')
    .replace(/-->\s*$/, '')
    .replace(/^\s*\/\*\s*<!\[CDATA\[\s*\*\//, '')
    .replace(/\/\*\s*\]\]>\s*\*\/\s*$/, '')
    .replace(/^\s*\/\/\s*<!\[CDATA\[[^\n]*\n/, '')
    .replace(/\/\/\s*\]\]>\s*$/, '')
    .replace(/^\s*<!\[CDATA\[/, '')
    .replace(/\]\]>\s*$/, '')
    .trim();
}

/** 単体オブジェクト / 配列 / @graph のいずれでも Product ノードを見つける（浅い階層優先の幅優先探索）。 */
function findProductNode(root: unknown): Record<string, unknown> | null {
  const queue: unknown[] = [root];
  let visited = 0;
  while (queue.length > 0 && visited < MAX_JSON_NODES) {
    const cur = queue.shift();
    visited += 1;
    if (Array.isArray(cur)) {
      for (const item of cur.slice(0, 100)) queue.push(item);
      continue;
    }
    if (!cur || typeof cur !== 'object') continue;
    const obj = cur as Record<string, unknown>;
    if (isProductType(obj['@type'])) return obj;
    for (const key of Object.keys(obj)) {
      if (NESTED_KEYS.includes(key.toLowerCase())) queue.push(obj[key]);
    }
  }
  return null;
}

/** 文字列 / 数値 / {'@value'} / {'name'} / 配列 のいずれからでも表示用テキストを取り出す。 */
function jsonText(v: unknown, depth = 0): string | undefined {
  if (depth > MAX_JSON_DEPTH) return undefined;
  if (typeof v === 'string') return clean(decodeEntities(v));
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : undefined;
  if (Array.isArray(v)) {
    for (const item of v.slice(0, 5)) {
      const s = jsonText(item, depth + 1);
      if (s) return s;
    }
    return undefined;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // brand: {"@type":"Brand","name":"カリモク"} / {"@value":"..."} の両方に効く
    return jsonText(o['@value'], depth + 1) ?? jsonText(o.name, depth + 1);
  }
  return undefined;
}

/** 文字列 / 配列 / {url} / {contentUrl} / {'@id'} のいずれからでも URL らしき文字列を取り出す。 */
function firstUrlLike(v: unknown, depth = 0): string | undefined {
  if (depth > MAX_JSON_DEPTH) return undefined;
  if (typeof v === 'string') return v.trim() || undefined;
  if (Array.isArray(v)) {
    for (const item of v.slice(0, 5)) {
      const s = firstUrlLike(item, depth + 1);
      if (s) return s;
    }
    return undefined;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return (
      firstUrlLike(o.url, depth + 1) ??
      firstUrlLike(o.contentUrl, depth + 1) ??
      firstUrlLike(o['@id'], depth + 1)
    );
  }
  return undefined;
}

function firstObject(v: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(v)) {
    for (const item of v.slice(0, 10)) {
      const o = firstObject(item);
      if (o) return o;
    }
    return undefined;
  }
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

function factsFromJsonLdNode(node: Record<string, unknown>, pageUrl: string): ProductFacts | null {
  const name = jsonText(node.name);
  if (!name) return null; // 名前が取れないものは「使える結果」ではない → 次の手段へ

  const offer = firstObject(node.offers); // 配列なら先頭のオファーを採用
  const spec = offer ? firstObject(offer.priceSpecification) : undefined;

  const facts: ProductFacts = {
    name,
    brand: jsonText(node.brand) ?? jsonText(node.manufacturer),
    price: normalizePrice(
      offer?.price ?? offer?.lowPrice ?? spec?.price ?? spec?.minPrice ?? node.price,
    ),
    currency: clean(jsonText(offer?.priceCurrency ?? spec?.priceCurrency), 16),
    sku: jsonText(node.sku) ?? jsonText(node.mpn) ?? jsonText(node.model) ?? jsonText(node.productID),
    imageUrl: absolutizeUrl(firstUrlLike(node.image), pageUrl),
    url: absolutizeUrl(firstUrlLike(node.url), pageUrl),
    availability: normalizeAvailability(offer?.availability ?? node.availability),
    source: 'json-ld',
  };
  return facts;
}

function readJsonLd(tags: HtmlTag[], pageUrl: string): ProductFacts | null {
  let blocks = 0;
  for (const tag of tags) {
    if (tag.closing || tag.name !== 'script' || tag.rawText === undefined) continue;
    if (!(tag.attrs.type ?? '').toLowerCase().includes('ld+json')) continue;
    if (blocks >= MAX_JSON_LD_BLOCKS) break; // 大量ブロックでハングさせられないための打ち切り
    blocks += 1;
    if (tag.rawText.length > MAX_JSON_LD_CHARS) continue; // 巨大ブロックは parse せず捨てる
    const parsed = safeJsonParse(stripJsonWrappers(tag.rawText));
    if (parsed === undefined) continue;
    const node = findProductNode(parsed);
    if (!node) continue;
    const facts = factsFromJsonLdNode(node, pageUrl);
    if (facts) return facts;
  }
  return null;
}

// ---------------------------------------------------------------------------
// (b) microdata
// ---------------------------------------------------------------------------

/** 値がURLになるプロパティ。<a itemprop="url" href> のように href を採るべきもの。 */
const URL_PROPS = new Set(['url', 'image', 'logo', 'thumbnailurl', 'contenturl']);

function microdataValue(
  src: string,
  tags: HtmlTag[],
  idx: number,
  prop: string,
): string | undefined {
  const t = tags[idx];
  const content = clean(t.attrs.content);
  const href = clean(t.attrs.href);
  const srcAttr = clean(t.attrs.src ?? t.attrs['data-src']);
  if (URL_PROPS.has(prop)) return content ?? href ?? srcAttr ?? innerText(src, tags, idx);
  // availability は <link itemprop="availability" href="https://schema.org/InStock"> が定番
  if (prop === 'availability') return content ?? href ?? innerText(src, tags, idx);
  return content ?? innerText(src, tags, idx) ?? href ?? srcAttr;
}

function readMicrodata(src: string, tags: HtmlTag[], pageUrl: string): ProductFacts | null {
  const startIdx = tags.findIndex(
    (t) => !t.closing && (t.attrs.itemtype ?? '').toLowerCase().includes('schema.org/product'),
  );
  if (startIdx < 0) return null;

  const endIdx = Math.min(findSubtreeEnd(tags, startIdx), startIdx + MAX_SCOPE_TAGS, tags.length - 1);
  const props = new Map<string, string>();
  let skipUntil = -1;

  for (let i = startIdx + 1; i <= endIdx; i += 1) {
    if (i <= skipUntil) continue;
    const t = tags[i];
    if (t.closing) continue;
    // itemprop は "name headline" のように複数書ける。先頭だけ見る。
    const prop = (t.attrs.itemprop ?? '').trim().toLowerCase().split(/\s+/)[0];
    if (!prop) continue;

    if ('itemscope' in t.attrs) {
      const itemtype = (t.attrs.itemtype ?? '').toLowerCase();
      if (!itemtype.includes('offer')) {
        // brand 等の入れ子アイテム。値（＝配下のテキスト）だけ拾って中身は読み飛ばす。
        // そうしないと <div itemprop="brand"><span itemprop="name">…</span></div> の
        // 内側の name を商品名として拾ってしまう。
        if (!props.has(prop)) {
          const v = microdataValue(src, tags, i, prop);
          if (v) props.set(prop, v);
        }
        skipUntil = findSubtreeEnd(tags, i);
      }
      continue; // Offer は price/availability が中にあるので読み飛ばさない
    }

    if (props.has(prop)) continue; // 先勝ち（ページ上部の主要マークアップを優先）
    const v = microdataValue(src, tags, i, prop);
    if (v) props.set(prop, v);
  }

  const name = props.get('name');
  if (!name) return null;

  return {
    name,
    brand: props.get('brand') ?? props.get('manufacturer'),
    price: normalizePrice(props.get('price') ?? props.get('lowprice')),
    currency: clean(props.get('pricecurrency'), 16),
    sku: props.get('sku') ?? props.get('mpn') ?? props.get('model') ?? props.get('productid'),
    imageUrl: absolutizeUrl(props.get('image'), pageUrl),
    url: absolutizeUrl(props.get('url'), pageUrl),
    availability: normalizeAvailability(props.get('availability')),
    source: 'microdata',
  };
}

// ---------------------------------------------------------------------------
// (c) OGP / meta フォールバック
// ---------------------------------------------------------------------------

interface PageMeta {
  canonicalUrl?: string;
  ogUrl?: string;
  ogTitle?: string;
  ogImage?: string;
  ogType?: string;
  priceAmount?: string;
  priceCurrency?: string;
  brand?: string;
  sku?: string;
  availability?: string;
  title?: string;
}

function readPageMeta(src: string, tags: HtmlTag[], pageUrl: string): PageMeta {
  const meta: PageMeta = {};
  for (let i = 0; i < tags.length; i += 1) {
    const t = tags[i];
    if (t.closing) continue;

    if (t.name === 'link') {
      const rel = (t.attrs.rel ?? '').toLowerCase();
      if (!meta.canonicalUrl && rel.split(/\s+/).includes('canonical')) {
        meta.canonicalUrl = absolutizeUrl(t.attrs.href, pageUrl);
      }
      continue;
    }
    if (t.name === 'title') {
      if (!meta.title) meta.title = innerText(src, tags, i);
      continue;
    }
    if (t.name !== 'meta') continue;

    const key = (t.attrs.property ?? t.attrs.name ?? '').trim().toLowerCase();
    const content = clean(t.attrs.content);
    if (!key || !content) continue;

    switch (key) {
      case 'og:title':
        meta.ogTitle ??= content;
        break;
      case 'og:image':
      case 'og:image:url':
      case 'og:image:secure_url':
      case 'twitter:image':
        meta.ogImage ??= absolutizeUrl(content, pageUrl);
        break;
      case 'og:url':
        meta.ogUrl ??= absolutizeUrl(content, pageUrl);
        break;
      case 'og:type':
        meta.ogType ??= content;
        break;
      case 'product:price:amount':
      case 'og:price:amount':
        meta.priceAmount ??= content;
        break;
      case 'product:price:currency':
      case 'og:price:currency':
        meta.priceCurrency ??= content;
        break;
      case 'product:brand':
      case 'og:brand':
        meta.brand ??= content;
        break;
      case 'product:retailer_item_id':
      case 'product:mfr_part_no':
        meta.sku ??= content;
        break;
      case 'product:availability':
      case 'og:availability':
        meta.availability ??= content;
        break;
      default:
        break;
    }
  }
  return meta;
}

function readOgp(meta: PageMeta): ProductFacts | null {
  // 「商品ページらしさ」が1つも無いページで <title> だけを拾うと、会社概要ページ等が
  // 商品として提案されてしまう。商品シグナルが無ければ潔く null。
  const hasProductSignal = Boolean(
    meta.ogTitle || meta.ogImage || meta.priceAmount || (meta.ogType ?? '').toLowerCase().includes('product'),
  );
  if (!hasProductSignal) return null;

  const name = meta.ogTitle ?? meta.title; // <title> は最後の手段
  if (!name) return null;

  return {
    name,
    brand: meta.brand,
    price: normalizePrice(meta.priceAmount),
    currency: clean(meta.priceCurrency, 16),
    sku: meta.sku,
    imageUrl: meta.ogImage,
    url: meta.ogUrl,
    availability: normalizeAvailability(meta.availability),
    source: 'ogp',
  };
}

// ---------------------------------------------------------------------------
// 公開エントリポイント
// ---------------------------------------------------------------------------

/** undefined のキーを落とす（Gemini へ JSON で渡すため、空キーを残さない）。 */
function compact(facts: ProductFacts): ProductFacts {
  const out: ProductFacts = { source: facts.source };
  for (const key of ['name', 'brand', 'currency', 'sku', 'imageUrl', 'url', 'availability'] as const) {
    const v = facts[key];
    if (typeof v === 'string' && v) out[key] = v;
  }
  if (typeof facts.price === 'number' && Number.isFinite(facts.price) && facts.price > 0) {
    out.price = facts.price;
  }
  return out;
}

/**
 * 商品ページHTMLから事実を抽出する。取れなければ null（部分的に埋まったオブジェクトは返さない）。
 * 優先順位は JSON-LD → microdata → OGP。最初に「名前が取れた」ものを採用する。
 *
 * @param html    取得済みのHTML（デコード済み文字列）
 * @param pageUrl 取得元URL（相対URLの解決基準）
 */
export function extractProductFromHtml(html: string, pageUrl: string): ProductFacts | null {
  try {
    if (typeof html !== 'string' || !html) return null;
    const src = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
    const tags = tokenizeTags(src);
    const meta = readPageMeta(src, tags, pageUrl);

    const facts = readJsonLd(tags, pageUrl) ?? readMicrodata(src, tags, pageUrl) ?? readOgp(meta);
    if (!facts || !facts.name) return null;

    // 個別商品URLは canonical / og:url を最優先（JSON-LD の url はシリーズ代表URLのことがある）。
    // どれも無ければ取得元URLそのものが個別商品URL。
    facts.url = meta.canonicalUrl ?? meta.ogUrl ?? facts.url ?? absolutizeUrl(pageUrl, pageUrl);
    // サムネイルは JSON-LD/microdata に無ければ OGP 画像で補う（表示できないより良い）
    facts.imageUrl ??= meta.ogImage;

    return compact(facts);
  } catch {
    // 第三者HTMLが相手なので、想定外の入力でも絶対に投げない（呼び出し側は null 前提）
    return null;
  }
}


/**
 * availability が「在庫切れ／販売終了」を示すか（260728）。
 * schema.org は 'OutOfStock' のような詰め文字列だが、サイトによっては 'Out Of Stock' や
 * 'out of stock' のように空白・大小が揺れる。英数字以外を落としてから比較する。
 */
export function isOutOfStock(availability: string | undefined): boolean {
  if (!availability) return false;
  const k = availability.toLowerCase().replace(/[^a-z]/g, '');
  return k.includes('outofstock') || k.includes('soldout') || k.includes('discontinued');
}
