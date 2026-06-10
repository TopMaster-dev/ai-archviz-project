import type { Beam } from '../lib/project/projectState.js';

/**
 * 梁の露出表面積(m²)を返す（見積の数量算出用）。
 *
 * クライアント要望（260610 #4a）: 「壁や天井に接している面は除く」。
 *  - 上面（天井に接する, L×W）は常に除外。
 *  - 壁梁（wallIndex 指定）は、壁に接する長辺側面（L×H）も除外。
 *  - 端面（W×H ×2）は、垂直壁への突き当たり検出が困難なため控除しない（安全側）。
 *
 * L=lengthMm, W=widthMm, H=heightMm（mm→m）。非有限/非正は 0 を返す。
 */
export function beamExposedAreaM2(
  beam: Pick<Beam, 'lengthMm' | 'widthMm' | 'heightMm' | 'wallIndex'>,
): number {
  const L = (Number.isFinite(beam.lengthMm) ? beam.lengthMm : 0) / 1000;
  const W = (Number.isFinite(beam.widthMm) ? beam.widthMm : 0) / 1000;
  const H = (Number.isFinite(beam.heightMm) ? beam.heightMm : 0) / 1000;
  if (L <= 0 || W <= 0 || H <= 0) return 0;
  const ends = 2 * (W * H);
  const bottom = L * W;
  // 自由梁: 両長辺側面を計上。壁梁: 壁に接する片側を除外。
  const sides = beam.wallIndex !== undefined ? L * H : 2 * (L * H);
  return ends + bottom + sides;
}
