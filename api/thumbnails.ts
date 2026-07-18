import { v2 as cloudinary } from 'cloudinary';
import { CLOUDINARY_THUMBNAIL_FOLDER } from '../constants/cloudinaryThumbnails.js';
import { sanitizeThumbnailPublicId } from '../utils/furnitureThumbnailUrl.js';

// Cloudinary Configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || process.env.VITE_CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

export default async function handler(req: any, res: any) {
    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // POSTメソッド以外は弾く
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { fileName, imageData } = req.body;
    if (!fileName || !imageData) {
        return res.status(400).json({ error: 'Missing fileName or imageData' });
    }

    const safeId = sanitizeThumbnailPublicId(String(fileName));
    if (!safeId) {
        return res.status(400).json({ error: 'Invalid fileName' });
    }

    try {
        // Base64画像データをCloudinaryにアップロード
        const result = await cloudinary.uploader.upload(imageData, {
            folder: CLOUDINARY_THUMBNAIL_FOLDER,
            public_id: safeId,
            overwrite: true,
            resource_type: 'image'
        });

        const expectedPrefix = `${CLOUDINARY_THUMBNAIL_FOLDER}/`;
        if (!result.public_id.startsWith(expectedPrefix) && result.public_id !== CLOUDINARY_THUMBNAIL_FOLDER) {
            console.error('[thumbnails] unexpected public_id folder', result.public_id);
            return res.status(500).json({ error: 'Upload path mismatch', publicId: result.public_id });
        }

        // 配信URLに f_auto,q_auto を付与して自動軽量化（素材/テクスチャ配信と同じ方式・260718）。
        // 同一画像を最適フォーマット/画質で配信するのみで、保存アセットや表示挙動は不変（既存の保存済みURLも従来どおり動作）。
        const optimizedUrl = result.secure_url.replace('/upload/', '/upload/f_auto,q_auto/');
        console.log(`Uploaded to Cloudinary: ${optimizedUrl}`);
        res.status(200).json({
            success: true,
            url: optimizedUrl,
            publicId: result.public_id
        });
    } catch (error) {
        console.error("Cloudinary Upload Error:", error);
        res.status(500).json({ error: 'Failed to upload thumbnail' });
    }
}
