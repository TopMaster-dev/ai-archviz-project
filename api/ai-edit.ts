import { generateGeminiImageEdit, generatePlacementNarratives } from '../lib/gemini.js';
import type { AiEditObjectReference } from '../types.js';
import { normalizeObjectReference } from '../lib/aiEditNormalize.js';
import { extractGeminiApiKey } from '../lib/geminiKey.js';

function normalizeImageDataUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === 'null' || lower === 'undefined') return null;
  return s;
}

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-gemini-key');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // BYOK: リクエストヘッダのユーザーキーを最優先（無ければ管理者デバッグ用の環境変数）。
    const headerKey = req.headers['x-gemini-key'];
    const userKey = typeof headerKey === 'string' ? headerKey : Array.isArray(headerKey) ? headerKey[0] : '';
    const rawApiKey = userKey || process.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';
    // 従来(AIzaSy...)と新フォーマット(AQ....)の両対応（260612）。
    const apiKey = extractGeminiApiKey(rawApiKey);

    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'APIキーが見つかりません。' });
    }

    const body = req.body as {
      baseImage?: string;
      styleImage?: string | null;
      styleMemo?: string;
      objects?: unknown[];
      aspectRatio?: string;
      imageSize?: string;
      coordinate?: boolean;
    };

    if (!body.baseImage) {
      return res.status(400).json({ success: false, error: 'baseImage が必要です。' });
    }

    // コーディネート（完全お任せ）モード（row 207/213）: 個別の入力は不要なため入力必須チェックを省く。
    const coordinate = body.coordinate === true;

    const objects: AiEditObjectReference[] = [];
    if (Array.isArray(body.objects)) {
      for (const item of body.objects) {
        const n = normalizeObjectReference(item);
        if (n) objects.push(n);
      }
    }

    const styleMemo =
      typeof body.styleMemo === 'string' && body.styleMemo.trim()
        ? body.styleMemo.trim()
        : undefined;
    const styleImageDataUrl = normalizeImageDataUrl(body.styleImage);
    const hasSituationInput = !!styleImageDataUrl || !!styleMemo;
    const hasAreaEditInput = objects.some(
      (o) =>
        !!normalizeImageDataUrl(o.imageDataUrl) ||
        o.memo.trim().length > 0 ||
        o.placementMemos.some((m) => m.trim().length > 0)
    );
    const areaPlacementCount = objects.reduce((sum, o) => sum + o.placements.length, 0);
    if (!coordinate && !hasSituationInput && !hasAreaEditInput) {
      return res.status(400).json({
        success: false,
        error: 'AIデザインまたはエリア編集で、画像かテキストを1つ以上設定してください。',
      });
    }
    if (hasAreaEditInput && areaPlacementCount === 0) {
      return res.status(400).json({
        success: false,
        error: 'エリア編集を使う場合は、範囲選択を1つ以上設定してください。',
      });
    }
    const aspectRatio =
      typeof body.aspectRatio === 'string' && body.aspectRatio.trim()
        ? body.aspectRatio.trim()
        : undefined;
    const imageSize =
      typeof body.imageSize === 'string' && body.imageSize.trim()
        ? body.imageSize.trim()
        : undefined;
    let placementNarratives: Record<string, string> | undefined;
    if (objects.length > 0) {
      placementNarratives = await generatePlacementNarratives(apiKey, {
        baseImageDataUrl: body.baseImage,
        objects,
      });
      if (placementNarratives && Object.keys(placementNarratives).length === 0) {
        placementNarratives = undefined;
      }
    }

    const dataUrl = await generateGeminiImageEdit(apiKey, {
      baseImageDataUrl: body.baseImage,
      styleImageDataUrl,
      styleMemo,
      objects,
      aspectRatio,
      imageSize,
      placementNarratives,
      coordinate,
    });

    return res.status(200).json({ success: true, url: dataUrl });
  } catch (e: any) {
    console.error('ai-edit error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
}
