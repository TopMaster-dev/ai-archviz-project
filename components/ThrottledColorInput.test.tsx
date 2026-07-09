import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import React from 'react';
import { ThrottledColorInput } from './ThrottledColorInput.js';
import { hexToHsv, hsvToHex } from '../utils/colorConvert.js';

/**
 * 自作カラーピッカー（260709）の契約テスト。
 * 重要: ネイティブ <input type="color"> を一切描画しない＝ブラウザ標準スポイト（固まりの原因）を開けない。
 * 色の指定は hex 入力・プリセット・(実機での)彩度/明度/色相ドラッグで行い、onChange(hex) で反映する。
 */
describe('ThrottledColorInput（自作ピッカー・ネイティブ入力なし）', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function setup(props?: Partial<React.ComponentProps<typeof ThrottledColorInput>>) {
    const onChange = vi.fn();
    const utils = render(
      <ThrottledColorInput value="#ece5d3" onChange={onChange} aria-label="色" {...props} />
    );
    const trigger = utils.getByLabelText('色') as HTMLButtonElement;
    return { onChange, trigger, ...utils };
  }

  const dialog = () => document.querySelector('[role="dialog"]');

  it('ネイティブの input[type=color] を描画せず、色スウォッチのボタンを出す', () => {
    const { container, trigger } = setup();
    expect(container.querySelector('input[type="color"]')).toBeNull();
    expect(trigger.tagName).toBe('BUTTON');
    // 現在色をボタン背景に反映
    expect(trigger.style.backgroundColor).not.toBe('');
  });

  it('クリックでポップオーバーを開き、Esc/外側クリックで閉じる', () => {
    const { trigger } = setup();
    expect(dialog()).toBeNull();

    act(() => { fireEvent.click(trigger); });
    expect(dialog()).not.toBeNull();

    act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(dialog()).toBeNull();

    // 再度開いて、外側（body）クリックで閉じる
    act(() => { fireEvent.click(trigger); });
    expect(dialog()).not.toBeNull();
    act(() => { fireEvent.pointerDown(document.body); });
    expect(dialog()).toBeNull();
  });

  it('hex 手入力: 有効なら反映、無効なら反映しない（3桁も可）', () => {
    const { trigger, onChange } = setup();
    act(() => { fireEvent.click(trigger); });
    const hexInput = document.querySelector('[role="dialog"] input[type="text"]') as HTMLInputElement;
    expect(hexInput).not.toBeNull();

    act(() => { fireEvent.change(hexInput, { target: { value: '#123456' } }); });
    expect(onChange).toHaveBeenLastCalledWith('#123456');

    onChange.mockClear();
    act(() => { fireEvent.change(hexInput, { target: { value: '#12' } }); }); // 無効
    expect(onChange).not.toHaveBeenCalled();

    act(() => { fireEvent.change(hexInput, { target: { value: 'fff' } }); }); // 3桁
    expect(onChange).toHaveBeenLastCalledWith('#ffffff');
  });

  it('プリセットのクリックでその色を反映する', () => {
    const { trigger, onChange } = setup();
    act(() => { fireEvent.click(trigger); });
    const preset = document.querySelector('[aria-label="プリセット #1a1a1a"]') as HTMLButtonElement;
    expect(preset).not.toBeNull();
    act(() => { fireEvent.click(preset); });
    expect(onChange).toHaveBeenLastCalledWith('#1a1a1a');
  });

  it('彩度/明度ドラッグ後、hex表示がその色へ追従する（古い値が残らない＝ドラッグを巻き戻さない）', () => {
    const { trigger } = setup(); // value=#ece5d3（ベージュ）
    act(() => { fireEvent.click(trigger); });
    const hexInput = document.querySelector('[role="dialog"] input[type="text"]') as HTMLInputElement;
    const svArea = document.querySelector('[role="dialog"] [aria-label="彩度・明度"]') as HTMLElement;
    expect(hexInput.value).toBe('#ece5d3');

    // jsdom は getBoundingClientRect が 0 を返すのでモックしてドラッグを成立させる
    svArea.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;

    // 右上（s=1, v=1）へドラッグ。jsdom に PointerEvent が無いので、座標を持つ MouseEvent を
    // 'pointerdown' として発火する（React は type で onPointerDown に振り分け、clientX/Y を読む）。
    act(() => {
      svArea.dispatchEvent(
        new MouseEvent('pointerdown', { clientX: 100, clientY: 0, bubbles: true, cancelable: true })
      );
    });

    // 元のベージュ(h)を保ったまま s=1,v=1 にした色に、hex表示が一致する（古い値が残らない）
    const expected = hsvToHex(hexToHsv('#ece5d3').h, 1, 1);
    expect(hexInput.value).toBe(expected);
    expect(hexInput.value).not.toBe('#ece5d3');
  });

  it('disabled のときは開かない', () => {
    const { trigger } = setup({ disabled: true });
    act(() => { fireEvent.click(trigger); });
    expect(dialog()).toBeNull();
  });
});
