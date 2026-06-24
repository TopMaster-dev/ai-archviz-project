import type { NormalizedRect } from '../types.js';

/**
 * エリア編集の「領域外染み出し」対策（260624 クライアント報告）。
 * Gemini は画像全体を holistic に再生成するため、テキストの「領域外は維持」指示を守らず、
 * マスク外（例: 天井のドライフラワー）まで増殖・改変してしまう。これを構造的に止める。
 *
 * baseDataUrl（編集前・W×H）の上に、editDataUrl（Gemini 出力・**同じ W×H にアスペクト補正済み**）を
 * placements の多角形/矩形マスクの内側だけ羽根ぼかし付きで合成する。マスク外は 100% ベースのまま
 * （バイト一致）になるため、指示にない領域は一切変化しない＝連鎖編集での増幅ループも断ち切れる。
 *
 * 前提・注意:
 *  - 呼び出し側は必ず edit を base と同一 W×H（アスペクト補正後）にしてから渡すこと（位置整合のため）。
 *  - placements が空なら editDataUrl をそのまま返す（全体編集モードでは使わない）。
 *  - 失敗時は editDataUrl を返す（合成不具合でも編集結果は失わない）。
 *  - 既知の限界: Gemini がフレーミングをずらすと、マスク境界でマスク内（生成）とマスク外（ベース）の
 *    被写体位置がずれて軽い二重縁が出ることがある。羽根ぼかしで緩和するが完全には消せない（要 live QA）。
 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

export async function compositeMaskedEdit(
  baseDataUrl: string,
  editDataUrl: string,
  placements: NormalizedRect[],
  width: number,
  height: number,
  featherPx?: number
): Promise<string> {
  if (!placements || placements.length === 0 || width <= 0 || height <= 0) return editDataUrl;
  const feather =
    featherPx ?? Math.min(16, Math.max(4, Math.round(Math.max(width, height) * 0.006)));
  try {
    const [baseImg, editImg] = await Promise.all([loadImage(baseDataUrl), loadImage(editDataUrl)]);

    // 1) 羽根ぼかし付きアルファマスク（透明地に白アルファで領域を塗る → blur で縁を柔らかく）。
    const mask = document.createElement('canvas');
    mask.width = width;
    mask.height = height;
    const mctx = mask.getContext('2d');
    if (!mctx) return editDataUrl;
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
        mctx.fill('evenodd');
      } else {
        mctx.fillRect(p.x * width, p.y * height, p.width * width, p.height * height);
      }
    }
    let maskCanvas: HTMLCanvasElement = mask;
    if (feather > 0) {
      const blur = document.createElement('canvas');
      blur.width = width;
      blur.height = height;
      const bctx = blur.getContext('2d');
      if (bctx) {
        // ctx.filter 未対応エンジンでは無視され、ハードな縁になるだけ（致命ではない）。
        bctx.filter = `blur(${feather}px)`;
        bctx.drawImage(mask, 0, 0);
        maskCanvas = blur;
      }
    }

    // 2) edit をマスクで切り抜く（destination-in でマスクのアルファだけ残す）。
    const cut = document.createElement('canvas');
    cut.width = width;
    cut.height = height;
    const cctx = cut.getContext('2d');
    if (!cctx) return editDataUrl;
    cctx.drawImage(editImg, 0, 0, width, height);
    cctx.globalCompositeOperation = 'destination-in';
    cctx.drawImage(maskCanvas, 0, 0);
    cctx.globalCompositeOperation = 'source-over';

    // 3) ベースの上に、切り抜いた edit を重ねる（マスク外は 100% ベース）。
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const octx = out.getContext('2d');
    if (!octx) return editDataUrl;
    octx.drawImage(baseImg, 0, 0, width, height);
    octx.drawImage(cut, 0, 0);

    const isJpeg =
      baseDataUrl.startsWith('data:image/jpeg') || /\.jpe?g/i.test(baseDataUrl.slice(0, 40));
    return isJpeg ? out.toDataURL('image/jpeg', 0.92) : out.toDataURL('image/png');
  } catch {
    return editDataUrl;
  }
}
