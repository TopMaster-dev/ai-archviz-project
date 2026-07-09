import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { ThrottledColorInput } from './ThrottledColorInput.js';
import { useRoom3DPause } from '../lib/store/room3DPauseStore.js';

/**
 * 3Dカラー入力の契約（260709）:
 *  - 反映は commit（change＝ピッカーを閉じたとき）のみ。input（操作中の連続発火）では反映しない
 *    ＝スポイトでスクリーン（3Dキャンバス）を読み取っている最中に 3D を再レンダーしない＝ハング防止。
 *  - 非制御。操作中（フォーカス中）は外部 value 変更で DOM 値を上書きしない（ネイティブピッカーを乱さない）。
 */
describe('ThrottledColorInput（commit反映・非制御）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('input（操作中の連続発火）では反映せず、change（コミット）でのみ反映する', () => {
    const onChange = vi.fn();
    const { container } = render(<ThrottledColorInput value="#000000" onChange={onChange} />);
    const input = container.querySelector('input[type=color]') as HTMLInputElement;

    // 操作中（input）＝反映しない（3Dを触らない＝スポイトと競合しない）
    act(() => {
      fireEvent.input(input, { target: { value: '#111111' } });
    });
    expect(onChange).not.toHaveBeenCalled();

    // コミット（change＝ピッカーを閉じた）＝最終色を反映
    act(() => {
      fireEvent.change(input, { target: { value: '#222222' } });
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('#222222');
  });

  it('操作中（フォーカス中）は、親の value 再レンダーで input の DOM 値を上書きしない（ネイティブピッカーを乱さない）', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <ThrottledColorInput value="#000000" onChange={onChange} />
    );
    const input = container.querySelector('input[type=color]') as HTMLInputElement;
    act(() => {
      input.focus();
      fireEvent.input(input, { target: { value: '#123456' } });
    });
    expect(input.value).toBe('#123456');
    // フォーカス中に親が別 value で再レンダーしても DOM 値は上書きされない
    act(() => {
      rerender(<ThrottledColorInput value="#ffffff" onChange={onChange} />);
    });
    expect(input.value).toBe('#123456');
  });

  it('非フォーカス時は、外部の value 変更を input へ同期する（プロジェクト読込・別操作の反映）', () => {
    const { container, rerender } = render(
      <ThrottledColorInput value="#000000" onChange={() => {}} />
    );
    const input = container.querySelector('input[type=color]') as HTMLInputElement;
    act(() => {
      rerender(<ThrottledColorInput value="#abcdef" onChange={() => {}} />);
    });
    expect(input.value).toBe('#abcdef');
  });

  it('ピッカー/スポイトを開いている間は3Dを一時停止し、commit(change)で反映と同時に再開する', () => {
    useRoom3DPause.setState({ pauseCount: 0 });
    const onChange = vi.fn();
    const { container } = render(
      <ThrottledColorInput value="#000000" onChange={onChange} />
    );
    const input = container.querySelector('input[type=color]') as HTMLInputElement;
    expect(useRoom3DPause.getState().pauseCount).toBe(0);

    // ピッカーを開く（スワッチをクリック）→ 3D停止（スポイトがスクリーンを読む間、静止させる）
    act(() => {
      fireEvent.click(input);
    });
    expect(useRoom3DPause.getState().pauseCount).toBe(1);

    // 重ねてクリック/フォーカスしても二重取得しない（1対1を維持）
    act(() => {
      fireEvent.focus(input);
      fireEvent.click(input);
    });
    expect(useRoom3DPause.getState().pauseCount).toBe(1);

    // commit（ピッカーを閉じた＝change）→ 色を反映し、同時に3Dを再開（閉じた瞬間に新色が見える）
    act(() => {
      fireEvent.change(input, { target: { value: '#334455' } });
    });
    expect(onChange).toHaveBeenLastCalledWith('#334455');
    expect(useRoom3DPause.getState().pauseCount).toBe(0);

    // 連続でもう一度開く → 再取得できる（フォーカスが残っていてもクリックで発火）
    act(() => {
      fireEvent.click(input);
    });
    expect(useRoom3DPause.getState().pauseCount).toBe(1);
  });

  it('ピッカーを開いたまま何も選ばず離脱（blur）/アンマウントしても必ず3Dを再開する', () => {
    useRoom3DPause.setState({ pauseCount: 0 });
    const { container, unmount } = render(
      <ThrottledColorInput value="#000000" onChange={() => {}} />
    );
    const input = container.querySelector('input[type=color]') as HTMLInputElement;

    // 開く → 停止 → 何も選ばず blur（キャンセル）→ 再開
    act(() => {
      fireEvent.click(input);
    });
    expect(useRoom3DPause.getState().pauseCount).toBe(1);
    act(() => {
      fireEvent.blur(input);
    });
    expect(useRoom3DPause.getState().pauseCount).toBe(0);

    // 開いたままアンマウントされても解放される（3Dが止まったままにならない）
    act(() => {
      fireEvent.click(input);
    });
    expect(useRoom3DPause.getState().pauseCount).toBe(1);
    act(() => {
      unmount();
    });
    expect(useRoom3DPause.getState().pauseCount).toBe(0);
  });
});
