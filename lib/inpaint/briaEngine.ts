import type { InpaintEngine, InpaintRequest, InpaintResult } from './inpaintTypes.js';

/**
 * Bria AI のマスクベース編集エンジン（260713・**サーバー側専用**・候補エンジンとして追加）。
 * クライアントから import してはいけない（APIキー・Node API を使う）。/api/ai-edit の mode:'inpaint' から呼ぶ。
 *
 * 位置づけ: Replicate と並ぶ「差し替え候補」。既定は Replicate のままで、運営が BRIA_API_TOKEN を設定し
 * env（INPAINT_REMOVE_ENGINE=bria:eraser / INPAINT_CUTOUT_ENGINE=bria:remove-background）で切り替えて実機比較する。
 *
 * API仕様（Bria image-editing v2・2026-07 時点の公式ドキュメント準拠）:
 * - ベース: https://engine.prod.bria-api.com/v2/image/edit/{route}
 * - 認証: ヘッダ `api_token: <BRIA_API_TOKEN>`（Replicate の Bearer とは異なる）。
 * - 入力: JSON。`image`（Base64文字列 or 公開URL）。消去は `mask`（白=255=消す範囲 / 黒=0=保持）。
 * - `sync: true` を付けると同期実行し、完了までコネクションを保持して最終結果を直接返す（ポーリング不要）。
 *   レスポンス: `{ result: { image_url }, request_id }`。image_url を取得して data URL 化する。
 * - マスク慣例: **白 = 変更（消去）範囲**（Replicate と同じ＝呼び出し側の maskRaster をそのまま使える）。
 *
 * ※ 実キー未取得のため未検証のダークシップ。BRIA_API_TOKEN を設定して実機で出力を確認してから採用すること。
 *   `sync` を尊重せず非同期(request_id/status_url)を返す構成だった場合は結果URLが取れず throw → Gemini フェイルソフト。
 */

const BRIA_BASE = 'https://engine.prod.bria-api.com/v2/image/edit';

/** data URL なら base64 部分だけを取り出す（Bria は生 base64 か URL を受け取る）。既に生base64/URLならそのまま。 */
function toBase64OrUrl(input: string): string {
  const m = /^data:[^;]+;base64,(.*)$/s.exec(input);
  return m ? m[1] : input;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

/** 結果画像URL（Bria の一時URL・通常は認証不要）を取得して data URL 化する。 */
async function resultUrlToDataUrl(imageUrl: string): Promise<string> {
  if (imageUrl.startsWith('data:')) return imageUrl;
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Bria 結果の取得失敗: ${res.status}`);
  const mime = res.headers.get('content-type') || 'image/png';
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** 指定ルートを同期実行し、結果の data URL を返す。失敗は throw（呼び出し側で Gemini へフェイルソフト）。 */
async function briaCall(apiKey: string, route: string, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${BRIA_BASE}/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', api_token: apiKey },
    body: JSON.stringify({ ...body, sync: true }),
  });
  if (!res.ok) {
    throw new Error(`Bria ${route} 失敗: ${res.status} ${await safeText(res)}`);
  }
  const data = (await res.json()) as { result?: { image_url?: string } };
  const url = data?.result?.image_url;
  if (typeof url !== 'string' || !url) {
    throw new Error(`Bria ${route}: 結果URLを取得できませんでした（sync 未対応の可能性）`);
  }
  return resultUrlToDataUrl(url);
}

/** 物体消去（Bria Eraser）。image + mask（白=消す範囲）。 */
export const briaEraserEngine: InpaintEngine = {
  id: 'bria:eraser',
  apiKeyEnv: 'BRIA_API_TOKEN',
  supports: ['remove'],
  approxCostUsd: 0.04, // 概算（要確認）。実請求は Bria のプラン/クレジットに従う。
  async run(apiKey, req: InpaintRequest): Promise<InpaintResult> {
    if (!req.maskDataUrl) throw new Error('mask が必要です');
    const url = await briaCall(apiKey, 'erase', {
      image: toBase64OrUrl(req.imageDataUrl),
      mask: toBase64OrUrl(req.maskDataUrl),
      mask_type: 'manual', // こちらが精密マスクを渡す（Briaに自動検出させない）。既定と同じだが明示。
    });
    return { imageDataUrl: url, engine: this.id, costUsd: this.approxCostUsd };
  },
};

/** 背景除去（Bria RMBG 2.0）。透明背景の切り抜きPNGを返す（合成の切り抜き候補）。 */
export const briaRemoveBgEngine: InpaintEngine = {
  id: 'bria:remove-background',
  apiKeyEnv: 'BRIA_API_TOKEN',
  supports: ['cutout'],
  approxCostUsd: 0.04, // 概算（要確認）。
  async run(apiKey, req: InpaintRequest): Promise<InpaintResult> {
    const url = await briaCall(apiKey, 'remove_background', {
      image: toBase64OrUrl(req.imageDataUrl),
      preserve_alpha: true, // 半透明の縁を残す（合成のなじみ向上）。
    });
    return { imageDataUrl: url, engine: this.id, costUsd: this.approxCostUsd };
  },
};
