import { generateAgentReply, resolveAgentModel, type AgentAttachment, type AgentChatMessage } from '../lib/gemini.js';
import { extractGeminiApiKey } from '../lib/geminiKey.js';
import type { AgentCatalogEntry } from '../types.js';

/**
 * AIエージェント相談エンドポイント（管理表 row 208/214・プランA）。
 * 会話履歴（と任意の現在画像）を受け取り、建築・内装デザインの助言テキストを返す。
 */
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
    const headerKey = req.headers['x-gemini-key'];
    const userKey = typeof headerKey === 'string' ? headerKey : Array.isArray(headerKey) ? headerKey[0] : '';
    const apiKey = extractGeminiApiKey(
      userKey || process.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || ''
    );
    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'APIキーが見つかりません。' });
    }

    const body = req.body as { messages?: AgentChatMessage[]; imageDataUrl?: string | null; catalog?: unknown; files?: unknown };
    const messages: AgentChatMessage[] = Array.isArray(body.messages)
      ? body.messages
          .filter(
            (m): m is AgentChatMessage =>
              !!m &&
              (m.role === 'user' || m.role === 'assistant') &&
              typeof m.content === 'string' &&
              m.content.trim().length > 0
          )
          .slice(-12)
      : [];
    if (messages.length === 0) {
      return res.status(400).json({ success: false, error: 'メッセージが必要です。' });
    }

    // Tier2（260620）: クライアントが渡す家具カタログ（推薦候補・index 付き）。
    const catalog: AgentCatalogEntry[] = Array.isArray(body.catalog)
      ? (body.catalog as unknown[])
          .filter((c): c is AgentCatalogEntry => !!c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string')
          .slice(0, 80)
      : [];

    // 添付ファイル（画像/PDF/音声/動画/テキスト等・複数）。data URL 形式のみ受理し、件数/合計サイズを制限（260702）。
    const MAX_FILES = 10;
    const MAX_TOTAL_B64 = 18 * 1024 * 1024; // Gemini inline 上限(~20MB)手前で頭打ち
    const files: AgentAttachment[] = [];
    if (Array.isArray(body.files)) {
      let total = 0;
      for (const f of body.files as unknown[]) {
        if (files.length >= MAX_FILES) break;
        if (!f || typeof f !== 'object') continue;
        const rec = f as { name?: unknown; dataUrl?: unknown };
        const dataUrl = typeof rec.dataUrl === 'string' ? rec.dataUrl : '';
        if (!/^data:[^;,]+;base64,/i.test(dataUrl)) continue;
        total += dataUrl.length;
        if (total > MAX_TOTAL_B64) break;
        files.push({ name: typeof rec.name === 'string' ? rec.name : undefined, dataUrl });
      }
    }

    const { reply, recommendations, usage } = await generateAgentReply(apiKey, {
      messages,
      imageDataUrl: typeof body.imageDataUrl === 'string' ? body.imageDataUrl : null,
      catalog,
      files,
    });
    return res.status(200).json({ success: true, reply, recommendations, usage, model: resolveAgentModel() });
  } catch (e: any) {
    console.error('agent error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
}
