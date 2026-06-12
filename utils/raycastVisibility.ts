// レイキャスト時の「実効的な可視性」判定ヘルパー。
//
// react-three-fiber はポインタイベント用に「ハンドラを持つメッシュ」を内部リストから直接
// レイキャストするため、親 group の visible=false が効かない（three の通常のシーン走査と違い、
// 先祖の可視状態を見ない）。その結果、カメラ手前のためカットアウェイで非表示にしているはずの壁が
// クリックを吸ってしまい、奥のオブジェクトを横から選択できない問題が起きる。
//
// これを補うため、Mesh.prototype.raycast を「先祖に visible=false があればスキップ」するよう
// ラップする。自身の visible=false は対象にしない（開口部選択用の透明ヒットメッシュ等、
// 意図的に不可視だがクリック可能なメッシュを壊さないため）。

export interface VisibilityNode {
  visible?: boolean;
  parent?: VisibilityNode | null;
}

/**
 * 自分自身を除く先祖のいずれかが visible=false なら true。
 * （= 非表示 group の配下にあるメッシュ。レイキャスト対象から外すべき。）
 */
export function hasInvisibleAncestor(obj: VisibilityNode | null | undefined): boolean {
  let node = obj?.parent ?? null;
  while (node) {
    if (node.visible === false) return true;
    node = node.parent ?? null;
  }
  return false;
}
