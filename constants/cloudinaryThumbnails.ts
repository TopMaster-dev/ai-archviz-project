/**
 * Cloudinary 上の家具 GLB 用サムネイル PNG の格納フォルダ（upload の folder と GET のパスで共通）。
 * 260723: クレイ廃止→カラー化に伴い `_v2` へ更新。旧フォルダのクレイ済みPNGは参照されなくなり（新パスは404）、
 * カラーのサムネイルが自動で再生成・保存される（手動のキャッシュ削除は不要）。
 */
export const CLOUDINARY_THUMBNAIL_FOLDER = '3d_assets_thumbnails_v2';
