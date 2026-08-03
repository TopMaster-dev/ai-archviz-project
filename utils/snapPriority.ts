/**
 * 2Dスケッチのスナップ優先順位（260803 クライアント要望）。
 *
 * 【背景】
 * 既存の頂点と同じ X／Y に揃える「整列スナップ（頂点の延長線上への吸着）」は、
 * 利用者が設定した長さ・角度・グリッドのスナップより先に成立して確定してしまい、
 * 「設定した寸法どおりに描けない」という指摘を受けた。
 * 整列スナップには ON/OFF が無く常時有効で、成立した時点で以降の判定へ進まない構造だった。
 *
 * 【方針】
 * 利用者が明示的に有効にしたスナップ（長さ・角度・グリッド）が1つでもあれば、
 * そちらを常に優先し、整列スナップは行わない。
 * 3つとも無効にして自由に描くときだけ、従来どおり整列が効く。
 *
 * 判定だけを純粋関数として切り出しているのは、この優先順位が
 * 「たまたま今の操作では気付かない」形で崩れやすいため。数値で固定する。
 */

export interface SnapSettings {
  lengthEnabled: boolean;
  /** 長さスナップの刻み（mm）。0以下は無効とみなす。 */
  lengthMm: number;
  angleEnabled: boolean;
  /** 角度スナップの刻み（度）。0以下は無効とみなす。 */
  angleDeg: number;
  gridEnabled: boolean;
  /** グリッドの間隔（mm）。0以下は無効とみなす。 */
  gridMm: number;
}

/**
 * 利用者が明示的に設定したスナップが1つでも有効か。
 * 「有効フラグが立っている」だけでなく、刻みが正の値であることまで見る
 * （0や負の刻みは割り算が成立せず、実質無効のため）。
 */
export function hasExplicitSnap(s: SnapSettings): boolean {
  return (
    (s.lengthEnabled && s.lengthMm > 0) ||
    (s.angleEnabled && s.angleDeg > 0) ||
    (s.gridEnabled && s.gridMm > 0)
  );
}

/**
 * 頂点の延長線上への整列スナップを行ってよいか。
 * 明示的なスナップ設定が1つでもあるときは行わない（そちらを優先する）。
 */
export function shouldUseAlignSnap(s: SnapSettings): boolean {
  return !hasExplicitSnap(s);
}
