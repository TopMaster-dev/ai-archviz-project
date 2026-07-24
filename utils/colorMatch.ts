/**
 * 参照画像（プレビュー）の全体的な色味へ、対象画像（AI高精細化の出力）を合わせる（260725・クライアント要望）。
 *
 * AI精細化（enhanceDetail）は構図・形状は保つが、全体の色味（ホワイトバランス＝赤み/暖色）がわずかにズレることがある。
 * 両画像は構図が一致しているので、縮小して求めた「チャンネル別の平均色の比（ゲイン）」を対象画像へ掛けることで、
 * 全体の色被り/WBをプレビューへ寄せる。高周波のディテール（AIの精細化）は保たれ、低周波の色だけが補正される。
 * ゲインは過補正を避けるためクランプし、ほぼ不要なときは元をそのまま返す。失敗時も元の対象画像を返す（安全契約）。
 */
export function matchOverallColorToReference(
  imageDataUrl: string,
  referenceDataUrl: string,
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    const ref = new Image();

    // 平均色は小さく縮小して求める（ノイズに強く高速・96px 相当）。
    const meanOf = (im: HTMLImageElement): [number, number, number] | null => {
      const long = 96;
      const scale = long / Math.max(1, Math.max(im.naturalWidth, im.naturalHeight));
      const w = Math.max(1, Math.round(im.naturalWidth * scale));
      const h = Math.max(1, Math.round(im.naturalHeight * scale));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(im, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i];
        g += d[i + 1];
        b += d[i + 2];
        n++;
      }
      return n ? [r / n, g / n, b / n] : null;
    };

    const onBoth = () => {
      try {
        const mi = meanOf(img);
        const mr = meanOf(ref);
        if (!mi || !mr) {
          resolve(imageDataUrl);
          return;
        }
        const clampGain = (x: number) => Math.max(0.7, Math.min(1.4, x)); // 過補正防止
        const gain: [number, number, number] = [
          clampGain(mi[0] > 1 ? mr[0] / mi[0] : 1),
          clampGain(mi[1] > 1 ? mr[1] / mi[1] : 1),
          clampGain(mi[2] > 1 ? mr[2] / mi[2] : 1),
        ];
        // ほぼ補正不要なら元をそのまま返す（無駄な再エンコード回避）。
        if (Math.abs(gain[0] - 1) < 0.01 && Math.abs(gain[1] - 1) < 0.01 && Math.abs(gain[2] - 1) < 0.01) {
          resolve(imageDataUrl);
          return;
        }
        const W = img.naturalWidth;
        const H = img.naturalHeight;
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const ctx = c.getContext('2d');
        if (!ctx) {
          resolve(imageDataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0);
        const id = ctx.getImageData(0, 0, W, H);
        const d = id.data;
        for (let i = 0; i < d.length; i += 4) {
          d[i] = Math.min(255, d[i] * gain[0]);
          d[i + 1] = Math.min(255, d[i + 1] * gain[1]);
          d[i + 2] = Math.min(255, d[i + 2] * gain[2]);
        }
        ctx.putImageData(id, 0, 0);
        const out = imageDataUrl.startsWith('data:image/jpeg')
          ? c.toDataURL('image/jpeg', 0.95)
          : c.toDataURL('image/png');
        resolve(out);
      } catch {
        resolve(imageDataUrl);
      }
    };

    let loaded = 0;
    const done = () => {
      loaded++;
      if (loaded === 2) onBoth();
    };
    img.onload = done;
    ref.onload = done;
    img.onerror = () => resolve(imageDataUrl);
    ref.onerror = () => resolve(imageDataUrl);
    img.src = imageDataUrl;
    ref.src = referenceDataUrl;
  });
}
