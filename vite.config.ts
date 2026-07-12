import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { lpGalleryPlugin } from './vite-plugins/lpGallery.js';
import { v2 as cloudinary } from 'cloudinary';
import path from 'node:path';
import { getFurnitureCatalog } from './lib/furnitureCatalogService.js';
import { getLocalFurnitureCatalog } from './lib/localFurnitureCatalog.js';
import { CLOUDINARY_THUMBNAIL_FOLDER } from './constants/cloudinaryThumbnails.js';
import { sanitizeThumbnailPublicId } from './utils/furnitureThumbnailUrl.js';
import { generateAgentReply, generateGeminiImage, resolveAgentModel, GEMINI_IMAGE_MODEL, type AgentChatMessage } from './lib/gemini.js';
import { STORAGE_SOFT_LIMIT_BYTES, STORAGE_WARN_THRESHOLD_BYTES } from './lib/storageLimits.js';
import { extractGeminiApiKey } from './lib/geminiKey.js';
import { runAiEdit } from './lib/aiEditCore.js';
import { runAiAnalyze } from './lib/aiAnalyzeCore.js';
import { handleInpaintRequest } from './lib/inpaint/handleInpaint.js';
import { deriveMaterialPhysical } from './lib/materialPhysical.js';

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
    // 開発/プレビューサーバのポートを 3000 に固定する。
    // Supabase の Site URL / Redirect URL（招待リンクのリダイレクト先）が
    // http://localhost:3000 のため、ポートを揃えないと招待リンクが空きポートに当たり
    // 「アプリが開かない」状態になる。strictPort=true なら 3000 が使えないとき
    // 黙って別ポートへ移らず失敗させ、ポート不一致の再発を防ぐ。
    server: { port: 3000, strictPort: true },
    preview: { port: 3000, strictPort: true },
    resolve: {
      alias: {
        three: path.resolve(currentDir, 'node_modules/three'),
      }
    },
    plugins: [
      react(),
      lpGalleryPlugin(), // LPギャラリー: public/assets/lp-gallery/ を 'virtual:lp-gallery' で供給（260625）
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

            // 旧 /api/denoise（UI 未接続のノイズ除去API）は削除（260613・管理表 row 18/254）。
            // 本番は api/ の各サーバーレス関数を使用し、デノイズ経路は存在しない。

            // --- Local Render Endpoint (Gemini API Image-to-Image) ---
            if (req.url === '/api/render' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => { body += chunk.toString(); });
                req.on('end', async () => {
                    try {
                        // 1. Secrets / 環境変数からの取得 (VITE_ を最優先)
                        const rawApiKey = (typeof req.headers['x-gemini-key'] === 'string' ? (req.headers['x-gemini-key'] as string) : '') || process.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || env.VITE_GEMINI_API_KEY || env.GEMINI_API_KEY || '';
                        
                        // 2. キー抽出（従来 AIzaSy... と新フォーマット AQ.... の両対応・260612）
                        const apiKey = extractGeminiApiKey(rawApiKey);

                        console.log("=========== API KEY SECURE CHECK (Render) ===========");
                        console.log("Extracted Key:", apiKey ? `VALID FORMAT (Ends with: ${apiKey.slice(-4)})` : "INVALID FORMAT OR EMPTY");
                        console.log("======================================================");

                        if (!apiKey) {
                            res.statusCode = 400;
                            res.setHeader('Content-Type', 'application/json');
                            return res.end(JSON.stringify({ success: false, error: '有効な形式のAPIキー(AIzaSy... または AQ....)が見つかりません。Secretsと.envの両方に VITE_GEMINI_API_KEY が設定されているか確認し、サーバーを再起動してください。' }));
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

                        const { url: dataUrl, usage } = await generateGeminiImage(apiKey, baseImageBase64, prompt ?? '', {
                            aspectRatio: ar,
                            imageSize: isz,
                        });

                        res.statusCode = 200;
                        res.setHeader('Content-Type', 'application/json');
                        return res.end(JSON.stringify({ success: true, url: dataUrl, usage, model: GEMINI_IMAGE_MODEL }));
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
                        const parsedEarly = body ? JSON.parse(body) : {};
                        // マスクベース編集（削除/生成）＝アプリ保有の共通キー（Replicate 等）で実行。Gemini キー不要。
                        // 本番 api/ai-edit.ts と同一の共有ハンドラ（handleInpaintRequest）＝開発と本番で挙動一致（260711）。
                        if (parsedEarly && parsedEarly.inpaint === true) {
                            const r = await handleInpaintRequest(parsedEarly);
                            res.statusCode = r.success ? 200 : r.status;
                            res.setHeader('Content-Type', 'application/json');
                            return res.end(
                                JSON.stringify(
                                    r.success
                                        ? { success: true, url: r.result.imageDataUrl, engine: r.result.engine, costUsd: r.result.costUsd ?? null }
                                        : { success: false, error: r.error }
                                )
                            );
                        }
                        const rawApiKey = (typeof req.headers['x-gemini-key'] === 'string' ? (req.headers['x-gemini-key'] as string) : '') || process.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || env.VITE_GEMINI_API_KEY || env.GEMINI_API_KEY || '';
                        // 従来(AIzaSy...)と新フォーマット(AQ....)の両対応（260612）
                        const apiKey = extractGeminiApiKey(rawApiKey);
                        if (!apiKey) {
                            res.statusCode = 400;
                            res.setHeader('Content-Type', 'application/json');
                            return res.end(JSON.stringify({ success: false, error: '有効な形式のAPIキーが見つかりません。' }));
                        }
                        // 本番 api/ai-edit.ts と同一の共有ハンドラ（lib/aiEditCore.ts）を呼ぶ＝開発と本番で挙動が完全一致（260707）。
                        // 空/不正な body は本番同様 {} 扱い（→400「baseImage が必要」）に。JSON.parse を巻き込んで500にしない。
                        const parsed = body ? JSON.parse(body) : {};
                        // 事前解析（遮蔽判定つき）は同じ /api/ai-edit に analyze:true で相乗り（本番と同一・関数数上限対策260709）。
                        if (parsed && parsed.analyze === true) {
                            const a = await runAiAnalyze(apiKey, parsed);
                            res.statusCode = a.success ? 200 : a.status;
                            res.setHeader('Content-Type', 'application/json');
                            return res.end(
                                JSON.stringify(
                                    a.success
                                        ? { success: true, narratives: a.narratives, occluded: a.occluded }
                                        : { success: false, error: a.error }
                                )
                            );
                        }
                        const result = await runAiEdit(apiKey, parsed);
                        res.statusCode = result.success ? 200 : result.status;
                        res.setHeader('Content-Type', 'application/json');
                        return res.end(
                            JSON.stringify(
                                result.success
                                    ? { success: true, url: result.url, usage: result.usage, model: result.model }
                                    : { success: false, error: result.error }
                            )
                        );
                    } catch (e: any) {
                        console.error('ai-edit local error:', e);
                        res.statusCode = 500;
                        res.setHeader('Content-Type', 'application/json');
                        return res.end(JSON.stringify({ success: false, error: e.message }));
                    }
                });
                return;
            }

            // --- Local AI Agent Endpoint (text chat advice) ---
            if (req.url === '/api/agent' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => { body += chunk.toString(); });
                req.on('end', async () => {
                    try {
                        const rawApiKey = (typeof req.headers['x-gemini-key'] === 'string' ? (req.headers['x-gemini-key'] as string) : '') || process.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || env.VITE_GEMINI_API_KEY || env.GEMINI_API_KEY || '';
                        const apiKey = extractGeminiApiKey(rawApiKey);
                        if (!apiKey) {
                            res.statusCode = 400;
                            res.setHeader('Content-Type', 'application/json');
                            return res.end(JSON.stringify({ success: false, error: '有効な形式のAPIキーが見つかりません。' }));
                        }
                        const parsed = JSON.parse(body) as { messages?: AgentChatMessage[]; imageDataUrl?: string | null };
                        const messages: AgentChatMessage[] = Array.isArray(parsed.messages)
                            ? parsed.messages
                                  .filter(
                                      (m): m is AgentChatMessage =>
                                          !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0
                                  )
                                  .slice(-12)
                            : [];
                        if (messages.length === 0) {
                            res.statusCode = 400;
                            res.setHeader('Content-Type', 'application/json');
                            return res.end(JSON.stringify({ success: false, error: 'メッセージが必要です。' }));
                        }
                        const { reply, usage } = await generateAgentReply(apiKey, {
                            messages,
                            imageDataUrl: typeof parsed.imageDataUrl === 'string' ? parsed.imageDataUrl : null,
                        });
                        res.statusCode = 200;
                        res.setHeader('Content-Type', 'application/json');
                        return res.end(JSON.stringify({ success: true, reply, usage, model: resolveAgentModel() }));
                    } catch (e: any) {
                        console.error('agent local error:', e);
                        res.statusCode = 500;
                        res.setHeader('Content-Type', 'application/json');
                        return res.end(JSON.stringify({ success: false, error: e.message }));
                    }
                });
                return;
            }

            // 端末・IP ログイン記録（row 53）。本番 api/session-log.ts のローカル版。
            if (req.url === '/api/session-log' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => { body += chunk.toString(); });
                req.on('end', async () => {
                    res.setHeader('Content-Type', 'application/json');
                    try {
                        const sbUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || env.SUPABASE_URL || env.VITE_SUPABASE_URL || '';
                        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
                        if (!sbUrl || !serviceKey) {
                            res.statusCode = 200;
                            return res.end(JSON.stringify({ success: false, skipped: true, reason: 'server-not-configured' }));
                        }
                        const authHeader = (req.headers['authorization'] as string) || '';
                        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
                        if (!token) {
                            res.statusCode = 200;
                            return res.end(JSON.stringify({ success: false, skipped: true, reason: 'no-token' }));
                        }
                        const pickIp = (h: any): string | null => {
                            const raw = Array.isArray(h) ? h[0] : h;
                            return typeof raw === 'string' && raw.trim() ? raw.split(',')[0].trim() : null;
                        };
                        const ip = pickIp(req.headers['x-real-ip']) || pickIp(req.headers['x-vercel-forwarded-for']) || pickIp(req.headers['x-forwarded-for']) || req.socket?.remoteAddress || null;
                        const parsed = JSON.parse(body || '{}') as { userAgent?: string; screen?: string; timezone?: string; language?: string };
                        const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : null);
                        const userAgent = str(parsed.userAgent, 500);
                        const screen = str(parsed.screen, 32);
                        const { createClient } = await import('@supabase/supabase-js');
                        const admin = createClient(sbUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
                        const { data: u, error: uErr } = await admin.auth.getUser(token);
                        const userId = u?.user?.id;
                        if (uErr || !userId) {
                            res.statusCode = 200;
                            return res.end(JSON.stringify({ success: false, skipped: true, reason: 'invalid-token' }));
                        }
                        // AI利用の記録（260712・本番 api/session-log.ts と一致）: kind:'ai_usage' なら service_role で ai_usage_events へ。
                        if (parsed && (parsed as { kind?: string }).kind === 'ai_usage') {
                            const uu = parsed as { feature?: string; model?: string; imageCount?: number; projectId?: string | null; usage?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | null };
                            const num = (v: unknown) => Math.max(0, Math.round(Number(v) || 0));
                            const { error: aiErr } = await admin.from('ai_usage_events').insert({
                                user_id: userId,
                                project_id: typeof uu.projectId === 'string' ? uu.projectId : null,
                                feature: str(uu.feature, 32) || 'ai_edit',
                                model: str(uu.model, 128),
                                input_tokens: num(uu.usage?.promptTokenCount),
                                output_tokens: num(uu.usage?.candidatesTokenCount),
                                total_tokens: num(uu.usage?.totalTokenCount),
                                image_count: num(uu.imageCount),
                            });
                            res.statusCode = 200;
                            return res.end(JSON.stringify(aiErr ? { success: false, reason: 'insert-failed' } : { success: true }));
                        }
                        // INSERT 失敗（例: キーが anon で RLS 拒否）を握りつぶさず error を検査する。
                        const { error: insErr } = await admin.from('login_events').insert({
                            user_id: userId,
                            ip,
                            user_agent: userAgent,
                            screen,
                            timezone: str(parsed.timezone, 64),
                            language: str(parsed.language, 32),
                        });
                        if (insErr) {
                            console.error('session-log local insert failed:', insErr.message);
                            res.statusCode = 200;
                            return res.end(JSON.stringify({ success: false, reason: 'insert-failed', error: insErr.message }));
                        }
                        // 自動アカウントロック（row 54・フラグ ON 時のみ）。ベストエフォート。
                        if ((process.env.ENABLE_AUTO_ACCOUNT_LOCK || env.ENABLE_AUTO_ACCOUNT_LOCK) === 'true' && ip && userAgent) {
                            const { error: lockErr } = await admin.rpc('evaluate_account_lock', {
                                p_ip: ip, p_user_agent: userAgent, p_screen: screen,
                                p_threshold: Number(process.env.AUTO_LOCK_THRESHOLD || env.AUTO_LOCK_THRESHOLD || 3),
                                p_window_hours: Number(process.env.AUTO_LOCK_WINDOW_HOURS || env.AUTO_LOCK_WINDOW_HOURS || 24),
                            });
                            if (lockErr) console.error('evaluate_account_lock local failed:', lockErr.message);
                        }
                        res.statusCode = 200;
                        return res.end(JSON.stringify({ success: true }));
                    } catch (e: any) {
                        console.error('session-log local error:', e?.message || e);
                        res.statusCode = 200;
                        return res.end(JSON.stringify({ success: false, error: e?.message }));
                    }
                });
                return;
            }

            // 事前削除通知メール（row 106）。本番 api/cron/purge-warning.ts のローカル版。
            // ローカル検証: curl -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/cron/purge-warning
            if (req.url === '/api/cron/purge-warning' && (req.method === 'GET' || req.method === 'POST')) {
                void (async () => {
                    res.setHeader('Content-Type', 'application/json');
                    const secret = process.env.CRON_SECRET || env.CRON_SECRET || '';
                    const auth = (req.headers['authorization'] as string) || '';
                    if (!secret || auth !== `Bearer ${secret}`) {
                        res.statusCode = 401;
                        return res.end(JSON.stringify({ error: 'Unauthorized' }));
                    }
                    try {
                        const { runPurgeWarning } = await import('./lib/server/purgeWarning.js');
                        const result = await runPurgeWarning(
                            {
                                url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || env.SUPABASE_URL || env.VITE_SUPABASE_URL || '',
                                serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '',
                                smtpHost: process.env.SMTP_HOST || env.SMTP_HOST || '',
                                smtpPort: Number(process.env.SMTP_PORT || env.SMTP_PORT || 587),
                                smtpSecure: String(process.env.SMTP_SECURE || env.SMTP_SECURE || '').toLowerCase() === 'true',
                                smtpUser: process.env.SMTP_USER || env.SMTP_USER || undefined,
                                smtpPass: process.env.SMTP_PASS || env.SMTP_PASS || undefined,
                                smtpFrom: process.env.SMTP_FROM || env.SMTP_FROM || process.env.SMTP_USER || env.SMTP_USER || '',
                            },
                            new Date().toISOString(),
                        );
                        res.statusCode = 200;
                        return res.end(JSON.stringify(result));
                    } catch (e: any) {
                        console.error('purge-warning local error:', e?.message || e);
                        res.statusCode = 200;
                        return res.end(JSON.stringify({ success: false, reason: 'error' }));
                    }
                })();
                return;
            }

            // 孤児 AI生成画像の一回限りの掃除（260629）。本番 api/admin/orphan-cleanup.ts のローカル版。
            // 確認: curl -H "Authorization: Bearer <CRON_SECRET>" -X POST http://localhost:3000/api/admin/orphan-cleanup
            // 実削除: 末尾に ?execute=1 を付ける。
            if (req.url?.split('?')[0] === '/api/admin/orphan-cleanup' && (req.method === 'GET' || req.method === 'POST')) {
                void (async () => {
                    res.setHeader('Content-Type', 'application/json');
                    // 管理ダッシュボード読取（メール許可リスト認証・本番 api/admin/orphan-cleanup.ts と一致・260711）。
                    const url0 = new URL(req.url || '', 'http://x');
                    const action = url0.searchParams.get('action') || '';
                    if (['whoami', 'keyhealth', 'usage', 'testkey', 'infra'].includes(action)) {
                        const authHeader = (req.headers['authorization'] as string) || '';
                        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
                        const { verifyAdmin, getKeyHealth, getUsageSummary, testKey } = await import('./lib/server/adminDashboard.js');
                        const admin = await verifyAdmin(token);
                        if (action === 'whoami') {
                            res.statusCode = 200;
                            return res.end(JSON.stringify({ isAdmin: admin.ok, email: admin.ok ? admin.email : null }));
                        }
                        if (!admin.ok) { res.statusCode = admin.status; return res.end(JSON.stringify({ error: admin.error })); }
                        res.statusCode = 200;
                        if (action === 'keyhealth') return res.end(JSON.stringify({ success: true, keys: getKeyHealth() }));
                        if (action === 'usage') return res.end(JSON.stringify({ success: true, summary: await getUsageSummary() }));
                        if (action === 'infra') {
                            const { getInfraStatus } = await import('./lib/server/adminInfra.js');
                            return res.end(JSON.stringify({ success: true, infra: await getInfraStatus() }));
                        }
                        // testkey
                        const engine = url0.searchParams.get('engine') || '';
                        if (engine !== 'gemini' && engine !== 'replicate') { res.statusCode = 400; return res.end(JSON.stringify({ error: "engine は 'gemini' か 'replicate'。" })); }
                        return res.end(JSON.stringify({ success: true, result: await testKey(engine) }));
                    }
                    const secret = process.env.CRON_SECRET || env.CRON_SECRET || '';
                    const auth = (req.headers['authorization'] as string) || '';
                    if (!secret || auth !== `Bearer ${secret}`) {
                        res.statusCode = 401;
                        return res.end(JSON.stringify({ error: 'Unauthorized' }));
                    }
                    const execute = /(?:[?&])execute=1(?:&|$)/.test(req.url || '');
                    try {
                        const { runOrphanCleanup } = await import('./lib/server/orphanCleanup.js');
                        const result = await runOrphanCleanup({
                            url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || env.SUPABASE_URL || env.VITE_SUPABASE_URL || '',
                            serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '',
                        }, { dryRun: !execute });
                        res.statusCode = result.success ? 200 : 500;
                        return res.end(JSON.stringify(result));
                    } catch (e: any) {
                        console.error('orphan-cleanup local error:', e?.message || e);
                        res.statusCode = 500;
                        return res.end(JSON.stringify({ success: false, reason: 'error' }));
                    }
                })();
                return;
            }

            // 猶予超過プロジェクトの物理削除＋容量解放（260629）。本番 api/cron/purge-projects.ts のローカル版。
            // ローカル検証: curl -H "Authorization: Bearer <CRON_SECRET>" -X POST http://localhost:3000/api/cron/purge-projects
            if (req.url === '/api/cron/purge-projects' && (req.method === 'GET' || req.method === 'POST')) {
                void (async () => {
                    res.setHeader('Content-Type', 'application/json');
                    const secret = process.env.CRON_SECRET || env.CRON_SECRET || '';
                    const auth = (req.headers['authorization'] as string) || '';
                    if (!secret || auth !== `Bearer ${secret}`) {
                        res.statusCode = 401;
                        return res.end(JSON.stringify({ error: 'Unauthorized' }));
                    }
                    try {
                        const { runPurgeProjects } = await import('./lib/server/purgeProjects.js');
                        const result = await runPurgeProjects({
                            url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || env.SUPABASE_URL || env.VITE_SUPABASE_URL || '',
                            serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '',
                        });
                        res.statusCode = result.success ? 200 : 500;
                        return res.end(JSON.stringify(result));
                    } catch (e: any) {
                        console.error('purge-projects local error:', e?.message || e);
                        res.statusCode = 500;
                        return res.end(JSON.stringify({ success: false, reason: 'error' }));
                    }
                })();
                return;
            }

            // 容量警告メール（row 31）。本番 api/cron/storage-warning.ts のローカル版。
            // ローカル検証: curl -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/cron/storage-warning
            if (req.url === '/api/cron/storage-warning' && (req.method === 'GET' || req.method === 'POST')) {
                void (async () => {
                    res.setHeader('Content-Type', 'application/json');
                    const secret = process.env.CRON_SECRET || env.CRON_SECRET || '';
                    const auth = (req.headers['authorization'] as string) || '';
                    if (!secret || auth !== `Bearer ${secret}`) {
                        res.statusCode = 401;
                        return res.end(JSON.stringify({ error: 'Unauthorized' }));
                    }
                    try {
                        const { runStorageWarning } = await import('./lib/server/storageWarning.js');
                        const result = await runStorageWarning(
                            {
                                url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || env.SUPABASE_URL || env.VITE_SUPABASE_URL || '',
                                serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '',
                                smtpHost: process.env.SMTP_HOST || env.SMTP_HOST || '',
                                smtpPort: Number(process.env.SMTP_PORT || env.SMTP_PORT || 587),
                                smtpSecure: String(process.env.SMTP_SECURE || env.SMTP_SECURE || '').toLowerCase() === 'true',
                                smtpUser: process.env.SMTP_USER || env.SMTP_USER || undefined,
                                smtpPass: process.env.SMTP_PASS || env.SMTP_PASS || undefined,
                                smtpFrom: process.env.SMTP_FROM || env.SMTP_FROM || process.env.SMTP_USER || env.SMTP_USER || '',
                                thresholdBytes: Number(process.env.STORAGE_WARN_BYTES || env.STORAGE_WARN_BYTES || STORAGE_WARN_THRESHOLD_BYTES),
                                limitBytes: Number(process.env.STORAGE_LIMIT_BYTES || env.STORAGE_LIMIT_BYTES || STORAGE_SOFT_LIMIT_BYTES),
                            },
                            new Date().toISOString(),
                        );
                        res.statusCode = 200;
                        return res.end(JSON.stringify(result));
                    } catch (e: any) {
                        console.error('storage-warning local error:', e?.message || e);
                        res.statusCode = 200;
                        return res.end(JSON.stringify({ success: false, reason: 'error' }));
                    }
                })();
                return;
            }

            // 容量警告メールの即時送信（row 31・260629）。本番 api/storage-warning-self.ts のローカル版。
            // ログイン中ユーザーの access token（Authorization: Bearer）で本人特定し、その本人だけに送る。
            if (req.url === '/api/storage-warning-self' && req.method === 'POST') {
                void (async () => {
                    res.setHeader('Content-Type', 'application/json');
                    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || env.SUPABASE_URL || env.VITE_SUPABASE_URL || '';
                    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
                    if (!url || !serviceKey) {
                        res.statusCode = 200;
                        return res.end(JSON.stringify({ success: false, reason: 'server-not-configured' }));
                    }
                    const auth = (req.headers['authorization'] as string) || '';
                    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
                    if (!token) {
                        res.statusCode = 401;
                        return res.end(JSON.stringify({ error: 'Unauthorized' }));
                    }
                    try {
                        const { createClient } = await import('@supabase/supabase-js');
                        const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
                        const { data: userData, error: userErr } = await admin.auth.getUser(token);
                        const ownerId = userData?.user?.id;
                        if (userErr || !ownerId) {
                            res.statusCode = 401;
                            return res.end(JSON.stringify({ error: 'Unauthorized' }));
                        }
                        const { runStorageWarning } = await import('./lib/server/storageWarning.js');
                        const result = await runStorageWarning(
                            {
                                url,
                                serviceKey,
                                smtpHost: process.env.SMTP_HOST || env.SMTP_HOST || '',
                                smtpPort: Number(process.env.SMTP_PORT || env.SMTP_PORT || 587),
                                smtpSecure: String(process.env.SMTP_SECURE || env.SMTP_SECURE || '').toLowerCase() === 'true',
                                smtpUser: process.env.SMTP_USER || env.SMTP_USER || undefined,
                                smtpPass: process.env.SMTP_PASS || env.SMTP_PASS || undefined,
                                smtpFrom: process.env.SMTP_FROM || env.SMTP_FROM || process.env.SMTP_USER || env.SMTP_USER || '',
                                thresholdBytes: Number(process.env.STORAGE_WARN_BYTES || env.STORAGE_WARN_BYTES || STORAGE_WARN_THRESHOLD_BYTES),
                                limitBytes: Number(process.env.STORAGE_LIMIT_BYTES || env.STORAGE_LIMIT_BYTES || STORAGE_SOFT_LIMIT_BYTES),
                            },
                            new Date().toISOString(),
                            { ownerId },
                        );
                        res.statusCode = 200;
                        return res.end(JSON.stringify(result));
                    } catch (e: any) {
                        console.error('storage-warning-self local error:', e?.message || e);
                        res.statusCode = 200;
                        return res.end(JSON.stringify({ success: false, reason: 'error' }));
                    }
                })();
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