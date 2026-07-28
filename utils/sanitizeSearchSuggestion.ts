/**
 * Google 検索グラウンディングが返す「検索候補」HTML（searchEntryPoint.renderedContent）を
 * 安全に描画するためのサニタイザ（260728 敵対レビュー A3）。
 *
 * なぜ必要か:
 *  - 利用規約は、返却された検索候補をそのまま表示することを求めている（＝自前のUIに置き換えにくい）。
 *  - しかしこのHTMLの中のチップ文言は webSearchQueries に由来し、それは元をたどれば
 *    ユーザーがチャットに書いた文章から Gemini が作ったもの。つまり利用者由来のテキストが
 *    往復して戻ってくる。「Googleの応答だから安全」という前提は成り立たない。
 *  - このアプリには CSP が無く、Supabase のセッションはクライアント側にある。
 *    innerHTML は <script> こそ実行しないが <img onerror> / <svg onload> は実行するため、
 *    万一 Google 側のエスケープが破れた場合の被害が大きい。
 *
 * 方針:
 *  - DOMParser で一度だけ解析し、**文字列へ再直列化しない**（再直列化が mXSS の主因のため）。
 *  - 許可したタグ・属性以外は全て捨てる。on* 属性は問答無用で捨てる。
 *  - a要素は http(s) のみ許可し、target=_blank / rel=noopener を強制する
 *    （既定のままだと編集中のタブが Google へ遷移し、未保存の作業が失われる）。
 */

/** Google のチップ表示に必要な最小限のタグだけを許可する。 */
const ALLOWED_TAGS = new Set([
  'DIV', 'SPAN', 'A', 'STYLE', 'SVG', 'PATH', 'G', 'UL', 'LI', 'P', 'B', 'STRONG', 'IMG',
]);

/** タグごとに許可する属性（class/style は見た目の維持に必要）。 */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  '*': new Set(['class', 'style']),
  A: new Set(['href']),
  SVG: new Set(['viewBox', 'width', 'height', 'fill', 'xmlns']),
  PATH: new Set(['d', 'fill']),
  G: new Set(['fill']),
  IMG: new Set(['src', 'alt', 'width', 'height']),
};

function isSafeHttpUrl(value: string): boolean {
  try {
    const u = new URL(value, 'https://www.google.com');
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 1要素を検査し、許可されない属性を落とす。許可されないタグなら null を返す。 */
function sanitizeElement(el: Element): Element | null {
  const tag = el.tagName.toUpperCase();
  if (!ALLOWED_TAGS.has(tag)) return null;

  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    // イベントハンドラは常に除去（onerror / onload など）。
    if (name.startsWith('on')) {
      el.removeAttribute(attr.name);
      continue;
    }
    const allowed = ALLOWED_ATTRS[tag]?.has(attr.name) || ALLOWED_ATTRS['*'].has(name);
    if (!allowed) {
      el.removeAttribute(attr.name);
      continue;
    }
    // URL を取る属性は http(s) のみ（javascript: / data: を排除）。
    if ((name === 'href' || name === 'src') && !isSafeHttpUrl(attr.value)) {
      el.removeAttribute(attr.name);
    }
  }

  if (tag === 'A') {
    // 編集中のタブが遷移して作業内容を失わないよう、必ず別タブで開く。
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  }
  return el;
}

/**
 * HTML文字列を検査し、安全なノードだけを container へ流し込む。
 * 文字列を返さない（再直列化しない）のが要点。
 */
export function renderSanitizedHtml(container: HTMLElement, html: string): void {
  container.textContent = ''; // 既存の内容を消す
  if (!html || typeof html !== 'string') return;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return;
  }

  const walk = (src: Node, dest: Node): void => {
    for (const child of Array.from(src.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        dest.appendChild(document.createTextNode(child.textContent ?? ''));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue; // コメント・その他は捨てる
      const cleaned = sanitizeElement(child as Element);
      if (!cleaned) continue; // 許可されないタグは、その中身ごと捨てる
      // 属性を落とした「殻」を作り直してから中身を再帰的に検査する
      // （元ノードをそのまま繋ぐと、未検査の子が紛れ込む）。
      const copy = document.createElement(cleaned.tagName.toLowerCase());
      for (const attr of Array.from(cleaned.attributes)) copy.setAttribute(attr.name, attr.value);
      walk(child, copy);
      dest.appendChild(copy);
    }
  };

  walk(doc.body, container);
}
