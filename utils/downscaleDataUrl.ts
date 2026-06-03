const DEFAULT_MAX_SIDE = 2048;

/** data URL の長辺が maxSide を超える場合のみ縮小（ペイロード削減） */
export function downscaleDataUrlIfNeeded(
  dataUrl: string,
  maxSide: number = DEFAULT_MAX_SIDE
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const m = Math.max(w, h);
        if (!m || m <= maxSide) {
          resolve(dataUrl);
          return;
        }
        const scale = maxSide / m;
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));
        const c = document.createElement('canvas');
        c.width = cw;
        c.height = ch;
        const ctx = c.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, cw, ch);
        const useJpeg = /data:image\/jpe?g/i.test(dataUrl);
        resolve(
          useJpeg
            ? c.toDataURL('image/jpeg', 0.88)
            : c.toDataURL('image/png')
        );
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
