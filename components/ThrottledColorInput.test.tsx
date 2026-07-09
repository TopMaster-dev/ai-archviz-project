import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { ThrottledColorInput } from './ThrottledColorInput.js';

/**
 * スポイトの連続 onChange をスロットルして 3D 再レンダーを間引く動作の契約（260709）。
 * 固まり防止の要は「連続発火を間引く＋最後の値は必ず反映」。
 */
describe('ThrottledColorInput（スロットル・末尾コミット）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000); // lastCommitRef=0 に対し十分大きい＝初回は即時コミット
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('初回は即時コミット、スロットル窓内の連続変更は末尾で最後の値だけコミットする', () => {
    const onChange = vi.fn();
    const { container } = render(
      <ThrottledColorInput value="#000000" onChange={onChange} throttleMs={80} />
    );
    const input = container.querySelector('input[type=color]') as HTMLInputElement;

    // 初回変更（elapsed 大）＝即時コミット
    act(() => {
      fireEvent.change(input, { target: { value: '#111111' } });
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('#111111');

    // 10ms後に2連続変更（どちらもスロットル窓内）＝この時点ではコミットされない
    act(() => {
      vi.advanceTimersByTime(10);
      fireEvent.change(input, { target: { value: '#222222' } });
      fireEvent.change(input, { target: { value: '#333333' } });
    });
    expect(onChange).toHaveBeenCalledTimes(1); // まだ末尾コミット前

    // 末尾コミットのタイマーが発火＝最後の値(#333333)だけが反映される
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith('#333333');
  });

  it('操作中（フォーカス中）は、親の value 再レンダーで input の DOM 値を上書きしない（ネイティブピッカーを乱さない・拒否音/操作不能の防止）', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <ThrottledColorInput value="#000000" onChange={onChange} throttleMs={80} />
    );
    const input = container.querySelector('input[type=color]') as HTMLInputElement;
    // ユーザーがピッカー/スポイトで色を選んでいる状態を再現（フォーカス＋DOM値変更）。
    act(() => {
      input.focus();
      fireEvent.change(input, { target: { value: '#123456' } });
    });
    expect(input.value).toBe('#123456');
    // フォーカス中に親が別 value で再レンダーしても、DOM 値は上書きされない（＝ネイティブピッカーを乱さない）。
    act(() => {
      rerender(<ThrottledColorInput value="#ffffff" onChange={onChange} throttleMs={80} />);
    });
    expect(input.value).toBe('#123456');
  });

  it('非フォーカス時は、外部の value 変更を input へ同期する（プロジェクト読込・別操作の反映）', () => {
    const { container, rerender } = render(
      <ThrottledColorInput value="#000000" onChange={() => {}} throttleMs={80} />
    );
    const input = container.querySelector('input[type=color]') as HTMLInputElement;
    // フォーカスしていない状態（activeElement は body）で親が value を変更。
    act(() => {
      rerender(<ThrottledColorInput value="#abcdef" onChange={() => {}} throttleMs={80} />);
    });
    expect(input.value).toBe('#abcdef');
  });
});
