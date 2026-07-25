import { generateVisionProductReply, resolveAgentModel } from '../lib/gemini.js';
import { parseDataUrl } from '../lib/agentAttachments.js';
import { extractGeminiApiKey } from '../lib/geminiKey.js';
import { parseVisionWebDetection, buildVisionFindingsText } from '../lib/visionProductSearch.js';

/**
 * 画像内の商品を「特定して探す」専用エンドポイント（260725・クライアント要望②）。
 * Cloud Vision API（Web Detection＝逆画像検索）で一致画像の実在ページを取得し、
 * その結果を Gemini に渡して「実在商品ページURL付きの提案」を生成する（多段パイプライン）。
 *
 * 運用（テストマーケ期）: Vision は Gemini とは別の Google Cloud 認証・課金。ユーザーの持ち込み Gemini キー
 * とは別枠のため、運営の Vision API キー（env）で動かす＝運営負担。無料枠（月1,000回）内で検証する想定。
 * キー未設定/フラグ無効の環境では graceful に無効を返す（機能を出さない or 通常チャットへ誘導）。
 *
 * 【重要・コスト防衛】このエンドポイントは "運営の" Vision（と、x-gemini-key 未指定時はサーバ Gemini キー）の
 * 予算を消費する。現状は他 API 同様に認証/レート制限が無く CORS も広いため、無料枠を超えて本番公開する前に
 * 「アプリのログインセッション検証」＋「IP/ユーザー単位のレート制限」を必ず追加すること（全 API 共通の課題）。
 * テストマーケ期は、Vision キーを設定するのは監視下の検証時のみとし、無料枠の消費を運営ダッシュボードで監視する。
 */

function resolveVisionApiKey(): string {
  return (
    process.env.GOOGLE_VISION_API_KEY ||
    process.env.GOOGLE_CLOUD_VISION_API_KEY ||
    process.env.VISION_API_KEY ||
    ''
  ).trim();
}

const MAX_IMAGE_B64 = 8 * 1024 * 1024; // Vision へ送る画像の上限（ペイロード/コスト抑制）

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-gemini-key');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  try {
    const visionKey = resolveVisionApiKey();
    if (!visionKey) {
      // キー未設定＝この機能は無効。UI 側はボタンを出さない想定だが、直接叩かれても壊さない。
      return res.status(200).json({ success: false, disabled: true, error: '画像からの商品特定機能は現在無効です。' });
    }

    const headerKey = req.headers['x-gemini-key'];
    const userKey = typeof headerKey === 'string' ? headerKey : Array.isArray(headerKey) ? headerKey[0] : '';
    const geminiKey = extractGeminiApiKey(userKey || process.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '');
    if (!geminiKey) {
      return res.status(400).json({ success: false, error: 'Gemini APIキーが見つかりません。' });
    }

    const body = req.body as { imageDataUrl?: unknown; prompt?: unknown };
    const imageDataUrl = typeof body.imageDataUrl === 'string' ? body.imageDataUrl : '';
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 500) : '';
    const { base64, mimeType } = parseDataUrl(imageDataUrl);
    if (!base64 || !mimeType.startsWith('image/')) {
      return res.status(400).json({ success: false, error: '有効な画像が必要です。' });
    }
    if (base64.length > MAX_IMAGE_B64) {
      return res.status(400).json({ success: false, error: '画像が大きすぎます。縮小して再度お試しください。' });
    }

    // 1) Cloud Vision Web Detection（逆画像検索）。API キー方式で呼ぶ。
    let findings;
    try {
      const visionRes = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(visionKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{ image: { content: base64 }, features: [{ type: 'WEB_DETECTION', maxResults: 15 }] }],
        }),
      });
      if (!visionRes.ok) {
        const t = await visionRes.text().catch(() => '');
        console.error('[visionProductSearch] Vision error', visionRes.status, t.slice(0, 300));
        return res.status(502).json({ success: false, error: `画像解析に失敗しました (${visionRes.status})` });
      }
      const visionJson = await visionRes.json();
      findings = parseVisionWebDetection(visionJson);
    } catch (e: any) {
      console.error('[visionProductSearch] Vision fetch failed', e?.message);
      return res.status(502).json({ success: false, error: '画像解析サービスへの接続に失敗しました。' });
    }

    // 2) Vision の findings を根拠に Gemini で「実在商品ページURL付き」の提案を生成。
    const visionFindingsText = buildVisionFindingsText(findings);
    const { reply, recommendations, usage } = await generateVisionProductReply(geminiKey, {
      imageDataUrl,
      prompt,
      visionFindingsText,
      model: resolveAgentModel(),
    });

    return res.status(200).json({
      success: true,
      reply,
      recommendations,
      usage,
      model: resolveAgentModel(),
      visionPages: findings.pages.slice(0, 5),
    });
  } catch (e: any) {
    // 上流（Gemini 等）のエラー本文をそのままクライアントへ返さない（内部情報の漏えい防止・260725 敵対レビュー）。
    console.error('visionProductSearch error:', e?.message || e);
    res.status(500).json({ success: false, error: '商品特定に失敗しました。しばらくして再度お試しください。' });
  }
}
