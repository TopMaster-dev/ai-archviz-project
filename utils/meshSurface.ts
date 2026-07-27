/**
 * メッシュ名から「面の種類」を判定する唯一の真実源（260728 クライアント #3b）。
 *
 * クライアント要望:「見積の 壁・床・天井 区分は素材カタログのカテゴリではなく、3Dビューで実際に
 * 貼られた面で判定し、マテリアルボードと一致させる」。
 *
 * そのためには「3Dで面をクリックしたときの分類」と「見積/ボードの分類」が同じ規則でなければならない。
 * 以前は RoomViewer 側（取込モデルのクリック判定）と estimateExport 側で語彙も評価順も違っており、
 * 同じメッシュが 3D では床、PDF では壁、というズレが起き得た。両者からこの関数だけを呼ぶこと。
 *
 * 判定順は floor → ceiling → beam → wall（既定）。RoomViewer の従来実装（floor を先に見る）に合わせている。
 * 日本語CADの「床 / 天井 / 梁」も拾う（toLowerCase は漢字に影響しないので原文のまま判定する）。
 */
export type MeshSurfaceKind = 'floor' | 'ceiling' | 'beam' | 'wall';

export function surfaceFromMeshName(meshName: string): MeshSurfaceKind {
  const raw = meshName ?? '';
  const n = raw.toLowerCase();
  if (n.includes('floor') || raw.includes('床')) return 'floor';
  if (n.includes('ceiling') || n.includes('ceil') || raw.includes('天井')) return 'ceiling';
  if (n.includes('beam') || n.includes('hari') || raw.includes('梁')) return 'beam';
  return 'wall';
}
