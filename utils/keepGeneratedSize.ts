import { ENABLE_KEEP_GENERATED_SIZE } from './printExportSpec.js';

/**
 * 生成結果を「リサイズせずに」採用するための寸法計算
 * （260731 クライアント指摘「編集を重ねるとぼやける」／260814 手段1・2 として実装）。
 *
 * 【何が起きていたか】
 * 生成結果は必ず fitDataUrlToSize(出力, baseW, baseH) に通していた。
 * つまり「モデルが返した寸法」→「いまの版の寸法」へ毎回リサンプルしていた。
 *  ・版が生成より小さい（旧1K版・写真取込1536px）→ 縮小され、解像度が上がらないまま眠さだけ蓄積
 *  ・版が生成より大きい（取込時に2688へ拡大した4:3写真など）→ **拡大**され、
 *    存在しない画素を補間で作ってからぼかす＝こちらのほうが実害が大きい
 * どちらも「1回の編集あたりのリサンプル損失（損失A）」であり、編集のたびに積み上がる。
 *
 * 【手段1】モデルが返した寸法のまま採用する。縦横比がずれた場合だけ補正する。
 * 下の計算は、そのままこの仕様になっている:
 *   scale = min(ow/bw, oh/bh) として (bw*scale, bh*scale) を返す。
 *   ・生成とベースの比が同じ  → scale = ow/bw なので、返る寸法は生成寸法そのもの（＝リサイズ無し）
 *   ・比がずれている          → ベースの比を保ったまま、生成画像に収まる最大寸法（＝拡大しない）
 * 以前はここに `scale <= 1 ならベース寸法を返す` というクランプがあり、
 * 生成がベースより小さいときだけ**拡大**していた。手段1はこのクランプを外すこと。
 *
 * 【手段2】土台の上限（AREA_EDIT_BASE_MAX_SIDE）を生成長辺に一致させる。
 * 土台が生成より大きくなり得なくなるため、リサイズが原理的に発生しなくなる。
 * printExportSpec.ts 側で定義している。
 *
 * 【適用範囲】合成（マスク座標）を伴わない全画面採用・精細化の経路でのみ使うこと。
 * 合成経路は baseW/baseH を座標系の基準にしているため、寸法を変えると前提が崩れる。
 */

export interface Size {
  w: number;
  h: number;
}

/**
 * 生成結果の寸法をそのまま採用する（縦横比だけベースへ合わせる）。
 *
 * 拡大は決してしない。返る寸法は必ず生成結果の内側に収まる。
 *
 * @param base   いまの版の実寸（**アスペクト比の基準にのみ使う**。寸法の下限ではない）。
 * @param output 生成結果の実寸。
 */
export function keepGeneratedSize(
  base: Size,
  output: Size,
  /**
   * true = 手段1（生成寸法をそのまま採用。生成がベースより小さくても拡大しない）。
   * false = 手段1 導入前の挙動（生成がベースより小さければベース寸法へ拡大する）。
   * 既定はフラグに従う。テストが両モードを直接検証できるよう引数にしてある。
   */
  adoptGenerated: boolean = ENABLE_KEEP_GENERATED_SIZE,
): Size {
  // Math.max(1, Math.round(NaN)) は NaN になるため、先に有限判定でふるい落とす
  // （寸法に NaN が混ざるとキャンバスの生成ごと失敗する）。
  const px = (v: number) => (Number.isFinite(v) && v > 0 ? Math.max(1, Math.round(v)) : 1);
  const bw = px(base.w);
  const bh = px(base.h);
  const ow = px(output.w);
  const oh = px(output.h);

  const scale = Math.min(ow / bw, oh / bh);
  // 寸法が壊れている場合のみベースへ退避（0除算・NaN 対策）。
  if (!Number.isFinite(scale) || scale <= 0) return { w: bw, h: bh };

  /*
    【260818 フェーズ0】手段1 が無効のときは、導入前のクランプを復元する。
    このクランプの有無が手段1の実体であり、共有関数なので
    精細化(enhance)・画質を戻す の2経路もここを通る。
    呼び出し側のフラグ分岐だけでは、その2経路が巻き戻らず A/B の結果が濁る。
  */
  if (!adoptGenerated && scale <= 1) return { w: bw, h: bh };

  // ベースのアスペクト比のまま、生成結果に収まる最大の寸法。
  // 比が一致していれば scale = ow/bw となり、生成寸法がそのまま返る＝リサイズが起きない。
  return { w: px(bw * scale), h: px(bh * scale) };
}
