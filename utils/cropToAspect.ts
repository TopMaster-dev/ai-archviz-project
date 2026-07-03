// アップロード時クロップ（AIイメージ編集の構図ズレ根本解決・260703 クライアント合意）。
// 元画像を「AIが対応する比率」に最初に切り抜いてしまえば、以降の再生成がネイティブ比率で行われ、
// 従来の「対応比率で生成→元比率へクロップ/余白」で毎回積み重なっていた構図ズレが発生しなくなる。
// 用紙比率(1:1.414)は API 非対応のため含めず、書き出し側で対応する方針（クライアント合意）。

export interface CropRatio {
  key: string;
  ratio: number; // width / height
  label: string;
}

/** クロップで選べる常識的な対応比率（クライアント合意リスト）。 */
export const CROP_RATIOS: CropRatio[] = [
  { key: '1:1', ratio: 1, label: '1:1' },
  { key: '4:5', ratio: 4 / 5, label: '4:5' },
  { key: '5:4', ratio: 5 / 4, label: '5:4' },
  { key: '3:4', ratio: 3 / 4, label: '3:4' },
  { key: '4:3', ratio: 4 / 3, label: '4:3' },
  { key: '2:3', ratio: 2 / 3, label: '2:3' },
  { key: '3:2', ratio: 3 / 2, label: '3:2' },
  { key: '16:9', ratio: 16 / 9, label: '16:9' },
  { key: '9:16', ratio: 9 / 16, label: '9:16' },
  { key: '21:9', ratio: 21 / 9, label: '21:9' },
];

/** 元画像の縦横比に最も近い対応比率（対数距離）。初期選択（おすすめ）に使う。 */
export function pickClosestCropRatio(width: number, height: number): CropRatio {
  if (!(width > 0) || !(height > 0)) return CROP_RATIOS[0];
  const r = width / height;
  let best = CROP_RATIOS[0];
  let bestScore = Infinity;
  for (const c of CROP_RATIOS) {
    const s = Math.abs(Math.log(r / c.ratio));
    if (s < bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 目標比率の「最大の」クロップ矩形（画像内に収まる最大面積＝トリミング最小）。offset(0..1) で位置を指定。
 * 画像が目標より横長なら高さを使い切り幅を絞る／縦長なら幅を使い切り高さを絞る。
 */
export function maxCropForRatio(
  imgW: number,
  imgH: number,
  targetRatio: number,
  offsetX = 0.5,
  offsetY = 0.5,
): CropRect {
  if (!(imgW > 0) || !(imgH > 0) || !(targetRatio > 0)) return { x: 0, y: 0, w: Math.max(0, imgW), h: Math.max(0, imgH) };
  const imgRatio = imgW / imgH;
  let w: number;
  let h: number;
  if (imgRatio > targetRatio) {
    h = imgH;
    w = imgH * targetRatio;
  } else {
    w = imgW;
    h = imgW / targetRatio;
  }
  const x = (imgW - w) * clamp01(offsetX);
  const y = (imgH - h) * clamp01(offsetY);
  return { x, y, w, h };
}

/** 画像(dataURL)をクロップ矩形で切り抜いて dataURL を返す（ブラウザのみ・失敗時は元を返す安全契約）。 */
export function cropDataUrl(dataUrl: string, rect: CropRect): Promise<string> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || !(rect.w > 0) || !(rect.h > 0)) {
      resolve(dataUrl);
      return;
    }
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(rect.w));
        c.height = Math.max(1, Math.round(rect.h));
        const ctx = c.getContext('2d');
        if (!ctx) {
          resolve(dataUrl);
          return;
        }
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, c.width, c.height);
        const out = dataUrl.startsWith('data:image/png') ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.92);
        resolve(out);
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}
