// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { LensCropFrame } from './LensCropFrame.js';
import { clampRect, rectFromPoints, type NormRect } from '../utils/cropRegion.js';

/**
 * 260729 クライアント要望「Google レンズのように枠をドラッグしてクロップ」。
 *
 * 位置とサイズは常に正規化座標（画像全体を1とする）で持つ。ここを崩すと、
 * 拡大表示やレターボックス（object-contain の余白）で枠と画像がずれる。
 * jsdom では実寸が取れないので、座標変換はテスト側で与えて枠の「振る舞い」だけを固定する。
 */

const layout = { ox: 0, oy: 0, dw: 400, dh: 300 };

/** 画面座標をそのまま 0〜1 に写す変換（400x300 の画像を想定）。 */
const toNormalized = (clientX: number, clientY: number) => ({ nx: clientX / 400, ny: clientY / 300 });

function setup(initial: NormRect = { x: 0, y: 0, w: 1, h: 1 }) {
  const onRectChange = vi.fn();
  const utils = render(
    <LensCropFrame rect={initial} onRectChange={onRectChange} imgLayout={layout} toNormalized={toNormalized} />,
  );
  return { ...utils, onRectChange };
}

const frame = () => screen.getByTestId('lens-crop-frame');
const handle = (dir: string) => {
  const el = document.querySelector(`[data-crop-handle="${dir}"]`);
  if (!el) throw new Error(`handle ${dir} not found`);
  return el as HTMLElement;
};

afterEach(() => cleanup());

describe('初期状態', () => {
  it('既定では画像全体を覆う（＝これまでの「画像全体で検索」と同じ状態から始まる）', () => {
    setup();
    const s = frame().style;
    expect(s.left).toBe('0px');
    expect(s.top).toBe('0px');
    expect(s.width).toBe('400px');
    expect(s.height).toBe('300px');
  });

  it('枠の外側を暗くする（対象を際立たせる）', () => {
    setup();
    expect(frame().style.boxShadow).toContain('9999px');
  });

  it('正規化座標が imgLayout でピクセルに変換される（レターボックスに追従する）', () => {
    const onRectChange = vi.fn();
    render(
      <LensCropFrame
        rect={{ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }}
        onRectChange={onRectChange}
        imgLayout={{ ox: 20, oy: 10, dw: 400, dh: 300 }}
        toNormalized={toNormalized}
      />,
    );
    const s = frame().style;
    expect(s.left).toBe('120px'); // 20 + 0.25*400
    expect(s.top).toBe('160px'); // 10 + 0.5*300
    expect(s.width).toBe('200px');
    expect(s.height).toBe('75px');
  });
});

describe('枠の操作', () => {
  it('右辺を引くと幅だけ変わる（左辺は動かない）', () => {
    const { onRectChange } = setup({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    fireEvent.mouseDown(handle('e'), { clientX: 240, clientY: 0 }); // 0.6
    fireEvent.mouseMove(window, { clientX: 320, clientY: 0 }); // 0.8
    fireEvent.mouseUp(window);
    const last = onRectChange.mock.calls.at(-1)?.[0] as NormRect;
    expect(last.x).toBeCloseTo(0.1);
    expect(last.w).toBeCloseTo(0.7); // 0.8 - 0.1
    expect(last.y).toBeCloseTo(0.1);
    expect(last.h).toBeCloseTo(0.5);
  });

  it('左辺を引くと左端が動き、右端は固定される', () => {
    const { onRectChange } = setup({ x: 0.4, y: 0.1, w: 0.4, h: 0.5 });
    fireEvent.mouseDown(handle('w'), { clientX: 160, clientY: 0 }); // 0.4
    fireEvent.mouseMove(window, { clientX: 80, clientY: 0 }); // 0.2
    fireEvent.mouseUp(window);
    const last = onRectChange.mock.calls.at(-1)?.[0] as NormRect;
    expect(last.x).toBeCloseTo(0.2);
    expect(last.x + last.w).toBeCloseTo(0.8); // 右端は据え置き
  });

  it('枠の内側を掴むと移動する（大きさは変わらない）', () => {
    const { onRectChange } = setup({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 });
    fireEvent.mouseDown(frame(), { clientX: 120, clientY: 90 }); // 0.3, 0.3
    fireEvent.mouseMove(window, { clientX: 160, clientY: 120 }); // 0.4, 0.4
    fireEvent.mouseUp(window);
    const last = onRectChange.mock.calls.at(-1)?.[0] as NormRect;
    expect(last.x).toBeCloseTo(0.3);
    expect(last.y).toBeCloseTo(0.3);
    expect(last.w).toBeCloseTo(0.4);
    expect(last.h).toBeCloseTo(0.4);
  });

  it('画像の外へは出せない（はみ出した範囲を送って空の切り出しにしない）', () => {
    const { onRectChange } = setup({ x: 0.6, y: 0.6, w: 0.4, h: 0.4 });
    fireEvent.mouseDown(frame(), { clientX: 320, clientY: 240 });
    fireEvent.mouseMove(window, { clientX: 2000, clientY: 2000 });
    fireEvent.mouseUp(window);
    const last = onRectChange.mock.calls.at(-1)?.[0] as NormRect;
    expect(last.x + last.w).toBeLessThanOrEqual(1.0001);
    expect(last.y + last.h).toBeLessThanOrEqual(1.0001);
  });

  it('潰れるほど小さくはできない（掴めなくなるため）', () => {
    const { onRectChange } = setup({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    fireEvent.mouseDown(handle('e'), { clientX: 240, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 0, clientY: 0 }); // 左端まで引き切る
    fireEvent.mouseUp(window);
    const last = onRectChange.mock.calls.at(-1)?.[0] as NormRect;
    expect(last.w).toBeGreaterThan(0.01);
  });

  it('拡大中（disabled）はハンドルを出さない', () => {
    render(
      <LensCropFrame
        rect={{ x: 0, y: 0, w: 1, h: 1 }}
        onRectChange={() => {}}
        imgLayout={layout}
        toNormalized={toNormalized}
        disabled
      />,
    );
    expect(document.querySelector('[data-crop-handle]')).toBeNull();
  });
});

describe('正規化矩形のユーティリティ', () => {
  it('clampRect は画像内へ収め、最小サイズを保つ', () => {
    expect(clampRect({ x: -1, y: -1, w: 0.5, h: 0.5 })).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(clampRect({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 })).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(clampRect({ x: 0, y: 0, w: 0, h: 0 }, 0.04).w).toBe(0.04);
  });

  it('rectFromPoints はドラッグの向きに依存しない', () => {
    expect(rectFromPoints(0.8, 0.8, 0.2, 0.2)).toEqual({ x: 0.2, y: 0.2, w: 0.6000000000000001, h: 0.6000000000000001 });
  });
});

/**
 * 260729 敵対レビュー（HIGH）の再発防止。
 *
 * クロップ枠は既定で画像全体を覆い、画像より手前に居る。そのためタブを移っても枠が
 * 残っていると、エリア編集のクリックが全部枠に吸われて作図できなくなる（エラーも出ない）。
 * ここでは枠が「全面を覆う位置に居る」ことと、消えれば下の要素が触れることを固定する。
 * 実際のタブ連動（activeTool 変化で畳む）は AiEditWorkspace 側の effect が担う。
 */
describe('枠は画像より手前に出る＝出したままにしてはいけない', () => {
  it('既定の枠は画像全体を覆うので、下の要素へのクリックを遮る', () => {
    const onUnder = vi.fn();
    render(
      <div style={{ position: 'relative' }}>
        <button type="button" data-testid="under" onClick={onUnder} style={{ position: 'absolute', inset: 0 }}>
          下の要素
        </button>
        <LensCropFrame
          rect={{ x: 0, y: 0, w: 1, h: 1 }}
          onRectChange={() => {}}
          imgLayout={layout}
          toNormalized={toNormalized}
        />
      </div>,
    );
    // 枠は下の要素と同じ領域に重なっている（＝出しっぱなしは操作不能を意味する）。
    const f = frame();
    expect(f.style.width).toBe('400px');
    expect(f.style.height).toBe('300px');
    // 枠自身は mousedown を受け取り、下へは渡さない。
    fireEvent.mouseDown(f, { clientX: 10, clientY: 10 });
    expect(onUnder).not.toHaveBeenCalled();
  });
});
