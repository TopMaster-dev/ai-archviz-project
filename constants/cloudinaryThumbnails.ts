/**
 * Cloudinary 上の家具 GLB 用サムネイル PNG の格納フォルダ（upload の folder と GET のパスで共通）。
 * 260723: クレイ廃止→カラー化に伴い `_v2` へ更新。旧フォルダのクレイ済みPNGは参照されなくなり（新パスは404）、
 * カラーのサムネイルが自動で再生成・保存される（手動のキャッシュ削除は不要）。
 * 260725: 取り込み向き（上下 modelUprightXDeg・前後 forwardYawDeg）をサムネイルへ反映する修正（クライアント要望③）に伴い
 * `_v3` へ更新。旧フォルダの「倒れ/背面」PNGは参照されなくなり、正しい向きで自動再生成される（手動のキャッシュ削除は不要）。
 */
export const CLOUDINARY_THUMBNAIL_FOLDER = '3d_assets_thumbnails_v3';
