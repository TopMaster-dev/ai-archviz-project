import { generateVisionProductReply, resolveAgentModel } from '../gemini.js';
import { parseDataUrl } from '../agentAttachments.js';
import { parseVisionWebDetection, buildVisionFindingsText } from '../visionProductSearch.js';

/**
 * 画像内の商品を「特定して探す」処理の共有コア（260726）。
 * Cloudinary Vision（Web Detection＝逆画像検索）→ Gemini 合成。/api/agent（mode=vision-product）と
 * dev サーバ（vite.config.ts）から共通で呼ぶ。単体の Vercel 関数は作らない（Hobby の関数上限に配慮し /api/agent へ相乗り）。
 *
 * 運用: Vision は運営の Google Cloud キー（別課金）。キー未設定なら graceful に disabled を返す。
 * 【重要】運営コストを消費するため、本番公開前に呼び出し元（/api/agent）側で認証/レート制限を入れること（全API共通の宿題）。
 */

const MAX_IMAGE_B64 = 8 * 1024 * 1024;

function resolveVisionApiKey(): string {
  return (
    process.env.GOOGLE_VISION_API_KEY ||
    process.env.GOOGLE_CLOUD_VISION_API_KEY ||
    process.env.VISION_API_KEY ||
    ''
  ).trim();
}

export interface VisionSearchResult {
  status: number;
  body: Record<string, unknown>;
}

export async function runVisionProductSearch(params: {
  imageDataUrl: string;
  prompt: string;
  geminiKey: string;
}): Promise<VisionSearchResult> {
  const visionKey = resolveVisionApiKey();
  if (!visionKey) {
    return { status: 200, body: { success: false, disabled: true, error: '画像からの商品特定機能は現在無効です。' } };
  }
  if (!params.geminiKey) {
    return { status: 400, body: { success: false, error: 'Gemini APIキーが見つかりません。' } };
  }
  const { base64, mimeType } = parseDataUrl(params.imageDataUrl || '');
  const prompt = (params.prompt || '').trim().slice(0, 500);
  if (!base64 || !mimeType.startsWith('image/')) {
    return { status: 400, body: { success: false, error: '有効な画像が必要です。' } };
  }
  if (base64.length > MAX_IMAGE_B64) {
    return { status: 400, body: { success: false, error: '画像が大きすぎます。縮小して再度お試しください。' } };
  }
  try {
    const visionRes = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(visionKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ image: { content: base64 }, features: [{ type: 'WEB_DETECTION', maxResults: 15 }] }] }),
    });
    if (!visionRes.ok) {
      const t = await visionRes.text().catch(() => '');
      console.error('[visionProductSearch] Vision error', visionRes.status, t.slice(0, 300));
      return { status: 502, body: { success: false, error: `画像解析に失敗しました (${visionRes.status})` } };
    }
    const findings = parseVisionWebDetection(await visionRes.json());
    const { reply, recommendations, usage } = await generateVisionProductReply(params.geminiKey, {
      imageDataUrl: params.imageDataUrl,
      prompt,
      visionFindingsText: buildVisionFindingsText(findings),
      model: resolveAgentModel(),
    });
    return {
      status: 200,
      body: { success: true, reply, recommendations, usage, model: resolveAgentModel(), visionPages: findings.pages.slice(0, 5) },
    };
  } catch (e: any) {
    // 上流エラー本文はクライアントへ返さない（内部情報の漏えい防止）。
    console.error('[visionProductSearch] failed', e?.message || e);
    return { status: 500, body: { success: false, error: '商品特定に失敗しました。しばらくして再度お試しください。' } };
  }
}
