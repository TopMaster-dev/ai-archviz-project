/**
 * 文字列から Gemini API キーを抽出する（サーバー側のキー解決で共有）。
 *
 * 対応フォーマット（260612 クライアント要望）:
 *  - 従来:   「AIzaSy...」（Google AI Studio の標準APIキー）
 *  - 新規:   「AQ.xxxx」（最近 Google AI Studio が発行する新フォーマット）
 *
 * ラベルや空白・改行を含むペーストからもキー本体だけを取り出す。
 *
 * 注意: アプリ側でキーを受理しても、Google のAPI側が AQ. キーを 401 で拒否する場合がある
 *       （アカウント制限による制約。Google 開発者フォーラム参照）。本関数は「形式として
 *       受け付ける」役割であり、実際の認可は Google API の応答に従う。
 *
 * @returns 抽出したキー文字列。見つからなければ ''。
 */
export function extractGeminiApiKey(raw: string | null | undefined): string {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';
  // 従来キー（AIzaSy...）を最優先で抽出（文字列中からでも拾う）。
  const aiza = s.match(/AIzaSy[\w-]+/);
  if (aiza) return aiza[0];
  // 新フォーマット（AQ. で始まる）。base64url + ドット区切りを許容。
  const aq = s.match(/AQ\.[A-Za-z0-9._-]+/);
  if (aq) return aq[0];
  return '';
}
