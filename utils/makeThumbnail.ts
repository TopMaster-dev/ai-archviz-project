// 一覧表示用の軽量サムネイル（JPEG）を画像 data URL から生成する。ブラウザ専用（Image + canvas）。
// プロジェクト一覧の各行に表示するため、長辺を抑えて行サイズを小さく保つ（2c-i）。

const THUMB_MAX_SIDE = 320;
const THUMB_QUALITY = 0.72;

/**
 * 任意の画像 data URL を、長辺 maxSide px・JPEG 品質 quality のサムネイル data URL に変換する。
 * 失敗時は reject する（呼び出し側で握りつぶし、巨大な元画像を保存しないようにする）。
 */
export function makeThumbnailDataUrl(
  dataUrl: string,
  maxSide: number = THUMB_MAX_SIDE,
  quality: number = THUMB_QUALITY,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) {
          reject(new Error('thumbnail: empty image'));
          return;
        }
        const m = Math.max(w, h);
        const scale = m > maxSide ? maxSide / m : 1;
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));
        const c = document.createElement('canvas');
        c.width = cw;
        c.height = ch;
        const ctx = c.getContext('2d');
        if (!ctx) {
          reject(new Error('thumbnail: no 2d context'));
          return;
        }
        ctx.drawImage(img, 0, 0, cw, ch);
        resolve(c.toDataURL('image/jpeg', quality));
      } catch (e) {
        reject(e instanceof Error ? e : new Error('thumbnail generation failed'));
      }
    };
    img.onerror = () => reject(new Error('thumbnail: image load failed'));
    img.src = dataUrl;
  });
}
