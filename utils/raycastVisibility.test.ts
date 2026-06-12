import { describe, it, expect } from 'vitest';
import { hasInvisibleAncestor, type VisibilityNode } from './raycastVisibility.js';

const node = (visible: boolean, parent: VisibilityNode | null = null): VisibilityNode => ({ visible, parent });

describe('hasInvisibleAncestor', () => {
  it('false when no parent', () => {
    expect(hasInvisibleAncestor(node(true))).toBe(false);
    expect(hasInvisibleAncestor(node(false))).toBe(false); // 自身は対象外
  });

  it('false when all ancestors are visible', () => {
    const root = node(true);
    const mid = node(true, root);
    const leaf = node(true, mid);
    expect(hasInvisibleAncestor(leaf)).toBe(false);
  });

  it('true when any ancestor is invisible (cut-away wall group)', () => {
    const root = node(true);
    const hiddenGroup = node(false, root); // 非表示の壁group
    const wallMesh = node(true, hiddenGroup);
    expect(hasInvisibleAncestor(wallMesh)).toBe(true);
  });

  it('IGNORES self visible=false — the opening hit mesh stays clickable', () => {
    // 開口部の透明ヒットメッシュ: 自身 visible=false だが先祖は可視 → スキップしない（クリック可）。
    const wallGroup = node(true);
    const openingGroup = node(true, wallGroup);
    const hitMesh = node(false, openingGroup);
    expect(hasInvisibleAncestor(hitMesh)).toBe(false);
  });

  it('true when the same hit mesh is under a cut-away wall', () => {
    const hiddenWallGroup = node(false);
    const openingGroup = node(true, hiddenWallGroup);
    const hitMesh = node(false, openingGroup);
    expect(hasInvisibleAncestor(hitMesh)).toBe(true);
  });

  it('handles null/undefined safely', () => {
    expect(hasInvisibleAncestor(null)).toBe(false);
    expect(hasInvisibleAncestor(undefined)).toBe(false);
  });
});
