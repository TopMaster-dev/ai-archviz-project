import type { NormalizedRect } from '../types.js';
import { harmonizeEditToBase } from './tonalMatch.js';

/**
 * エリア編集の「境界線（継ぎ目）」を根本的に消すための決定論処理・Stage2（260722 クライアント要望）。
 *
 * 継ぎ目の正体は、貼り合わせた編集領域（edit）と周囲（base）の露出・ホワイトバランスの“段差”。tonalMatch は
 * これを「領域全体を1つのゲイン」で補正するため、境界に沿って段差が場所ごとに変わるとき（照明の勾配・複数エリア等）に
 * 消しきれず線が残る。ここでは Poisson 画像編集と同じ発想で、境界差分を“空間的に変化するオフセット場（調和膜）”として
 * 領域内へ滑らかに流し込み、境界で edit の色を base に厳密一致させる＝継ぎ目が原理的に見えなくなる（seamless cloning）。
 *
 * membrane m は領域 Ω 内で調和（∇²m=0）、境界 ∂Ω 上で m = (base − edit)。すると edit + m は境界で base に一致し、
 * 内側は境界差分の滑らかな補間になる（高周波の絵柄＝edit の質感は保ち、低周波の段差だけを除去）。
 *
 * Poisson を厳密に解くのは 1K で ~数十万未知数/ch と重いので、pull-push（プッシュプル・Gortler 1996）ピラミッドで
 * O(n) 近似する（境界の既知値をピラミッドで集約→上位から未知を滑らかに補間）。純関数として実装しユニットテスト可能。
 * tonalMatch の後継（1ゲイン→空間可変オフセット）で、外側フェザーを使わないため家具のゴースト二重縁は出さない。
 */

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

interface PyramidLevel {
  v: Float32Array;
  wt: Float32Array;
  w: number;
  h: number;
}

/** 粗レベル arr（cw×ch）を連続座標(u,v)でバイリニアサンプル（境界クランプ）。 */
function sampleBilinear(arr: Float32Array, cw: number, ch: number, u: number, v: number): number {
  const uu = clamp(u, 0, cw - 1);
  const vv = clamp(v, 0, ch - 1);
  const x0 = Math.floor(uu);
  const y0 = Math.floor(vv);
  const x1 = Math.min(cw - 1, x0 + 1);
  const y1 = Math.min(ch - 1, y0 + 1);
  const fx = uu - x0;
  const fy = vv - y0;
  const top = arr[y0 * cw + x0] * (1 - fx) + arr[y0 * cw + x1] * fx;
  const bot = arr[y1 * cw + x0] * (1 - fx) + arr[y1 * cw + x1] * fx;
  return top * (1 - fy) + bot * fy;
}

/**
 * pull-push による散布データの平滑補間。value（長さ w*h）に既知値、weight に信頼度（既知=1・未知=0）を渡すと、
 * 未知領域を既知値から滑らかに埋めた value を返す（＝調和膜の近似）。既知画素の値はそのまま保持する。純関数。
 * 手順: PULL（細→粗に重み付き平均で集約）→ PUSH（粗→細でバイリニア補間し未知を埋める・既知は据置）。
 */
export function pullPushInterpolate(
  value: Float32Array,
  weight: Float32Array,
  w: number,
  h: number
): Float32Array {
  if (w <= 0 || h <= 0) return value;
  const levels: PyramidLevel[] = [
    { v: Float32Array.from(value), wt: Float32Array.from(weight), w, h },
  ];
  // PULL: 1x1 まで粗くする。各粗画素 = 4子の重み付き平均、重みは総和を1でクランプ。
  let cw = w;
  let ch = h;
  while (cw > 1 || ch > 1) {
    const nw = Math.max(1, Math.ceil(cw / 2));
    const nh = Math.max(1, Math.ceil(ch / 2));
    const nv = new Float32Array(nw * nh);
    const nwt = new Float32Array(nw * nh);
    const prev = levels[levels.length - 1];
    for (let y = 0; y < nh; y += 1) {
      for (let x = 0; x < nw; x += 1) {
        let sv = 0;
        let sw = 0;
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const px = x * 2 + dx;
            const py = y * 2 + dy;
            if (px < prev.w && py < prev.h) {
              const pi = py * prev.w + px;
              const wgt = prev.wt[pi];
              sv += prev.v[pi] * wgt;
              sw += wgt;
            }
          }
        }
        const oi = y * nw + x;
        nwt[oi] = Math.min(1, sw);
        nv[oi] = sw > 1e-6 ? sv / sw : 0;
      }
    }
    levels.push({ v: nv, wt: nwt, w: nw, h: nh });
    cw = nw;
    ch = nh;
  }
  // PUSH: 粗→細。未知（重み<1）を粗レベルのバイリニア値で埋める。既知（重み>=1）は据置＝境界値を厳密保持。
  for (let l = levels.length - 2; l >= 0; l -= 1) {
    const fine = levels[l];
    const coarse = levels[l + 1];
    for (let y = 0; y < fine.h; y += 1) {
      for (let x = 0; x < fine.w; x += 1) {
        const fi = y * fine.w + x;
        const wf = fine.wt[fi];
        if (wf >= 1) continue;
        // 細(x,y)→粗の連続座標。粗画素 X の中心は細座標 2X+0.5 なので u=(x-0.5)/2。
        const cv = sampleBilinear(coarse.v, coarse.w, coarse.h, (x - 0.5) / 2, (y - 0.5) / 2);
        fine.v[fi] = wf * fine.v[fi] + (1 - wf) * cv;
        fine.wt[fi] = 1;
      }
    }
  }
  return levels[0].v;
}

export interface MembraneOptions {
  /** オフセットの上限（|m| をこの範囲へクランプ・暴発防止）。既定 48。 */
  maxOffset?: number;
  /** 境界リング画素がこれ未満なら適用しない（false を返す＝呼び出し側でフォールバック）。既定 80。 */
  minRingPixels?: number;
}

/**
 * membrane オフセットを editRgba に in-place で適用する（純関数・DOM 非依存＝テスト可能）。
 * ringRgba: 境界リング（∂Ω・alpha>127 が既知＝Dirichlet 境界）。applyRgba: 適用領域（Ω 全体・alpha>127）。
 * 各チャンネルで known=(base−edit) をリング上に置き、pull-push で Ω 内へ補間し、edit へ加算する。
 * リングが少なすぎるときは何もせず false を返す（呼び出し側で従来のゲイン補正へフォールバック）。
 */
export function applyMembraneOffset(
  base: ArrayLike<number>,
  edit: { [index: number]: number; length: number },
  ringRgba: ArrayLike<number>,
  applyRgba: ArrayLike<number>,
  w: number,
  h: number,
  opts?: MembraneOptions
): boolean {
  const px = w * h;
  if (px <= 0) return false;
  const maxOffset = opts?.maxOffset ?? 48;
  const minRingPixels = opts?.minRingPixels ?? 80;
  let ringCount = 0;
  let applyCount = 0;
  for (let i = 0; i < px; i += 1) {
    if (ringRgba[i * 4 + 3] > 127) ringCount += 1;
    if (applyRgba[i * 4 + 3] > 127) applyCount += 1;
  }
  if (ringCount < minRingPixels) return false;
  // 退化ガード（tonalMatch:60 と同様）: リングがマスクのほぼ全域＝erode のコアが空＝「境界の帯」でなく領域全体を測って
  // いる状態。この状態で膜を適用すると領域全体が base へ引き戻され、ユーザーの編集が消える。境界帯として成立しないので
  // 何もせず false を返す（呼び出し側で従来のゲイン補正＝これも同条件で無補正、へフォールバック）。
  if (applyCount > 0 && ringCount >= applyCount * 0.9) return false;
  const value = new Float32Array(px);
  const weight = new Float32Array(px);
  for (let c = 0; c < 3; c += 1) {
    value.fill(0);
    weight.fill(0);
    for (let i = 0; i < px; i += 1) {
      if (ringRgba[i * 4 + 3] > 127) {
        value[i] = base[i * 4 + c] - edit[i * 4 + c];
        weight[i] = 1;
      }
    }
    const field = pullPushInterpolate(value, weight, w, h);
    for (let i = 0; i < px; i += 1) {
      if (applyRgba[i * 4 + 3] > 127) {
        const off = clamp(field[i], -maxOffset, maxOffset);
        edit[i * 4 + c] = clamp(Math.round(edit[i * 4 + c] + off), 0, 255);
      }
    }
  }
  return true;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

function drawToImageData(img: HTMLImageElement, width: number, height: number): ImageData | null {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/** compositeMaskedEdit / tonalMatch と同一の塗り経路で union マスクを描く（dilatePx>0 で外側へ膨張）。 */
function fillMask(
  mctx: CanvasRenderingContext2D,
  placements: NormalizedRect[],
  width: number,
  height: number,
  dilatePx: number
): void {
  mctx.clearRect(0, 0, width, height);
  mctx.fillStyle = 'rgba(255,255,255,1)';
  const dilate = Math.max(0, Math.round(dilatePx));
  if (dilate > 0) {
    mctx.strokeStyle = 'rgba(255,255,255,1)';
    mctx.lineJoin = 'round';
    mctx.lineCap = 'round';
    mctx.lineWidth = dilate * 2;
  }
  for (const p of placements) {
    if (p.points && p.points.length >= 3) {
      mctx.beginPath();
      mctx.moveTo(p.points[0].x * width, p.points[0].y * height);
      for (let i = 1; i < p.points.length; i += 1) mctx.lineTo(p.points[i].x * width, p.points[i].y * height);
      mctx.closePath();
      mctx.fill('nonzero');
      if (dilate > 0) mctx.stroke();
    } else if (dilate > 0) {
      mctx.fillRect(p.x * width - dilate, p.y * height - dilate, p.width * width + dilate * 2, p.height * height + dilate * 2);
    } else {
      mctx.fillRect(p.x * width, p.y * height, p.width * width, p.height * height);
    }
  }
}

/**
 * harmonizeEditToBase の後継（Stage2・260722）。edit を base へ「1ゲイン」ではなく「membrane（空間可変オフセット）」で
 * 合わせ込み、境界の色を base に厳密一致させた edit を返す（＝この後 compositeMaskedEdit で切り出しても継ぎ目が出ない）。
 * placements の（dilate 膨張後）マスクを Ω とし、その内縁 ringPx の帯を境界 ∂Ω として base−edit を pull-push で内側へ流す。
 * リング不足・退化・DOM 非対応・失敗時は harmonizeEditToBase（従来のゲイン補正）へフェイルソフト＝退行しない。
 */
export async function membraneHarmonizeEditToBase(
  baseDataUrl: string,
  editDataUrl: string,
  placements: NormalizedRect[],
  width: number,
  height: number,
  opts?: { applyDilatePx?: number; ringPx?: number; maxOffset?: number }
): Promise<string> {
  if (!placements || placements.length === 0 || width <= 0 || height <= 0) return editDataUrl;
  if (typeof document === 'undefined') {
    return harmonizeEditToBase(baseDataUrl, editDataUrl, placements, width, height, { applyDilatePx: opts?.applyDilatePx });
  }
  try {
    const [baseImg, editImg] = await Promise.all([loadImage(baseDataUrl), loadImage(editDataUrl)]);
    const baseData = drawToImageData(baseImg, width, height);
    const editCanvas = document.createElement('canvas');
    editCanvas.width = width;
    editCanvas.height = height;
    const ectx = editCanvas.getContext('2d', { willReadFrequently: true });
    if (!baseData || !ectx) throw new Error('ctx');
    ectx.drawImage(editImg, 0, 0, width, height);
    const editData = ectx.getImageData(0, 0, width, height);

    // Ω マスク（合成と同じ dilate ぶん膨張＝実際に貼り込まれる領域に一致させる）。
    const applyDilate = Math.max(0, Math.round(opts?.applyDilatePx ?? 0));
    const mask = document.createElement('canvas');
    mask.width = width;
    mask.height = height;
    const mctx = mask.getContext('2d', { willReadFrequently: true });
    if (!mctx) throw new Error('mctx');
    fillMask(mctx, placements, width, height, applyDilate);
    const maskData = mctx.getImageData(0, 0, width, height);

    // 境界リング ∂Ω = マスク − erode(マスク, ringPx)。erode は blur→高しきい値でコア化し、コアを引く。
    const ringPx = clamp(Math.round(opts?.ringPx ?? Math.max(width, height) * 0.006), 3, 16);
    const core = document.createElement('canvas');
    core.width = width;
    core.height = height;
    const coctx = core.getContext('2d', { willReadFrequently: true });
    if (!coctx) throw new Error('coctx');
    coctx.filter = `blur(${ringPx}px)`;
    coctx.drawImage(mask, 0, 0);
    coctx.filter = 'none';
    const coreData = coctx.getImageData(0, 0, width, height);
    const cd = coreData.data;
    for (let i = 0; i < width * height; i += 1) {
      cd[i * 4 + 3] = cd[i * 4 + 3] > 229 ? 255 : 0; // 内側コアだけ残す
    }
    coctx.putImageData(coreData, 0, 0);
    const ring = document.createElement('canvas');
    ring.width = width;
    ring.height = height;
    const rctx = ring.getContext('2d', { willReadFrequently: true });
    if (!rctx) throw new Error('rctx');
    rctx.drawImage(mask, 0, 0);
    rctx.globalCompositeOperation = 'destination-out';
    rctx.drawImage(core, 0, 0);
    rctx.globalCompositeOperation = 'source-over';
    const ringData = rctx.getImageData(0, 0, width, height);

    const ok = applyMembraneOffset(
      baseData.data,
      editData.data,
      ringData.data,
      maskData.data,
      width,
      height,
      { maxOffset: opts?.maxOffset }
    );
    if (!ok) {
      return harmonizeEditToBase(baseDataUrl, editDataUrl, placements, width, height, { applyDilatePx: opts?.applyDilatePx });
    }
    ectx.putImageData(editData, 0, 0);
    const isJpeg = baseDataUrl.startsWith('data:image/jpeg') || /\.jpe?g/i.test(baseDataUrl.slice(0, 40));
    return isJpeg ? editCanvas.toDataURL('image/jpeg', 0.92) : editCanvas.toDataURL('image/png');
  } catch {
    // 失敗時は従来のゲイン補正へフォールバック（それも失敗すれば editDataUrl をそのまま返す）。
    try {
      return await harmonizeEditToBase(baseDataUrl, editDataUrl, placements, width, height, { applyDilatePx: opts?.applyDilatePx });
    } catch {
      return editDataUrl;
    }
  }
}
