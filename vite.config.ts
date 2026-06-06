import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { v2 as cloudinary } from 'cloudinary';
import path from 'node:path';
import { getFurnitureCatalog } from './lib/furnitureCatalogService.js';
import { getLocalFurnitureCatalog } from './lib/localFurnitureCatalog.js';
import { CLOUDINARY_THUMBNAIL_FOLDER } from './constants/cloudinaryThumbnails.js';
import { sanitizeThumbnailPublicId } from './utils/furnitureThumbnailUrl.js';
import { generateGeminiImage, generateGeminiImageEdit, generatePlacementNarratives } from './lib/gemini.js';
import { normalizeObjectReference } from './lib/aiEditNormalize.js';
import { deriveMaterialPhysical } from './lib/materialPhysical.js';
import type { AiEditObjectReference } from './types.js';

export default defineConfig(({ mode }) => {
  const currentDir = path.resolve();
  const env = loadEnv(mode, currentDir, '');

  // Configure Cloudinary for Local Middleware prioritizing process.env (Secrets)
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || env.CLOUDINARY_CLOUD_NAME;
  const cloudinaryKey = process.env.CLOUDINARY_API_KEY || env.CLOUDINARY_API_KEY;
  const cloudinarySecret = process.env.CLOUDINARY_API_SECRET || env.CLOUDINARY_API_SECRET;

  cloudinary.config({
    cloud_name: cloudName,
    api_key: cloudinaryKey,
    api_secret: cloudinarySecret,
    secure: true,
  });

  return {
    resolve: {
      alias: {
        three: path.resolve(currentDir, 'node_modules/three'),
      }
    },
    plugins: [
      react(),
      {
        name: 'local-api-middleware',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            // --- Local Thumbnail Upload Endpoint (Cloudinary) ---
            if (req.url === '/api/thumbnails' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => {
                    body += chunk.toString();
                });
                req.on('end', async () => {
                    try {
                        // Ensure Cloudinary is configured with latest Secrets
                        cloudinary.config({
                            cloud_name: process.env.CLOUDINARY_CLOUD_NAME || env.CLOUDINARY_CLOUD_NAME,
                            api_key: process.env.CLOUDINARY_API_KEY || env.CLOUDINARY_API_KEY,
                            api_secret: process.env.CLOUDINARY_API_SECRET || env.CLOUDINARY_API_SECRET,
                            secure: true,
                        });

                        const { fileName, imageData } = JSON.parse(body);
                        const safeId = fileName && imageData ? sanitizeThumbnailPublicId(String(fileName)) : null;
                        if (safeId && imageData) {
                            const result = await cloudinary.uploader.upload(imageData, {
                                folder: CLOUDINARY_THUMBNAIL_FOLDER,
                                public_id: safeId,
                                overwrite: true,
                                resource_type: 'image'
                            });
                            const expectedPrefix = `${CLOUDINARY_THUMBNAIL_FOLDER}/`;
                            if (!result.public_id.startsWith(expectedPrefix) && result.public_id !== CLOUDINARY_THUMBNAIL_FOLDER) {
                                console.error('[thumbnails] unexpected public_id folder', result.public_id);
                                res.statusCode = 500;
                                res.setHeader('Content-Type', 'application/json');
                                res.end(JSON.stringify({ error: 'Upload path mismatch', publicId: result.public_id }));
                                return;
                            }
                            res.setHeader('Content-Type', 'application/json');
                            res.end(JSON.stringify({ success: true, url: result.secure_url, publicId: result.public_id }));
                        } else {
                            res.statusCode = 400;
                            res.end(JSON.stringify({ error: 'Invalid data' }));
                        }
                    } catch (e: any) {
                        console.error('Thumbnail Upload Error:', e);
                        res.statusCode = 500;
                        res.end(JSON.stringify({ error: 'Server error', details: e.message }));
                    }
                });
                return;
            }

            // --- Local Furniture Fetch Endpoint ---
            if (req.url === '/api/furniture' && req.method === 'GET') {
              try {
                // Cloudinary 未構成なら、ローカル public/models のフォールバックカタログを返す
                // （Cloudinary なしでも家具配置・Undo/Redo をローカルで試せるようにするため）。
                const hasCloudinary = !!(process.env.CLOUDINARY_CLOUD_NAME || env.CLOUDINARY_CLOUD_NAME);
                if (!hasCloudinary) {
                  const items = getLocalFurnitureCatalog();
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify({ items, _debug: { source: 'local-fallback', count: items.length } }));
                  return;
                }
                // Ensure Cloudinary is configured with latest Secrets
                cloudinary.config({
                    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || env.CLOUDINARY_CLOUD_NAME,
                    api_key: process.env.CLOUDINARY_API_KEY || env.CLOUDINARY_API_KEY,
                    api_secret: process.env.CLOUDINARY_API_SECRET || env.CLOUDINARY_API_SECRET,
                    secure: true,
                });
                const { items, stats } = await getFurnitureCatalog({ debug: true });
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ items, _debug: stats }));
              } catch (error: any) {
                console.error("Local Furniture API Error:", error.message);
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ items: [], _debug: { error: error.message } }));
              }
              return;
            }

            // --- Local Denoise Endpoint (Gemini API Image-to-Image) ---
            if (req.url === '/api/denoise' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => { body += chunk.toString(); });
                req.on('end', async () => {
                    try {
                        // 1. Secrets / 環境変数からの取得 (VITE_ を最優先)
                        const rawApiKey = (typeof req.headers['x-gemini-key'] === 'string' ? (req.headers['x-gemini-key'] as string) : '') || process.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || env.VITE_GEMINI_API_KEY || env.GEMINI_API_KEY || '';
                        
                        // 2. 正規表現による抽出（文字数制限を外し、AIzaSyから始まる文字列を確実にキャッチ）
                        const keyMatch = rawApiKey.match(/AIzaSy[\w-]+/);
                        const apiKey = keyMatch ? keyMatch[0] : '';

                        console.log("=========== API KEY SECURE CHECK (Denoise) ===========");
                        console.log("Extracted Key:", apiKey ? `VALID FORMAT (Ends with: ${apiKey.slice(-4)})` : "INVALID FORMAT OR EMPTY");
                        console.log("======================================================");

                        if (!apiKey) {
                            res.statusCode = 400;
                            res.setHeader('Content-Type', 'application/json');
                            return res.end(JSON.stringify({ success: false, error: '有効な形式のAPIキー(AIzaSy...)が見つかりません。Secretsと.envの両方に VITE_GEMINI_API_KEY が設定されているか確認し、サーバーを再起動してください。' }));
                        }

                        const { image } = JSON.parse(body);
                        if (!image) {
                            res.statusCode = 400;
                            res.setHeader('Content-Type', 'application/json');
                            return res.end(JSON.stringify({ success: false, error: '画像データが必要です。' }));
                        }

                        const baseImageBase64 = image.replace(/^data:image\/\w+;base64,/, '');

                        // 2. デノイズ・クリーンアップ用のシステムプロンプト
                        const proVisualizerPrompt = `
1. 役割と専門性
あなたは、建築ビジュアライゼーションに特化したAIレタッチ・エンジニアです。
ユーザーがアップロードする画像を読み取り、画角や構図、テクスチャの意匠を100%維持しながら、ノイズを除去し、実写写真のような質感を付与してください。
2. 品質
高性能デジタル一眼レフで撮影したような、極めて精細なディテール、フォトリアルな建築写真クオリティ。
3. テクスチャ保護
元の画像のテクスチャ（木目、布の柄、タイルの割り付け、色味）を勝手に変更しないでください。
`;

                        // 3. 公式ドキュメント準拠のマルチモーダルペイロード
                        const payload = {
                            contents: [{
                                role: "user",
                                parts: [
                                    { text: proVisualizerPrompt },
                                    {
                                        inlineData: {
                                            mimeType: "image/png",
                                            data: baseImageBase64
                                        }
                                    }
                                ]
                            }],
                            generationConfig: {
                                temperature: 0.1, // デノイズのために極めて低く設定
                                responseModalities: ["IMAGE"],
                            }
                        };

                        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent`;

                        // 4. 公式推奨の x-goog-api-key ヘッダーを使用した通信
                        const response = await fetch(endpoint, {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json',
                                'x-goog-api-key': apiKey
                            },
                            body: JSON.stringify(payload)
                        });
                        
                        if (!response.ok) {
                            const errText = await response.text();
                            console.error("Gemini Denoise API Error details:", errText);
                            res.statusCode = response.status;
                            res.setHeader('Content-Type', 'application/json');
                            return res.end(JSON.stringify({ success: false, error: `Gemini API 通信エラー: ${response.status} - ${errText}` }));
                        }

                        const result = await response.json();
                        
                        // 5. レスポンスからの画像抽出
                        try {
                            const candidate = result.candidates?.[0];
                            if (!candidate) throw new Error("No candidates returned from Gemini API");
                            
                            const generatedPart = candidate.content.parts[0];
                            let dataUrl = "";
                            
                            if (generatedPart.inlineData) {
                                dataUrl = `data:${generatedPart.inlineData.mimeType};base64,${generatedPart.inlineData.data}`;
                            } else if (generatedPart.text) {
                                dataUrl = generatedPart.text.includes('data:image') ? generatedPart.text : `data:image/jpeg;base64,${generatedPart.text}`;
                            }

                            if (!dataUrl) throw new Error("Could not extract image data from response.");

                            res.statusCode = 200;
                            res.setHeader('Content-Type', 'application/json');
                            return res.end(JSON.stringify({ success: true, url: dataUrl }));
                        } catch (err: any) {
                            console.error("Gemini Denoise Response Parsing Error:", err);
                            res.statusCode = 500;
                            res.setHeader('Content-Type', 'application/json');
                            return res.end(JSON.stringify({ success: false, error: `レスポンス解析エラー: ${err.message}` }));
                        }
                    } catch (e: any) {
                        res.statusCode = 500;
                        res.setHeader('Content-Type', 'application/json');
                        return res.end(JSON.stringify({ success: false, error: e.message }));
                    }
                });
                return;
            }

            // --- Local Render Endpoint (Gemini API Image-to-Image) ---
            if (req.url === '/api/render' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => { body += chunk.toString(); });
                req.on('end', async () => {
                    try {
                        // 1. Secrets / 環境変数からの取得 (VITE_ を最優先)
                        const rawApiKey = (typeof req.headers['x-gemini-key'] === 'string' ? (req.headers['x-gemini-key'] as string) : '') || process.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || env.VITE_GEMINI_API_KEY || env.GEMINI_API_KEY || '';
                        
                        // 2. 正規表現による抽出（文字数制限を外し、AIzaSyから始まる文字列を確実にキャッチ）
                        const keyMatch = rawApiKey.match(/AIzaSy[\w-]+/);
                        const apiKey = keyMatch ? keyMatch[0] : '';

                        console.log("=========== API KEY SECURE CHECK (Render) ===========");
                        console.log("Extracted Key:", apiKey ? `VALID FORMAT (Ends with: ${apiKey.slice(-4)})` : "INVALID FORMAT OR EMPTY");
                        console.log("======================================================");

                        if (!apiKey) {
                            res.statusCode = 400;
                            res.setHeader('Content-Type', 'application/json');
                            return res.end(JSON.stringify({ success: false, error: '有効な形式のAPIキー(AIzaSy...)が見つかりません。Secretsと.envの両方に VITE_GEMINI_API_KEY が設定されているか確認し、サーバーを再起動してください。' }));
                        }

                        const parsed = JSON.parse(body) as {
                            image?: string;
                            prompt?: string;
                            aspectRatio?: string;
                            imageSize?: string;
                        };
                        const { image, prompt, aspectRatio, imageSize } = parsed;
                        if (!image) {
                            res.statusCode = 400;
                            res.setHeader('Content-Type', 'application/json');
                            return res.end(JSON.stringify({ success: false, error: '画像データが必要です。' }));
                        }

                        const baseImageBase64 = image.replace(/^data:image\/\w+;base64,/, '');
                        const ar =
                            typeof aspectRatio === 'string' && aspectRatio.trim()
                                ? aspectRatio.trim()
                                : undefined;
                        const isz =
                            typeof imageSize === 'string' && imageSize.trim()
                                ? imageSize.trim()
                                : undefined;

                        const dataUrl = await generateGeminiImage(apiKey, baseImageBase64, prompt ?? '', {
                            aspectRatio: ar,
                            imageSize: isz,
                        });

                        res.statusCode = 200;
                        res.setHeader('Content-Type', 'application/json');
                        return res.end(JSON.stringify({ success: true, url: dataUrl }));
                    } catch (e: any) {
                        res.statusCode = 500;
                        res.setHeader('Content-Type', 'application/json');
                        return res.end(JSON.stringify({ success: false, error: e.message }));
                    }
                });
                return;
            }

            // --- Local AI Edit Endpoint (multi-reference image edit) ---
            if (req.url === '/api/ai-edit' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => { body += chunk.toString(); });
                req.on('end', async () => {
                    try {
                        const rawApiKey = (typeof req.headers['x-gemini-key'] === 'string' ? (req.headers['x-gemini-key'] as string) : '') || process.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || env.VITE_GEMINI_API_KEY || env.GEMINI_API_KEY || '';
                        const keyMatch = rawApiKey.match(/AIzaSy[\w-]+/);
                        const apiKey = keyMatch ? keyMatch[0] : '';

                        if (!apiKey) {
                            res.statusCode = 400;
                            res.setHeader('Content-Type', 'application/json');
                            return res.end(JSON.stringify({ success: false, error: '有効な形式のAPIキーが見つかりません。' }));
                        }

                        const parsed = JSON.parse(body);
                        const {
                            baseImage,
                            styleImage,
                            styleMemo,
                            objects,
                            aspectRatio,
                            imageSize,
                        } = parsed;
                        if (!baseImage) {
                            res.statusCode = 400;
                            res.setHeader('Content-Type', 'application/json');
                            return res.end(JSON.stringify({ success: false, error: 'baseImage が必要です。' }));
                        }

                        const objList: AiEditObjectReference[] = [];
                        if (Array.isArray(objects)) {
                            for (const item of objects) {
                                const n = normalizeObjectReference(item);
                                if (n) objList.push(n);
                            }
                        }
                        const memo =
                            typeof styleMemo === 'string' && styleMemo.trim() ? styleMemo.trim() : undefined;
                        const ar =
                            typeof aspectRatio === 'string' && aspectRatio.trim()
                                ? aspectRatio.trim()
                                : undefined;
                        const isz =
                            typeof imageSize === 'string' && imageSize.trim()
                                ? imageSize.trim()
                                : undefined;
                        let placementNarratives: Record<string, string> | undefined;
                        if (objList.length > 0) {
                            placementNarratives = await generatePlacementNarratives(apiKey, {
                                baseImageDataUrl: baseImage,
                                objects: objList,
                            });
                            if (placementNarratives && Object.keys(placementNarratives).length === 0) {
                                placementNarratives = undefined;
                            }
                        }

                        const dataUrl = await generateGeminiImageEdit(apiKey, {
                            baseImageDataUrl: baseImage,
                            styleImageDataUrl: styleImage ?? null,
                            styleMemo: memo,
                            objects: objList,
                            aspectRatio: ar,
                            imageSize: isz,
                            placementNarratives,
                        });

                        res.statusCode = 200;
                        res.setHeader('Content-Type', 'application/json');
                        return res.end(JSON.stringify({ success: true, url: dataUrl }));
                    } catch (e: any) {
                        console.error('ai-edit local error:', e);
                        res.statusCode = 500;
                        res.setHeader('Content-Type', 'application/json');
                        return res.end(JSON.stringify({ success: false, error: e.message }));
                    }
                });
                return;
            }

            // Mock the Vercel API Route locally
            if (req.url?.startsWith('/api/materials') && req.method === 'GET') {
              try {
                const cloudName = process.env.CLOUDINARY_CLOUD_NAME || env.CLOUDINARY_CLOUD_NAME;
                const cloudinaryKey = process.env.CLOUDINARY_API_KEY || env.CLOUDINARY_API_KEY;
                const cloudinarySecret = process.env.CLOUDINARY_API_SECRET || env.CLOUDINARY_API_SECRET;

                if (!cloudName || !cloudinaryKey || !cloudinarySecret) {
                  console.warn("WARN: Cloudinary credentials missing in .env or Secrets");
                  res.setHeader('Content-Type', 'application/json');
                  res.end(JSON.stringify([]));
                  return;
                }

                // Ensure Cloudinary is configured with latest Secrets
                cloudinary.config({
                    cloud_name: cloudName,
                    api_key: cloudinaryKey,
                    api_secret: cloudinarySecret,
                    secure: true,
                });

                const result = await cloudinary.api.resources({
                  type: 'upload',
                  prefix: 'materials/',
                  max_results: 500,
                  context: true
                });

                const mapCategory = (raw: string) => {
                  const r = (raw || '').toLowerCase();
                  if (r.includes('floor') || r.includes('flooring') || r.includes('yuka')) return 'Floor';
                  if (r.includes('ceil') || r.includes('ceiling') || r.includes('tenjo')) return 'Ceiling';
                  if (r.includes('window') || r.includes('glass') || r.includes('mado')) return 'Window';
                  if (r.includes('furn') || r.includes('kagu')) return 'Furniture';
                  return 'Wall';
                };

                const data = result.resources.map((res: any) => {
                  const parts = res.public_id.split('/');
                  const manufacturer = parts.length > 1 ? parts[1] : 'Generic';
                  const rawCategory = parts.length > 2 ? parts[2] : 'Wall';
                  const productId = parts.length > 3 ? parts[3] : res.public_id.split('/').pop();
                  
                  const category = mapCategory(rawCategory);
                  const textureUrl = res.secure_url.replace('/upload/', '/upload/f_auto,q_auto/');

                  // Production の /api/materials と同じ実寸メタデータ導出を dev でも適用（dev/prod parity）。
                  // Cloudinary Admin API のリソースも画像の width/height を返す。
                  const physical = deriveMaterialPhysical({
                    publicId: res.public_id,
                    widthPx: typeof res.width === 'number' ? res.width : undefined,
                    heightPx: typeof res.height === 'number' ? res.height : undefined,
                  });

                  return {
                    id: res.public_id,
                    name: productId,
                    brand: manufacturer,
                    category,
                    pricePerUnit: 5000,
                    unit: '㎡',
                    lossFactor: 0.15,
                    textureUrl: textureUrl,
                    color: '#e0e0e0',
                    pbr: {
                      roughness: 0.7,
                      metalness: 0.1,
                      reflectivity: 0.1,
                      glossiness: 'Matte',
                      normalMapStrength: 0.5
                    },
                    promptHint: `(${manufacturer} ${rawCategory} ${productId})`,
                    physical
                  };
                });

                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(data));
              } catch (error: any) {
                console.error("Local Middleware Error:", error.message);
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify([]));
              }
              return;
            }
            next();
          });
        }
      }
    ],
    base: './',
    build: {
      outDir: 'dist',
      sourcemap: true
    }
  };
});