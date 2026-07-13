import type { BBox01 } from './maskCropRemap.js';
import { computeCutoutPlacement, type CutoutPlaceOpts } from './cutoutPlacement.js';

/**
 * 参照商品の切り抜き（RGBA）を、囲った範囲へ「決定論で」貼り込む canvas 合成（260712・フェーズ2）。
 * モデルは一切生成に関与しない＝商品ピクセルをそのまま配置するのでブランド・比率・形が完全一致する。
 * 配置座標の計算は純関数 computeCutoutPlacement（テスト済）に委譲し、ここは描画のみ担う。
 *
 * 手順:
 *  1) 切り抜き画像の「不透明部分の外接矩形」を実測（背景除去で残る透明余白を除いて、被写体の実寸で扱う）。
 *  2) その実寸・アスペクトで、範囲内に床接地（既定）で配置矩形を計算。
 *  3) ベースを描画し、その上に切り抜きの被写体部分だけを配置矩形へ描画。
 *  範囲外はベースをそのまま描くので 1px も変わらない（＝閉じ込めは自動）。
 *  被写体が無い（切り抜きが全透明）・退化・失敗のときは **null** を返す。呼び出し側はこれを「配置できなかった」
 *  失敗として扱い、Gemini へフェイルソフトする（ベースをそのまま返すと「商品が乗らない無変化画像」を成功扱い
 *  してしまうため・260712 検証で検出）。
 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

type OpaqueBounds = { sx: number; sy: number; sw: number; sh: number; tainted?: boolean };

/**
 * 切り抜き（RGBA）の不透明部分の外接矩形を返す。
 * 被写体が全く無い（全透明）なら **null**（＝配置対象なし・呼び出し側でフェイルソフト）。
 * getImageData がタイント等で読めない場合は画像全体＋tainted:true（劣化するが破綻はしない）。
 */
function opaqueBounds(ctx: CanvasRenderingContext2D, w: number, h: number, alphaThreshold = 8): OpaqueBounds | null {
  try {
    const { data } = ctx.getImageData(0, 0, w, h);
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const a = data[(y * w + x) * 4 + 3];
        if (a > alphaThreshold) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return null; // 不透明画素ゼロ＝被写体なし
    return { sx: minX, sy: minY, sw: maxX - minX + 1, sh: maxY - minY + 1 };
  } catch {
    // タイント等でピクセルを読めない（同一オリジンの data URL では通常起きない）。全体を使ってフォールバック。
    return { sx: 0, sy: 0, sw: w, sh: h, tainted: true };
  }
}

export async function placeCutoutIntoRegion(
  baseDataUrl: string,
  cutoutDataUrl: string,
  region: BBox01,
  opts?: CutoutPlaceOpts,
): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  try {
    const [baseImg, cutImg] = await Promise.all([loadImage(baseDataUrl), loadImage(cutoutDataUrl)]);
    const baseW = baseImg.naturalWidth;
    const baseH = baseImg.naturalHeight;
    const cw = cutImg.naturalWidth;
    const ch = cutImg.naturalHeight;
    if (baseW <= 0 || baseH <= 0 || cw <= 0 || ch <= 0) return null;

    // 切り抜きを一旦オフスクリーンに描いて不透明部分の外接矩形を実測する（透明余白を除いた被写体実寸）。
    const cutCanvas = document.createElement('canvas');
    cutCanvas.width = cw;
    cutCanvas.height = ch;
    const cutCtx = cutCanvas.getContext('2d');
    if (!cutCtx) return null;
    cutCtx.drawImage(cutImg, 0, 0);
    const bounds = opaqueBounds(cutCtx, cw, ch);
    if (!bounds) return null; // 被写体なし（全透明）→ 配置できない＝呼び出し側で Gemini へフェイルソフト。
    const { sx, sy, sw, sh } = bounds;

    // 被写体実寸（sw×sh）で範囲内の配置矩形を計算（アスペクト維持・床接地）。
    const p = computeCutoutPlacement(sw, sh, region, baseW, baseH, opts);
    if (p.dw <= 0 || p.dh <= 0) return null;

    const out = document.createElement('canvas');
    out.width = baseW;
    out.height = baseH;
    const octx = out.getContext('2d');
    if (!octx) return null;
    octx.drawImage(baseImg, 0, 0, baseW, baseH);
    // 被写体部分（sx,sy,sw,sh）だけを配置矩形（dx,dy,dw,dh）へ。透明部分は描かれないので範囲外も汚さない。
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(cutCanvas, sx, sy, sw, sh, p.dx, p.dy, p.dw, p.dh);

    const isJpeg = baseDataUrl.startsWith('data:image/jpeg') || /\.jpe?g/i.test(baseDataUrl.slice(0, 40));
    return isJpeg ? out.toDataURL('image/jpeg', 0.92) : out.toDataURL('image/png');
  } catch {
    return null;
  }
}
