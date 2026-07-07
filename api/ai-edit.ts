import { runAiEdit } from '../lib/aiEditCore.js';
import { extractGeminiApiKey } from '../lib/geminiKey.js';

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
    // BYOK: リクエストヘッダのユーザーキーを最優先（無ければ管理者デバッグ用の環境変数）。
    const headerKey = req.headers['x-gemini-key'];
    const userKey = typeof headerKey === 'string' ? headerKey : Array.isArray(headerKey) ? headerKey[0] : '';
    const rawApiKey = userKey || process.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';
    const apiKey = extractGeminiApiKey(rawApiKey); // 従来(AIzaSy...)＋新(AQ....)両対応（260612）
    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'APIキーが見つかりません。' });
    }

    const result = await runAiEdit(apiKey, req.body ?? {});
    if (!result.success) {
      return res.status(result.status).json({ success: false, error: result.error });
    }
    return res.status(200).json({ success: true, url: result.url, usage: result.usage, model: result.model });
  } catch (e: any) {
    console.error('ai-edit error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
}
