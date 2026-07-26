import { v2 as cloudinary } from 'cloudinary';

/**
 * 公式3Dモデルの Cloudinary 署名付き直アップロード用の署名発行（260726・クライアント要望①）。
 *
 * 方針:
 *  - 3D データは大きいため、ブラウザ → Cloudinary へ「直アップロード」する（Vercel の関数ボディ上限を回避）。
 *  - Signed アップロードのため、署名はサーバ側でのみ発行し、API Secret はクライアントへ絶対に出さない。
 *  - 保存先フォルダは Upload Preset「3d_assets upload」(Signed / フォルダ 3d_assets 固定) が決めるため、
 *    folder パラメータは送らない／署名しない（preset 名のみ署名）。
 *  - 3D は raw 扱い。クライアントは `/v1_1/<cloud>/raw/upload` へ送る（resource_type は URL 側で指定）。
 *
 * 返すのは cloud_name / api_key / timestamp / signature / upload_preset のみ（api_secret は返さない）。
 */
export type Cloud3dSignResult =
  | {
      ok: true;
      cloudName: string;
      apiKey: string;
      timestamp: number;
      signature: string;
      uploadPreset: string;
      resourceType: 'raw';
    }
  | { ok: false; error: string };

/** 環境変数から Cloudinary 資格情報を解決（cloud_name は VITE_ 版もフォールバック）。 */
function resolveCloudinaryEnv(): { cloudName: string; apiKey: string; apiSecret: string; uploadPreset: string } {
  return {
    cloudName: (process.env.CLOUDINARY_CLOUD_NAME || process.env.VITE_CLOUDINARY_CLOUD_NAME || '').trim(),
    apiKey: (process.env.CLOUDINARY_API_KEY || '').trim(),
    apiSecret: (process.env.CLOUDINARY_API_SECRET || '').trim(),
    // 既定は管理画面のプリセット名「3d_assets upload」。env で上書き可。
    uploadPreset: (process.env.CLOUDINARY_3D_UPLOAD_PRESET || '3d_assets upload').trim(),
  };
}

export function signOfficial3dUpload(): Cloud3dSignResult {
  const { cloudName, apiKey, apiSecret, uploadPreset } = resolveCloudinaryEnv();
  if (!cloudName || !apiKey || !apiSecret) return { ok: false, error: 'cloudinary-not-configured' };
  const timestamp = Math.round(Date.now() / 1000);
  // 署名対象は、クライアントが送るアップロードパラメータのうち file / api_key / cloud_name / resource_type を除いたもの。
  // ここでは timestamp と upload_preset のみ（preset がフォルダ等を固定する）。
  const signature = cloudinary.utils.api_sign_request({ timestamp, upload_preset: uploadPreset }, apiSecret);
  return { ok: true, cloudName, apiKey, timestamp, signature, uploadPreset, resourceType: 'raw' };
}
