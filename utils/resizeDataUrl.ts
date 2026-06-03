/** 返却画像をベースと同一ピクセル寸法に合わせる（ブラウザのみ） */
export function resizeDataUrlToSize(
  dataUrl: string,
  targetWidth: number,
  targetHeight: number
): Promise<string> {
  return new Promise((resolve) => {
    if (targetWidth <= 0 || targetHeight <= 0) {
      resolve(dataUrl);
      return;
    }
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = targetWidth;
        c.height = targetHeight;
        const ctx = c.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
        const out = dataUrl.startsWith('data:image/jpeg') || /\.jpe?g/i.test(dataUrl.slice(0, 40))
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
