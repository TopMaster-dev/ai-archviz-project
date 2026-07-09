import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import React from 'react';
import { EyedropperOverlay } from './EyedropperOverlay.js';
import { useEyedropper } from '../lib/store/eyedropperStore.js';

describe('EyedropperOverlay', () => {
  afterEach(() => {
    cleanup();
    useEyedropper.setState({ active: false, onPick: null });
    document.body.style.cursor = '';
  });

  it('非アクティブ時は何も表示しない', () => {
    render(<EyedropperOverlay />);
    expect(document.body.textContent).not.toContain('スポイト');
  });

  it('アクティブ時はヒントを表示し、Esc で中止する', () => {
    render(<EyedropperOverlay />);
    act(() => { useEyedropper.getState().start(() => {}); });
    expect(document.body.textContent).toContain('スポイト');

    act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(useEyedropper.getState().active).toBe(false);
  });

  it('canvas/img 以外（色を読めない場所）をクリックすると、click まで飲み込んでから中止する', () => {
    const cb = () => { throw new Error('pick してはいけない'); };
    render(<EyedropperOverlay />);
    act(() => { useEyedropper.getState().start(cb); });
    // jsdom は elementFromPoint が null → 対象外。pointerdown 単体ではまだ終了しない…
    act(() => { fireEvent.pointerDown(document.body, { clientX: 5, clientY: 5 }); });
    expect(useEyedropper.getState().active).toBe(true);
    // …末尾の click で中止（pick は呼ばれない）。
    act(() => { fireEvent.click(document.body, { clientX: 5, clientY: 5 }); });
    expect(useEyedropper.getState().active).toBe(false);
  });

  it('サンプリング中の click は capture で飲み込み、下（3D等）へ伝播させない', () => {
    render(<EyedropperOverlay />);
    act(() => { useEyedropper.getState().start(() => {}); });
    // 下位のハンドラが呼ばれない（＝ stopPropagation されている）ことを確認
    let leaked = false;
    const onBubbleClick = () => { leaked = true; };
    document.body.addEventListener('click', onBubbleClick);
    try {
      const evt = new MouseEvent('click', { clientX: 5, clientY: 5, bubbles: true, cancelable: true });
      act(() => { document.body.dispatchEvent(evt); });
      expect(leaked).toBe(false); // capture の window リスナが stopImmediatePropagation で止める
      expect(evt.defaultPrevented).toBe(true);
    } finally {
      document.body.removeEventListener('click', onBubbleClick);
    }
  });

  it('アンマウント時にサンプリング中でも解除される（ホームに戻る等）', () => {
    const { unmount } = render(<EyedropperOverlay />);
    act(() => { useEyedropper.getState().start(() => {}); });
    expect(useEyedropper.getState().active).toBe(true);
    act(() => { unmount(); });
    expect(useEyedropper.getState().active).toBe(false);
  });
});
