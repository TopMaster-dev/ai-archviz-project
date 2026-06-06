import { generateGeminiImage } from '../lib/gemini.js';

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
        const keyMatch = rawApiKey.match(/AIzaSy[\w-]+/);
        const apiKey = keyMatch ? keyMatch[0] : '';

        if (!apiKey) {
            return res.status(400).json({ success: false, error: 'APIキーが見つかりません。' });
        }

        const { image, prompt, aspectRatio, imageSize } = req.body as {
            image?: string;
            prompt?: string;
            aspectRatio?: string;
            imageSize?: string;
        };
        if (!image) {
            return res.status(400).json({ success: false, error: '画像データが必要です。' });
        }

        const baseImageBase64 = image.replace(/^data:image\/\w+;base64,/, '');
        const ar = typeof aspectRatio === 'string' && aspectRatio.trim() ? aspectRatio.trim() : undefined;
        const isz = typeof imageSize === 'string' && imageSize.trim() ? imageSize.trim() : undefined;
        const dataUrl = await generateGeminiImage(apiKey, baseImageBase64, prompt ?? '', {
            aspectRatio: ar,
            imageSize: isz,
        });

        return res.status(200).json({ success: true, url: dataUrl });
    } catch (e: any) {
        console.error("Server Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
}
