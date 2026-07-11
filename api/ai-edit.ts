import { runAiEdit } from '../lib/aiEditCore.js';
import { runAiAnalyze } from '../lib/aiAnalyzeCore.js';
import { extractGeminiApiKey } from '../lib/geminiKey.js';
import { handleInpaintRequest } from '../lib/inpaint/handleInpaint.js';

// 本番サーバーレス関数。中核ロジックは lib/aiEditCore.ts（開発 vite.config.ts と共有＝挙動差ゼロ・260707）。
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
    const body = req.body ?? {};

    // マスクベース編集（削除/生成）＝アプリ保有の共通キー（Replicate 等）で実行。ユーザーの Gemini キーは不要。
    // 失敗時はクライアント側が従来の Gemini 経路へフェイルソフトする（260711・フェーズ1）。
    if (body.inpaint === true) {
      const r = await handleInpaintRequest(body);
      if (!r.success) {
        return res.status(r.status).json({ success: false, error: r.error });
      }
      return res
        .status(200)
        .json({ success: true, url: r.result.imageDataUrl, engine: r.result.engine, costUsd: r.result.costUsd ?? null });
    }

    // BYOK: リクエストヘッダのユーザーキーを最優先（無ければ管理者デバッグ用の環境変数）。
    const headerKey = req.headers['x-gemini-key'];
    const userKey = typeof headerKey === 'string' ? headerKey : Array.isArray(headerKey) ? headerKey[0] : '';
    const rawApiKey = userKey || process.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';
    const apiKey = extractGeminiApiKey(rawApiKey); // 従来(AIzaSy...)＋新(AQ....)両対応（260612）
    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'APIキーが見つかりません。' });
    }

    // 事前解析（対象説明＋遮蔽判定 occluded）は同じ /api/ai-edit に mode で相乗りさせる（Hobbyプランのサーバレス
    // 関数数上限=12 を超えないため・260709）。中核は lib/aiAnalyzeCore.ts（dev/prod 共有）。
    if (body.analyze === true) {
      const a = await runAiAnalyze(apiKey, body);
      if (!a.success) {
        return res.status(a.status).json({ success: false, error: a.error });
      }
      return res.status(200).json({ success: true, narratives: a.narratives, occluded: a.occluded });
    }

    const result = await runAiEdit(apiKey, body);
    if (!result.success) {
      return res.status(result.status).json({ success: false, error: result.error });
    }
    return res.status(200).json({ success: true, url: result.url, usage: result.usage, model: result.model });
  } catch (e: any) {
    console.error('ai-edit error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
}
