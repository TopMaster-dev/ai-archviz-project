import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAiEditSession, MAX_AI_EDIT_VERSIONS, collectVersionsToDelete } from './useAiEditSession.js';

// 履歴保持の中核挙動: 新規レンダーは履歴を消さずに「追加」する（クライアント要望・見返せるように）。
describe('useAiEditSession render history', () => {
  it('addVersionFromRender APPENDS new roots and keeps previous history', () => {
    const { result } = renderHook(() => useAiEditSession({ persistLocal: false }));

    act(() => result.current.addVersionFromRender('data:image/png;base64,AAA'));
    act(() => result.current.addVersionFromRender('data:image/png;base64,BBB'));
    act(() => result.current.addVersionFromRender('data:image/png;base64,CCC'));

    // 3回のレンダーが全て履歴に残る（上書きされない）。
    expect(result.current.versions).toHaveLength(3);
    expect(result.current.versions.map((v) => v.outputImageDataUrl)).toEqual([
      'data:image/png;base64,AAA',
      'data:image/png;base64,BBB',
      'data:image/png;base64,CCC',
    ]);
    // 各レンダーは独立したルート（parentId=null）。
    expect(result.current.versions.every((v) => v.parentId === null)).toBe(true);
    // 最新が選択中。
    expect(result.current.activeVersionId).toBe(result.current.versions[2].id);
  });

  it('selectVersion lets the user go back to an earlier render', () => {
    const { result } = renderHook(() => useAiEditSession({ persistLocal: false }));
    act(() => result.current.addVersionFromRender('data:image/png;base64,AAA'));
    act(() => result.current.addVersionFromRender('data:image/png;base64,BBB'));
    const firstId = result.current.versions[0].id;
    act(() => result.current.selectVersion(firstId));
    expect(result.current.activeVersionId).toBe(firstId);
    expect(result.current.activeVersion?.outputImageDataUrl).toBe('data:image/png;base64,AAA');
  });

  it('caps history at MAX_AI_EDIT_VERSIONS, dropping the oldest (bounds memory/DB growth)', () => {
    const { result } = renderHook(() => useAiEditSession({ persistLocal: false }));
    const total = MAX_AI_EDIT_VERSIONS + 5;
    for (let i = 0; i < total; i++) {
      act(() => result.current.addVersionFromRender(`data:image/png;base64,IMG${i}`));
    }
    expect(result.current.versions).toHaveLength(MAX_AI_EDIT_VERSIONS);
    // 最古5件(IMG0..IMG4)は間引かれ、最新が末尾に残る。
    expect(result.current.versions[0].outputImageDataUrl).toBe('data:image/png;base64,IMG5');
    expect(result.current.versions[MAX_AI_EDIT_VERSIONS - 1].outputImageDataUrl).toBe(
      `data:image/png;base64,IMG${total - 1}`,
    );
  });
});

// 生成結果の削除（260625・暗黙的フィードバックの「削除」項目）。
describe('collectVersionsToDelete (cascade)', () => {
  // a(root) → b(child) → c(grandchild) ; d(root) は無関係。
  const tree = [
    { id: 'a', parentId: null },
    { id: 'b', parentId: 'a' },
    { id: 'c', parentId: 'b' },
    { id: 'd', parentId: null },
  ];

  it('葉を削除すると自分だけ', () => {
    expect([...collectVersionsToDelete(tree, 'c')].sort()).toEqual(['c']);
  });

  it('親を削除すると子・孫まで連鎖（孫の取りこぼし無し）', () => {
    expect([...collectVersionsToDelete(tree, 'a')].sort()).toEqual(['a', 'b', 'c']);
  });

  it('中間を削除するとその子孫のみ（兄弟ルートや祖先は残す）', () => {
    expect([...collectVersionsToDelete(tree, 'b')].sort()).toEqual(['b', 'c']);
    expect(collectVersionsToDelete(tree, 'b').has('a')).toBe(false);
    expect(collectVersionsToDelete(tree, 'b').has('d')).toBe(false);
  });

  it('無関係なルートは他に影響しない', () => {
    expect([...collectVersionsToDelete(tree, 'd')].sort()).toEqual(['d']);
  });
});

describe('useAiEditSession deleteVersion', () => {
  it('削除すると履歴から消え、最新の残存版が自動選択される', () => {
    const { result } = renderHook(() => useAiEditSession({ persistLocal: false }));
    act(() => result.current.addVersionFromRender('data:image/png;base64,AAA'));
    act(() => result.current.addVersionFromRender('data:image/png;base64,BBB'));
    act(() => result.current.addVersionFromRender('data:image/png;base64,CCC'));
    const ccc = result.current.versions[2].id;
    // アクティブ(CCC)を削除 → 残った最新(BBB)が選択される。
    act(() => result.current.deleteVersion(ccc));
    expect(result.current.versions).toHaveLength(2);
    expect(result.current.versions.some((v) => v.id === ccc)).toBe(false);
    expect(result.current.activeVersion?.outputImageDataUrl).toBe('data:image/png;base64,BBB');
  });

  it('全件削除すると versions は空・activeVersionId は null', () => {
    const { result } = renderHook(() => useAiEditSession({ persistLocal: false }));
    act(() => result.current.addVersionFromRender('data:image/png;base64,AAA'));
    act(() => result.current.deleteVersion(result.current.versions[0].id));
    expect(result.current.versions).toHaveLength(0);
    expect(result.current.activeVersionId).toBeNull();
  });
});
