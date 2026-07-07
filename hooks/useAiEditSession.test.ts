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

  // 「前の下絵の名残が残る」対策（260702）: 確定済みバージョンのマスク（エリア編集の範囲）を選択で復元しない。
  it('does NOT re-hydrate a committed version mask into draftObjects (no leftover overlay)', () => {
    const { result } = renderHook(() => useAiEditSession({ persistLocal: false }));
    act(() => result.current.addVersionFromRender('data:image/png;base64,AAA'));
    const rootId = result.current.versions[0].id;
    const maskObj = {
      id: 'obj1',
      imageDataUrl: null,
      placements: [
        {
          x: 0.2,
          y: 0.2,
          width: 0.3,
          height: 0.3,
          points: [
            { x: 0.2, y: 0.2 },
            { x: 0.5, y: 0.2 },
            { x: 0.35, y: 0.5 },
          ],
        },
      ],
      memo: '植木鉢を入れて',
      placementMemos: [],
    };
    act(() =>
      result.current.appendVersionAfterEdit({
        parentId: rootId,
        baseImageDataUrl: 'data:image/png;base64,AAA',
        outputImageDataUrl: 'data:image/png;base64,BBB',
        styleRefDataUrls: [],
        styleMemo: '',
        objects: [maskObj],
      }),
    );
    const childId = result.current.versions[result.current.versions.length - 1].id;
    // 編集直後は下書きが空（resetDraft）。
    expect(result.current.draftObjects).toEqual([]);
    // マスクの provenance はバージョンに保持される（履歴・再生成のため）。
    const child = result.current.versions.find((v) => v.id === childId)!;
    expect(child.objects).toHaveLength(1);
    expect(child.objects[0].placements[0].points).toHaveLength(3);
    // 他バージョンを経て結果バージョンを再選択しても、マスク下書きは復元されない（名残オーバーレイを出さない）。
    act(() => result.current.selectVersion(rootId));
    act(() => result.current.selectVersion(childId));
    expect(result.current.draftObjects).toEqual([]);
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

  it('任意削除（安全）: 親を削除しても子は残り、子の親は祖先へ繋ぎ替えられる', () => {
    const { result } = renderHook(() => useAiEditSession({ persistLocal: false }));
    act(() => result.current.addVersionFromRender('data:image/png;base64,ROOT'));
    const rootId = result.current.versions[0].id;
    act(() =>
      result.current.appendVersionAfterEdit({
        parentId: rootId,
        baseImageDataUrl: 'data:image/png;base64,ROOT',
        outputImageDataUrl: 'data:image/png;base64,CHILD',
        styleRefDataUrls: [],
        styleMemo: '',
        objects: [],
      }),
    );
    const childId = result.current.versions[1].id;
    // 親（root）を削除 → 親だけ消え、子は残る（連鎖削除しない）。
    act(() => result.current.deleteVersion(rootId));
    expect(result.current.versions.map((v) => v.id)).toEqual([childId]);
    // 子の親は root の親（=null）へ繋ぎ替え（迷子の版を残さない）。
    expect(result.current.versions[0].parentId).toBeNull();
  });

  it('任意削除（安全）: 中間版を削除すると子は祖父へ繋ぎ替わる', () => {
    const { result } = renderHook(() => useAiEditSession({ persistLocal: false }));
    act(() => result.current.addVersionFromRender('data:image/png;base64,A'));
    const a = result.current.versions[0].id;
    const mk = (parentId: string, out: string) =>
      result.current.appendVersionAfterEdit({
        parentId,
        baseImageDataUrl: 'data:image/png;base64,X',
        outputImageDataUrl: out,
        styleRefDataUrls: [],
        styleMemo: '',
        objects: [],
      });
    act(() => mk(a, 'data:image/png;base64,B'));
    const b = result.current.versions[1].id;
    act(() => mk(b, 'data:image/png;base64,C'));
    const c = result.current.versions[2].id;
    // 中間 B を削除 → A と C が残り、C の親は祖父 A へ。
    act(() => result.current.deleteVersion(b));
    expect(result.current.versions.map((v) => v.id).sort()).toEqual([a, c].sort());
    expect(result.current.versions.find((v) => v.id === c)?.parentId).toBe(a);
  });
});
