// 3Dモデルの形式判定。URL の拡張子（または blob: URL に付与した #fragment ヒント）から種別を返す。
// アップロード/カタログの URL は拡張子を持つが、ローカル選択の blob: URL は拡張子を持たないため
// 呼び出し側で `${objectUrl}#fbx` のように元拡張子を fragment で付与する運用にしている。

export type ModelFormat = 'gltf' | 'glb' | 'fbx' | 'obj';

const KNOWN: ModelFormat[] = ['gltf', 'glb', 'fbx', 'obj'];

/** URL から 3Dモデル形式を判定。判定不能なら null（呼び出し側で glTF を既定にフォールバックする）。 */
export function modelFormatOf(url: string | null | undefined): ModelFormat | null {
  if (!url) return null;
  const lower = url.toLowerCase();

  // blob: URL 等は拡張子を持たないので #fbx / #.obj のような fragment ヒントを優先採用する。
  const hashIdx = lower.indexOf('#');
  if (hashIdx >= 0) {
    const frag = lower.slice(hashIdx + 1).replace(/^\./, '');
    const fromFrag = KNOWN.find((k) => k === frag);
    if (fromFrag) return fromFrag;
  }

  // クエリ・フラグメントを除いたパス部分の拡張子を見る。
  const path = lower.split(/[?#]/)[0];
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = path.slice(dot + 1);
  return KNOWN.find((k) => k === ext) ?? null;
}

// FBX/OBJ 用のサイズ正規化スケール。FBX は cm 単位で書き出されることが多く（約100倍）、
// glTF カタログ（1単位=1m 前提）と混ぜると桁違いに巨大／極小に描画されてしまう。
// バウンディングの最大辺（m）が常識的な家具サイズに収まるようスケール係数を返す（範囲内は等倍）。
const EXOTIC_MAX_DIM_M = 4; // これを超える（cm 単位の FBX 等）は縮小
const EXOTIC_MIN_DIM_M = 0.05; // これ未満（極小単位）は拡大

export function exoticNormalizeScale(maxDimMeters: number): number {
  if (!Number.isFinite(maxDimMeters) || maxDimMeters <= 0) return 1;
  if (maxDimMeters > EXOTIC_MAX_DIM_M) return EXOTIC_MAX_DIM_M / maxDimMeters;
  if (maxDimMeters < EXOTIC_MIN_DIM_M) return EXOTIC_MIN_DIM_M / maxDimMeters;
  return 1;
}
