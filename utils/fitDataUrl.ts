/**
 * 返却画像をベースの寸法へ「歪ませずに」合わせる（ブラウザのみ・260624）。
 * 旧 resizeDataUrlToSize は drawImage(img,0,0,W,H) で強制ストレッチしていたため、写真の
 * アスペクト比が Gemini の対応比とずれると縦/横に伸びていた（クライアント報告「縦に延びる」）。
 *
 * mode='cover'   : 中央クロップで targetW×targetH を埋める（アスペクト維持・はみ出しは少量クロップ）。
 *                  Gemini 出力比 ≈ ベース比のとき（図面パース等）は実質ただのスケールで無劣化。
 * mode='contain' : 余白（レターボックス）を付けて全内容を保持（極端なアスペクト差で内容欠落を避ける）。
 * いずれも失敗時は元データURLを返す（resizeDataUrlToSize と同じ安全契約）。
 */
export function fitDataUrlToSize(
  dataUrl: string,
  targetWidth: number,
  targetHeight: number,
  mode: 'cover' | 'contain' = 'cover',
  padColor = '#000000'
): Promise<string> {
  return new Promise((resolve) => {
    if (targetWidth <= 0 || targetHeight <= 0) {
      resolve(dataUrl);
      return;
    }
    const img = new Image();
    img.onload = () => {
      try {
        const sw = img.naturalWidth;
        const sh = img.naturalHeight;
        if (sw <= 0 || sh <= 0) {
          resolve(dataUrl);
          return;
        }
        const c = document.createElement('canvas');
        c.width = targetWidth;
        c.height = targetHeight;
        const ctx = c.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.imageSmoothingQuality = 'high';
        const srcAspect = sw / sh;
        const dstAspect = targetWidth / targetHeight;

        if (mode === 'contain') {
          // 全内容を保持。余白を padColor で塗る。
          ctx.fillStyle = padColor;
          ctx.fillRect(0, 0, targetWidth, targetHeight);
          let dw = targetWidth;
          let dh = targetHeight;
          if (srcAspect > dstAspect) {
            dh = Math.round(targetWidth / srcAspect);
          } else {
            dw = Math.round(targetHeight * srcAspect);
          }
          const dx = Math.round((targetWidth - dw) / 2);
          const dy = Math.round((targetHeight - dh) / 2);
          ctx.drawImage(img, 0, 0, sw, sh, dx, dy, dw, dh);
        } else {
          // cover: 中央クロップで埋める（アスペクト維持・ストレッチなし）。
          let cropW = sw;
          let cropH = sh;
          let cropX = 0;
          let cropY = 0;
          if (srcAspect > dstAspect) {
            cropW = Math.round(sh * dstAspect);
            cropX = Math.round((sw - cropW) / 2);
          } else {
            cropH = Math.round(sw / dstAspect);
            cropY = Math.round((sh - cropH) / 2);
          }
          ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, targetWidth, targetHeight);
        }

        const out =
          dataUrl.startsWith('data:image/jpeg') || /\.jpe?g/i.test(dataUrl.slice(0, 40))
            ? c.toDataURL('image/jpeg', 0.92)
            : c.toDataURL('image/png');
        resolve(out);
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/**
 * cover クロップで失われる割合（最大軸）。ベースと Gemini 出力のアスペクト差から算出。
 * これが大きい（極端なアスペクト差）ときは contain にフォールバックして内容欠落を防ぐ。
 */
export function coverCropLossFraction(srcAspect: number, dstAspect: number): number {
  if (srcAspect <= 0 || dstAspect <= 0) return 0;
  return srcAspect > dstAspect ? 1 - dstAspect / srcAspect : 1 - srcAspect / dstAspect;
}
