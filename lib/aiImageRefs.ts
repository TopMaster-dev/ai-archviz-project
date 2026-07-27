// AI生成画像（ai-render）の参照カウント共通コア（260728 クライアント要望 #1）。
//
// 背景: これまでプロジェクト複製は AI生成画像を「物理コピー」していた（lib/db/projects.ts の
// rehomeAiImages・260630）。元プロジェクトを完全削除してもコピー側の画像が消えないようにするための
// 措置だったが、同一オーナー内のコピーでも Storage 実体が倍々に増えるため容量を強く圧迫する。
// 260728 の要望で「同一オーナー内はリンク共有（実体は1つ・URLを貼り替えない）」へ切り替える。
//
// 実体を共有する以上、削除の前に「他のプロジェクトがまだ参照していないか」を必ず数える必要がある。
// 数えずに消すと、複製元を purge した瞬間にコピー側の画像が全部 404 になる（＝退行）。
// このファイルはその参照カウントに必要な「URL抽出 / URL→パス正規化 / 参照判定」だけを持つ純粋関数群で、
// クライアント（lib/db/*）とサーバ（lib/server/* の purge バッチ）の両方から共有して使う。
// そのため I/O・React・Supabase クライアントには一切依存しない（サーバ側には fetch もブラウザAPIも無い）。

/** Storage バケット名。lib/db/aiRenderStorage.ts の BUCKET と一致させること。 */
const BUCKET = 'user-uploads';

/**
 * Supabase Storage の公開URLに現れる区切り。ホスト部やプロキシ前置きに依存しないよう
 * `/storage/v1` ではなく `/object/public/` を目印にする（この直後が <bucket>/<path>）。
 */
const PUBLIC_OBJECT_MARKER = '/object/public/';

/**
 * projects.data(jsonb) を JSON 文字列化したものから ai-render の公開URLを拾う正規表現。
 * lib/db/projects.ts の rehomeAiImages が使っているものと同一の挙動にすること（抽出漏れ＝誤削除に直結）。
 * JSON 文字列中では `"` と `\` がURLの終端になり得るので、その2文字と空白を除外している。
 *
 * 注意: グローバル正規表現は lastIndex を持つ「状態付き」オブジェクトである。
 * これを直接 exec()/test() で使い回すと、2回目以降の呼び出しが途中位置から走って結果が変わる。
 * そのため collectAiRenderUrls() は毎回この正規表現の複製を作って使う（下記参照）。
 * 外部で使う場合も、複製するか String.prototype.match（内部で lastIndex を 0 に戻す）経由にすること。
 */
export const AI_RENDER_URL_RE = /https?:\/\/[^"\s\\]+\/ai-render\/[^"\s\\]+/g;

/**
 * 任意の値（プロジェクト state など）に含まれる ai-render 公開URLを重複なしで列挙する。
 *  - JSON.stringify できない値（循環参照 / BigInt など）は例外を投げずに [] を返す。
 *    参照カウントの入口で例外を投げると、呼び出し側の削除処理が「参照0件」と誤解する危険があるため、
 *    ここでは必ず「空＝何も判らなかった」を返し、判断は呼び出し側の安全弁に委ねる。
 *  - undefined / 関数など JSON.stringify が undefined を返すケースも [] を返す。
 */
export function collectAiRenderUrls(data: unknown): string[] {
  let json: string;
  try {
    const serialized = JSON.stringify(data);
    if (typeof serialized !== 'string') return []; // undefined / function / symbol
    json = serialized;
  } catch {
    return []; // 循環参照・BigInt・toJSON が投げる等
  }
  // 毎回複製して lastIndex 汚染（呼び出し順で結果が変わるバグ）を根本的に避ける。
  const re = new RegExp(AI_RENDER_URL_RE.source, AI_RENDER_URL_RE.flags);
  return Array.from(new Set(json.match(re) ?? []));
}

/**
 * URL または Storage パスを、比較用の正準パス（{uid}/ai-render/{projectId}/{file}）へ正規化する。
 * 参照カウントは必ずこの形（生URLではない）で突き合わせる。生URLで比較すると、将来 ?token= や
 * CDN パラメータが付いた瞬間に「別物」と判定され、参照されている画像を消してしまう。
 */
function normalizeAiRenderPath(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null;
  let s = value.trim();
  if (!s || s.startsWith('data:')) return null; // base64 はまだ Storage 実体を持たない

  // ?query / #hash は同一オブジェクトを指すので比較前に落とす（?token= 付与に耐えるため）。
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash);
  const query = s.indexOf('?');
  if (query >= 0) s = s.slice(0, query);

  const marker = s.indexOf(PUBLIC_OBJECT_MARKER);
  if (marker >= 0) {
    s = s.slice(marker + PUBLIC_OBJECT_MARKER.length);
  } else if (/^https?:\/\//i.test(s)) {
    return null; // Storage 公開URL以外（Cloudinary 等）は参照カウントの対象外
  }

  try {
    s = decodeURIComponent(s);
  } catch {
    /* デコード不能ならそのまま比較する（両辺とも同じ処理を通るので突き合わせは成立する） */
  }

  while (s.startsWith('/')) s = s.slice(1);
  if (s.startsWith(`${BUCKET}/`)) {
    s = s.slice(BUCKET.length + 1); // 公開URL / バケット付きパスの両方を同じ形に寄せる
  } else if (marker >= 0) {
    return null; // 公開URLなのに別バケット＝user-uploads の資産ではない
  }
  while (s.startsWith('/')) s = s.slice(1);

  // 安全弁: ai-render 配下以外（素材 model/texture・サムネイル等）は決してパス化しない。
  // 呼び出し側がこの戻り値を削除対象に使うため、ここを緩めると再利用資産を消す事故になる。
  return s.includes('/ai-render/') ? s : null;
}

/**
 * Supabase Storage の公開URLから、削除・比較に使うオブジェクトパスを取り出す。
 * 戻り値は `{uid}/ai-render/{projectId}/{file}`（バケット名は含まない＝Storage API にそのまま渡せる形）。
 *
 * `/ai-render/` を含まないものは必ず null を返す（安全弁）。この関数を通す限り、素材やサムネイルの
 * オブジェクトが削除対象として返ることはない。?query / #hash は比較前に除去する。
 * 冪等: 戻り値を再度この関数に通しても（公開URL形でなくなるため）用途は無いが、正規化自体は
 * isPathReferenced() 側で同じ正規化を通すので、URL と パス を混ぜて突き合わせても一致する。
 */
export function storagePathFromAiRenderUrl(url: string): string | null {
  if (!url || typeof url !== 'string') return null;
  // 公開URL以外（バケット無しの生パス等）をここで受け付けると、呼び出し側が「URLだと思って渡した
  // 別種の文字列」をパス化してしまう。URL 由来であることを marker の存在で担保する。
  if (url.indexOf(PUBLIC_OBJECT_MARKER) < 0) return null;
  return normalizeAiRenderPath(url);
}

/**
 * あるオブジェクトパスが、参照集合（他プロジェクトが使っているURL/パスの集合）にまだ含まれるか。
 * 削除の直前に必ずこれで確認する（リンク共有前提のため、最後の参照が消えるまで実体を残す）。
 *
 * 突き合わせは両辺とも normalizeAiRenderPath() を通した「パス」で行う。生URL比較は禁止
 * （?token= 等が付いた瞬間に参照を見落として消す）。URL と パス を混ぜて渡しても正しく一致する。
 *
 * 安全側の既定: path が正規化できない（空文字・data:・ai-render 以外）場合は true を返す。
 * 「判定できないものは参照されているとみなして消さない」＝誤削除より容量を優先する方針（260728）。
 */
export function isPathReferenced(path: string, referencedPaths: Iterable<string>): boolean {
  const target = normalizeAiRenderPath(path);
  if (!target) return true; // 素性不明＝消させない
  if (!referencedPaths) return true; // 参照集合を渡し損ねた＝数え損ねの可能性。消させない
  for (const ref of referencedPaths) {
    if (normalizeAiRenderPath(ref) === target) return true;
  }
  return false;
}
