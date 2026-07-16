import { generateGeminiImage, GEMINI_IMAGE_MODEL } from '../lib/gemini.js';
import { extractGeminiApiKey } from '../lib/geminiKey.js';

export default async function handler(req: any, res: any) {
    // CORS Headers
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

        const { image, prompt, aspectRatio, imageSize, timeOfDay } = req.body as {
            image?: string;
            prompt?: string;
            aspectRatio?: string;
            imageSize?: string;
            timeOfDay?: string;
        };
        if (!image) {
            return res.status(400).json({ success: false, error: '画像データが必要です。' });
        }

        const baseImageBase64 = image.replace(/^data:image\/\w+;base64,/, '');
        const ar = typeof aspectRatio === 'string' && aspectRatio.trim() ? aspectRatio.trim() : undefined;
        const isz = typeof imageSize === 'string' && imageSize.trim() ? imageSize.trim() : undefined;
        // ユーザーが設定した時間帯（昼/夕方/夜）。既知の値のみ通す（260717）。
        const tod = timeOfDay === 'day' || timeOfDay === 'evening' || timeOfDay === 'night' ? timeOfDay : undefined;
        const { url: dataUrl, usage } = await generateGeminiImage(apiKey, baseImageBase64, prompt ?? '', {
            aspectRatio: ar,
            imageSize: isz,
            timeOfDay: tod,
        });

        return res.status(200).json({ success: true, url: dataUrl, usage, model: GEMINI_IMAGE_MODEL });
    } catch (e: any) {
        console.error("Server Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
}
