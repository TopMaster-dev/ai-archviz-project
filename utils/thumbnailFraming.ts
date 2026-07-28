/**
 * 3Dモデルサムネイルの「寄り」を決める計算（260730 クライアント要望④）。
 *
 * これまではモデルの外接球の半径が 1.8 になるよう一律に縮小していた。
 * 既定カメラ（透視・画角75°・z=5）だと、それはフレーム高さの約50%にしか写らない＝周囲が半分余白になる。
 * クライアントの「モデルが小さく中央に写ってしまう」はこの余白のこと。
 *
 * 【切れない上限の求め方】よくある間違いは tan で見積もること。
 * 透視投影では、原点を中心とする半径 R の球が視野に収まる条件は R <= d * sin(fov/2) であって
 * d * tan(fov/2) ではない（球はカメラから見て「輪郭が接する」位置で切れるため）。
 * 画角75°・距離5なら tan だと 3.84、正しくは sin で 3.04。tan を信じると必ず端が欠ける。
 *
 * 外接球で合わせている理由は「回転しても絶対に切れない」ため。
 * Box3.getBoundingSphere はバウンディングボックスの外接球（半径＝対角線の半分）を返すので、
 * 細長い物（フロアランプ）では対角線≒長辺となり無駄は小さい。逆に箱型（アームチェア）ほど余白が出る。
 * つまり形ごとの詰め方より、この定数を上げることの方が効く。
 */

/** サムネイル生成に使うカメラ（既定任せにせず明示する。ライブラリ既定が変わると全サムネイルが変わるため）。 */
export const THUMBNAIL_CAMERA = { fov: 75, position: [0, 0, 5] as [number, number, number] };

/**
 * 合わせる先の外接球半径（ワールド単位）。
 * 2.5 でフレーム高さの約75%（従来1.8＝約50%）。切れない上限 3.04 に対して約18%の余裕を残す。
 */
export const THUMBNAIL_TARGET_RADIUS = 2.5;

/**
 * 「この半径まで拡大しても切れない」上限。
 * カメラ距離と画角から幾何学的に決まる値で、ここを超えると輪郭が欠ける。
 */
export function maxSafeRadius(
  fovDeg: number = THUMBNAIL_CAMERA.fov,
  distance: number = THUMBNAIL_CAMERA.position[2],
): number {
  return distance * Math.sin((fovDeg * Math.PI) / 180 / 2);
}

/**
 * 外接球の半径から、モデルへ掛ける拡大率を求める。
 * 半径が 0/未定義（頂点が1点しか無い等の壊れたモデル）でも 1 を返して落とさない。
 */
export function thumbnailFitScale(boundingSphereRadius: number, target: number = THUMBNAIL_TARGET_RADIUS): number {
  if (!Number.isFinite(boundingSphereRadius) || boundingSphereRadius <= 0) return 1;
  return target / boundingSphereRadius;
}
