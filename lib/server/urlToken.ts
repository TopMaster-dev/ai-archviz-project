/**
 * サーバが提示したURLだけを、あとから安全に「取りに行かせる」ための署名トークン（260728 敵対レビュー H1）。
 *
 * ■ 何を防ぐのか
 *   参考画像クリック機能では「この画像の掲載ページを読んで商品情報を出す」という往復が要る。
 *   素直に作るとクライアントが URL をそのまま送り返す形になるが、それは
 *   「任意の公開URLを我々のサーバ権限で取得させる口」＝リクエスト・ロンダリング/増幅DoS になる。
 *   safeFetchPage の SSRF ゲートは "内部アドレスへ行かせない" ためのもので、
 *   "第三者サイトへ我々の名前で大量に行かせない" ことは防げない。防ぐ層が別なのでここで足す。
 *
 * ■ 方針
 *   URL の集合を「サーバが選んだもの」に戻す。Vision が見つけたページを返すとき、
 *   URL 本体ではなく HMAC 署名付きトークンを渡し、クライアントはそれを丸ごと echo するだけにする。
 *   署名を作れるのはサーバだけなので、クライアントは自分で URL を差し込めない。
 *
 * ■ 鍵
 *   URL_SIGNING_SECRET があればそれを使う。無い場合はサーバ専用の既存シークレット
 *   （Vision APIキー）から派生させる＝新しい環境変数を増やさずに動く。
 *   HMAC の出力から鍵は復元できないので、派生鍵の使用でキーが漏れることはない。
 *   どちらも無ければ署名できない＝この経路は使えない（フェイルクローズ。画像経路へ落ちる）。
 */

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 履歴は localStorage に残るので、短すぎると押せなくなる

type Hmac = (key: string, data: string) => string | null;

let hmacPromise: Promise<Hmac | null> | null = null;

/**
 * node:crypto を遅延ロードして HMAC-SHA256 を取り出す。取れなければ null。
 * 静的 import にしないのは、このモジュールがバンドラ経由でブラウザ寄りの文脈から到達し得るため
 * （safeFetchPage の node:dns と同じ方針）。
 */
function loadHmac(): Promise<Hmac | null> {
  if (!hmacPromise) {
    hmacPromise = import('node:crypto')
      .then((mod) => {
        const m = mod as unknown as { createHmac?: Function; default?: { createHmac?: Function } };
        const createHmac = typeof m.createHmac === 'function' ? m.createHmac : m.default?.createHmac;
        if (typeof createHmac !== 'function') return null;
        return (key: string, data: string): string | null => {
          try {
            return createHmac('sha256', key).update(data).digest('base64url');
          } catch {
            return null;
          }
        };
      })
      .catch(() => null);
  }
  return hmacPromise;
}

/** 署名鍵。専用の環境変数が無ければ、サーバ専用の既存シークレットから派生させる。 */
function resolveSigningSecret(): string {
  const explicit = (process.env.URL_SIGNING_SECRET || '').trim();
  if (explicit) return explicit;
  const derived = (
    process.env.GOOGLE_VISION_API_KEY ||
    process.env.GOOGLE_CLOUD_VISION_API_KEY ||
    process.env.VISION_API_KEY ||
    ''
  ).trim();
  return derived ? `arise-url-sign:${derived}` : '';
}

const b64uEncode = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const b64uDecode = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');

/** 一致判定は長さ非依存の比較にする（署名の総当たりに時間差の手掛かりを与えない）。 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * URL を署名付きトークンにする。署名できない構成では null（＝この経路を提供しない）。
 * @param nowMs 現在時刻。テストから固定できるように引数で受ける。
 */
export async function signUrlToken(url: string, nowMs: number = Date.now()): Promise<string | null> {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  const secret = resolveSigningSecret();
  if (!secret) return null;
  const hmac = await loadHmac();
  if (!hmac) return null;

  const payload = b64uEncode(JSON.stringify({ u: url, e: nowMs + TOKEN_TTL_MS }));
  const sig = hmac(secret, payload);
  return sig ? `${payload}.${sig}` : null;
}

/**
 * トークンを検証して URL を取り出す。改ざん・期限切れ・署名不能はすべて null。
 * 呼び出し側は null を「この経路は使えない」として扱い、通常の画像経路へ落とすこと
 * （利用者に失敗を見せない）。
 */
export async function verifyUrlToken(token: unknown, nowMs: number = Date.now()): Promise<string | null> {
  if (typeof token !== 'string' || !token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const secret = resolveSigningSecret();
  if (!secret) return null;
  const hmac = await loadHmac();
  if (!hmac) return null;

  const expected = hmac(secret, payload);
  if (!expected || !timingSafeEqual(expected, sig)) return null;

  try {
    const parsed = JSON.parse(b64uDecode(payload)) as { u?: unknown; e?: unknown };
    if (typeof parsed.u !== 'string' || !/^https?:\/\//i.test(parsed.u)) return null;
    if (typeof parsed.e !== 'number' || !Number.isFinite(parsed.e) || parsed.e < nowMs) return null;
    return parsed.u;
  } catch {
    return null;
  }
}
