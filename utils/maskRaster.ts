import type { NormalizedRect } from '../types.js';

/**
 * 囲った範囲（多角形/矩形）を、インペイントエンジンへ渡す白黒マスク画像（data URL）に変換する（260711・フェーズ1）。
 * 慣例: **白 = 編集する範囲 / 黒 = 保持**（LaMa・FLUX Fill 等の一般的な入力）。エンジンが逆慣例（黒=編集）の場合は
 * アダプタ側で反転する。実際の画素描画は compositeMaskedEdit と同じ手順（nonzero 塗り・多角形/矩形）に揃える。
 *
 * dilatePx: マスクを外側へ少し広げる（生成物が囲みの縁で切れないよう余裕を持たせる）。範囲外を絶対に変えない
 * 保証は「エンジン出力を compositeMaskedEdit で元画像へ貼り戻す」ことで別途担保するので、送るマスクは少し広くてよい。
 *
 * canvas を使うためクライアント（ブラウザ）側で実行する純DOMユーティリティ。
 */
export async function rasterizeMaskDataUrl(
  placements: NormalizedRect[],
  width: number,
  height: number,
  opts?: { dilatePx?: number; invert?: boolean }
): Promise<string> {
  if (!placements || placements.length === 0 || width <= 0 || height <= 0) {
    throw new Error('rasterizeMaskDataUrl: 領域または寸法が不正です');
  }
  const dilate = Math.max(0, Math.round(opts?.dilatePx ?? 0));
  const editColor = opts?.invert ? '#000000' : '#ffffff';
  const keepColor = opts?.invert ? '#ffffff' : '#000000';

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('rasterizeMaskDataUrl: 2D コンテキストを取得できません');

  // 保持色（既定=黒）で全面を塗り、編集範囲を編集色（既定=白）で塗る。
  ctx.fillStyle = keepColor;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = editColor;
  ctx.strokeStyle = editColor;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (dilate > 0) ctx.lineWidth = dilate * 2;

  for (const p of placements) {
    if (p.points && p.points.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(p.points[0].x * width, p.points[0].y * height);
      for (let i = 1; i < p.points.length; i += 1) {
        ctx.lineTo(p.points[i].x * width, p.points[i].y * height);
      }
      ctx.closePath();
      ctx.fill('nonzero'); // 自己交差でも穴を空けず塗り潰す（compositeMaskedEdit と同じ）
      if (dilate > 0) ctx.stroke(); // 外側へ dilate ぶん膨張
    } else if (dilate > 0) {
      ctx.fillRect(
        p.x * width - dilate,
        p.y * height - dilate,
        p.width * width + dilate * 2,
        p.height * height + dilate * 2
      );
    } else {
      ctx.fillRect(p.x * width, p.y * height, p.width * width, p.height * height);
    }
  }

  // マスクは白黒でよいので PNG（可逆）で返す。
  return canvas.toDataURL('image/png');
}
