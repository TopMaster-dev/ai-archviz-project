/**
 * 生成結果を「縮めずに」ベースへ合わせるための寸法計算（260731 クライアント指摘「編集を重ねるとぼやける」）。
 *
 * これまでは生成結果を必ず fitDataUrlToSize(出力, baseW, baseH) に通していた。
 * ベースが 2K ネイティブ（長辺≒2688px）なら等倍なので問題無いが、
 * 1K 時代に作られた版や、写真取込（長辺1536pxで登録）の版では、
 * 毎回「2688px で生成 → 1536px へ縮小」が入り、編集のたびに解像度が上がらないまま
 * 生成的な拡大と縮小を往復する＝眠さだけが蓄積していた（解像度のラチェット）。
 *
 * ここでは「アスペクト比はベースに合わせる。ただし寸法はベースより小さくしない」を計算する。
 * 合成（マスク座標）を伴わない全画面採用・精細化の経路でのみ使うこと。
 * 合成経路は baseW/baseH を座標系の基準にしているため、寸法を変えると前提が崩れる。
 */

export interface Size {
  w: number;
  h: number;
}

/**
 * ベースのアスペクト比を保ったまま、生成結果の解像度を活かす出力寸法を返す。
 *
 * @param base   いまの版の実寸（アスペクト比の基準）。
 * @param output 生成結果の実寸。
 */
export function keepGeneratedSize(base: Size, output: Size): Size {
  const bw = Math.max(1, Math.round(base.w));
  const bh = Math.max(1, Math.round(base.h));
  const ow = Math.max(1, Math.round(output.w));
  const oh = Math.max(1, Math.round(output.h));

  // 生成結果がベース以下なら、従来どおりベース寸法に合わせる（引き伸ばしはしない＝画質は増えない）。
  const scale = Math.min(ow / bw, oh / bh);
  if (!Number.isFinite(scale) || scale <= 1) return { w: bw, h: bh };

  // ベースのアスペクト比のまま、生成結果に収まる最大の寸法へ引き上げる。
  return { w: Math.round(bw * scale), h: Math.round(bh * scale) };
}
