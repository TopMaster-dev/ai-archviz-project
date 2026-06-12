import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAiEditSession, MAX_AI_EDIT_VERSIONS } from './useAiEditSession.js';

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
