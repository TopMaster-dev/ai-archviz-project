import { generateAgentReply, type AgentChatMessage } from '../lib/gemini.js';
import { extractGeminiApiKey } from '../lib/geminiKey.js';

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

    const body = req.body as { messages?: AgentChatMessage[]; imageDataUrl?: string | null };
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

    const reply = await generateAgentReply(apiKey, {
      messages,
      imageDataUrl: typeof body.imageDataUrl === 'string' ? body.imageDataUrl : null,
    });
    return res.status(200).json({ success: true, reply });
  } catch (e: any) {
    console.error('agent error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
}
