// 3Dモデルの取り込み単位（③・260717 クライアント要望）。
// アップロード時に「1モデル単位 = ㎜/㎝/m/インチ/フィート」を選ばせ、実寸で取り込む。
//
// 実装方針＝「幾何プリスケール」：選択単位のメートル係数 f_U（1モデル単位あたりのメートル数）を
// モデルのジオメトリに直接掛ける（描画側 ClayModel と計測 computeGltfFootprintBaseMm の両方で同一適用）。
// これにより実寸サイズが footprint2d / 描画に等しく反映され、FurnitureItem.scale は 1 のままで済む。
//   rendered(m) = rawNative(モデル単位) × f_U = 実寸
// scale を極端値（例 0.001）にする方式は 2D 足跡のスケール下限/寸法クランプに抵触して 2D/3D がずれるため採らない
// （幾何側に補正を入れることで scale は常識的な範囲に保たれる）。
// 'auto' は f_U=null＝既定挙動（glTFは無変換・FBX/OBJは exoticNormalizeScale のヒューリスティクス）。

export type ModelUnit = 'auto' | 'mm' | 'cm' | 'm' | 'inch' | 'feet';

export const MODEL_UNIT_OPTIONS: { value: ModelUnit; label: string }[] = [
  { value: 'auto', label: '自動' },
  { value: 'mm', label: 'ミリ (㎜)' },
  { value: 'cm', label: 'センチ (㎝)' },
  { value: 'm', label: 'メートル (m)' },
  { value: 'inch', label: 'インチ (in)' },
  { value: 'feet', label: 'フィート (ft)' }
];

/** 1モデル単位あたりのメートル数（= ジオメトリに掛ける幾何スケール f_U）。 */
const UNIT_METERS: Record<Exclude<ModelUnit, 'auto'>, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  inch: 0.0254,
  feet: 0.3048
};

export function isExplicitModelUnit(u: unknown): u is Exclude<ModelUnit, 'auto'> {
  return u === 'mm' || u === 'cm' || u === 'm' || u === 'inch' || u === 'feet';
}

/** 任意の値を安全に ModelUnit へ丸める（未知/未設定は 'auto'）。 */
export function normalizeModelUnit(u: unknown): ModelUnit {
  return u === 'auto' || isExplicitModelUnit(u) ? u : 'auto';
}

/**
 * 明示単位のときの幾何プリスケール f_U（ジオメトリに掛けて実寸にする係数）。
 * 'auto'・不正値は null（既定挙動＝ヒューリスティクスに任せる）を返す。
 * この値は計測時に確定でき（normalizeScale 不要）、アップロード確定時に同期的に metadata へ保存できる。
 */
export function unitGeometryScale(unit: ModelUnit): number | null {
  return isExplicitModelUnit(unit) ? UNIT_METERS[unit] : null;
}

/**
 * 幾何スケールが有限で正のときだけ採用する健全化ヘルパ（描画/計測の共通ガード）。
 * 返り値 null は「幾何スケールを適用しない（既定挙動）」を意味する。
 */
export function sanitizeGeometryScale(scale: number | null | undefined): number | null {
  return typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : null;
}
