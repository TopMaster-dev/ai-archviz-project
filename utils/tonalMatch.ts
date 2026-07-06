import type { NormalizedRect } from '../types.js';

/**
 * エリア編集の「境界線（継ぎ目）」対策・本命の決定論的処理（260706 クライアント報告）。
 *
 * 継ぎ目の正体は「描かれた線」ではなく、Gemini が指定領域だけを作り直す際に、その部分の露出・
 * ホワイトバランス（明るさ・色味）が周囲の元写真とわずかにズレ、貼り合わせた境目に「段差」として
 * 見えるもの。compositeMaskedEdit の羽根ぼかしは境目を「ぼかす」だけでこの値の段差は消せない。
 *
 * ここでは、編集画像（ベースと同一 W×H に整えた full 画像）を、マスク境界のすぐ内側の帯（リング）で
 * ベースと明るさ・色を実測し、per-channel の **ゲイン（乗算）** で編集領域の色を合わせ込む。ベースは
 * 空間的に連続なので「境界内側リングのベース値」≒「境界外側（周囲）のベース値」となり、編集の境界色を
 * 周囲に一致させられる＝段差＝境界線が消える。ゲインは [1/maxGain, maxGain] にクランプし、リング画素が
 * 少ない/退化時は無補正で元を返す（＝暴発しない・退行しない）。追加の生成なし・即時・無料。
 *
 * 合成（compositeMaskedEdit）は本処理の後段でマスク外をベースに厳密クリップするため、ここでゲインを
 * 「マスク内だけ」に適用しておけばマスク外はバイト不変のまま（＝指定外は改変しない保証を維持）。
 */

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export interface RingGainResult {
  gain: [number, number, number];
  applied: boolean;
  count: number;
}

/**
 * 境界リング（ringRgba のアルファ>127 の画素）で base/edit の per-channel 平均を測り、ゲイン=base/edit を返す。
 * リング画素が少ない/edit 平均が0近傍なら applied=false（無補正）。純関数（canvas 非依存＝テスト可能）。
 */
export function computeRingGains(
  base: ArrayLike<number>,
  edit: ArrayLike<number>,
  ringRgba: ArrayLike<number>,
  pxCount: number,
  opts?: { maxGain?: number; minRingPixels?: number; maskCount?: number },
): RingGainResult {
  const maxGain = opts?.maxGain ?? 1.6;
  const minGain = 1 / maxGain;
  const minRingPixels = opts?.minRingPixels ?? 200;
  const sumB = [0, 0, 0];
  const sumE = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < pxCount; i += 1) {
    if (ringRgba[i * 4 + 3] > 127) {
      sumB[0] += base[i * 4];
      sumB[1] += base[i * 4 + 1];
      sumB[2] += base[i * 4 + 2];
      sumE[0] += edit[i * 4];
      sumE[1] += edit[i * 4 + 1];
      sumE[2] += edit[i * 4 + 2];
      count += 1;
    }
  }
  if (count < minRingPixels) return { gain: [1, 1, 1], applied: false, count };
  // 退化ガード（260706 検証）: リングがマスクのほぼ全域を占める＝erode のコアが空＝「境界の細い帯」でなく
  // 領域全体を測っている。この状態でゲインを掛けると、ユーザーが意図した領域内の明るさ/色変更をベース平均へ
  // 打ち消してしまう（小さめマスクで発生）。境界帯として成立しないので無補正で返す。
  if (opts?.maskCount != null && opts.maskCount > 0 && count >= opts.maskCount * 0.9) {
    return { gain: [1, 1, 1], applied: false, count };
  }
  const gain: [number, number, number] = [1, 1, 1];
  for (let c = 0; c < 3; c += 1) {
    const mE = sumE[c] / count;
    if (mE < 1) return { gain: [1, 1, 1], applied: false, count }; // 0近傍は割り算不安定→無補正
    gain[c] = clamp(sumB[c] / count / mE, minGain, maxGain);
  }
  return { gain, applied: true, count };
}

/** マスク（maskRgba のアルファ>127）の内側だけに per-channel ゲインを乗算（in-place）。マスク外は不変。純関数。 */
export function applyGainInMask(
  edit: { [index: number]: number; length: number },
  maskRgba: ArrayLike<number>,
  gain: [number, number, number],
  pxCount: number,
): void {
  if (gain[0] === 1 && gain[1] === 1 && gain[2] === 1) return;
  for (let i = 0; i < pxCount; i += 1) {
    if (maskRgba[i * 4 + 3] > 127) {
      edit[i * 4] = clamp(Math.round(edit[i * 4] * gain[0]), 0, 255);
      edit[i * 4 + 1] = clamp(Math.round(edit[i * 4 + 1] * gain[1]), 0, 255);
      edit[i * 4 + 2] = clamp(Math.round(edit[i * 4 + 2] * gain[2]), 0, 255);
    }
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

function drawToImageData(
  img: HTMLImageElement,
  width: number,
  height: number,
): ImageData | null {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/** compositeMaskedEdit と同一の塗り経路で union マスクを描く（同じ領域で測るため）。 */
function fillUnionMask(mctx: CanvasRenderingContext2D, placements: NormalizedRect[], width: number, height: number): void {
  mctx.clearRect(0, 0, width, height);
  mctx.fillStyle = 'rgba(255,255,255,1)';
  for (const p of placements) {
    if (p.points && p.points.length >= 3) {
      mctx.beginPath();
      mctx.moveTo(p.points[0].x * width, p.points[0].y * height);
      for (let i = 1; i < p.points.length; i += 1) {
        mctx.lineTo(p.points[i].x * width, p.points[i].y * height);
      }
      mctx.closePath();
      mctx.fill('nonzero');
    } else {
      mctx.fillRect(p.x * width, p.y * height, p.width * width, p.height * height);
    }
  }
}

/**
 * 編集画像（ベースと同一 W×H に整えた full）を、マスク境界内側リングでベースへ色合わせして返す。
 * 失敗/退化時は editDataUrl をそのまま返す（安全契約＝編集結果を失わない・退行しない）。
 */
export async function harmonizeEditToBase(
  baseDataUrl: string,
  editDataUrl: string,
  placements: NormalizedRect[],
  width: number,
  height: number,
  opts?: { ringPx?: number; maxGain?: number; minRingPixels?: number },
): Promise<string> {
  if (!placements || placements.length === 0 || width <= 0 || height <= 0) return editDataUrl;
  if (typeof document === 'undefined') return editDataUrl;
  const ringPx = opts?.ringPx ?? clamp(Math.round(Math.max(width, height) * 0.02), 6, 40);
  try {
    const [baseImg, editImg] = await Promise.all([loadImage(baseDataUrl), loadImage(editDataUrl)]);
    const baseData = drawToImageData(baseImg, width, height);
    const editCanvas = document.createElement('canvas');
    editCanvas.width = width;
    editCanvas.height = height;
    const ectx = editCanvas.getContext('2d', { willReadFrequently: true });
    if (!baseData || !ectx) return editDataUrl;
    ectx.drawImage(editImg, 0, 0, width, height);
    const editImageData = ectx.getImageData(0, 0, width, height);

    // union マスク
    const mask = document.createElement('canvas');
    mask.width = width;
    mask.height = height;
    const mctx = mask.getContext('2d', { willReadFrequently: true });
    if (!mctx) return editDataUrl;
    fillUnionMask(mctx, placements, width, height);
    const maskData = mctx.getImageData(0, 0, width, height);

    // マスクの bbox・画素数を1パスで計測。リング幅をマスク寸法に合わせて縮め（小さいマスクでもコアが空に
    // ならないように）、境界帯として成立しない極小マスクは無補正で返す（260706 検証）。
    const md = maskData.data;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let maskCount = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (md[(y * width + x) * 4 + 3] > 127) {
          maskCount += 1;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maskCount === 0) return editDataUrl;
    const minMaskDim = Math.min(maxX - minX + 1, maxY - minY + 1);
    const effRingPx = Math.min(ringPx, Math.floor(minMaskDim * 0.25));
    if (effRingPx < 2) return editDataUrl; // マスクが小さすぎて境界帯を作れない＝無補正

    // 境界内側リング = マスク − erode(マスク)。erode は blur→アルファ閾値でコア化。
    const core = document.createElement('canvas');
    core.width = width;
    core.height = height;
    const coctx = core.getContext('2d', { willReadFrequently: true });
    if (!coctx) return editDataUrl;
    coctx.filter = `blur(${effRingPx}px)`;
    coctx.drawImage(mask, 0, 0);
    coctx.filter = 'none';
    const coreData = coctx.getImageData(0, 0, width, height);
    const cd = coreData.data;
    for (let i = 0; i < width * height; i += 1) {
      cd[i * 4 + 3] = cd[i * 4 + 3] > 229 ? 255 : 0; // 0.9*255：内側コアだけ残す（ハード化）
    }
    coctx.putImageData(coreData, 0, 0);

    const ring = document.createElement('canvas');
    ring.width = width;
    ring.height = height;
    const rctx = ring.getContext('2d', { willReadFrequently: true });
    if (!rctx) return editDataUrl;
    rctx.drawImage(mask, 0, 0);
    rctx.globalCompositeOperation = 'destination-out';
    rctx.drawImage(core, 0, 0); // コアを取り除く → 境界内側の帯だけ残る
    rctx.globalCompositeOperation = 'source-over';
    const ringData = rctx.getImageData(0, 0, width, height);

    const px = width * height;
    const res = computeRingGains(baseData.data, editImageData.data, ringData.data, px, {
      maxGain: opts?.maxGain,
      minRingPixels: opts?.minRingPixels,
      maskCount, // リングがマスクのほぼ全域＝erode 空のとき無補正にするための退化ガード
    });
    if (!res.applied) return editDataUrl; // リング不足/退化＝無補正で元を返す（暴発しない）
    // ゲインが実質1（補正不要）なら再エンコード（JPEG劣化）せず元を返す。
    if (res.gain[0] === 1 && res.gain[1] === 1 && res.gain[2] === 1) return editDataUrl;

    applyGainInMask(editImageData.data, maskData.data, res.gain, px);
    ectx.putImageData(editImageData, 0, 0);

    const isJpeg =
      baseDataUrl.startsWith('data:image/jpeg') || /\.jpe?g/i.test(baseDataUrl.slice(0, 40));
    return isJpeg ? editCanvas.toDataURL('image/jpeg', 0.92) : editCanvas.toDataURL('image/png');
  } catch {
    return editDataUrl;
  }
}
