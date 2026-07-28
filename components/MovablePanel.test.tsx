// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MovablePanel } from './MovablePanel.js';

/**
 * 260729 クライアント要望①「枠をドラッグして縦横のサイズを変えられるように」。
 *
 * ここで守りたいのは主に2点:
 *  ①拡大率(± 100%)と実サイズ変更が併存しても破綻しないこと。
 *   パネルは transform: scale で拡大されているので、ポインタの移動量（画面px）を
 *   そのまま幅に足すと倍率ぶんズレる。倍率で割っていることを固定する。
 *  ②既存ユーザーの保存データ（x/y/scale のみ）を読んでも位置を失わないこと。
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}

const KEY = 'test.panel.v1';

/** 中身の実測サイズを固定する（jsdom は常に 0 を返すため）。 */
function stubContentRect(w: number, h: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
}

function setup(props: Partial<React.ComponentProps<typeof MovablePanel>> = {}) {
  return render(
    <MovablePanel storageKey={KEY} label="テスト" {...props}>
      <div data-testid="body">中身</div>
    </MovablePanel>,
  );
}

/** 指定方向のリサイズハンドル（辺・角）。 */
function handle(dir: string): HTMLElement {
  const el = document.querySelector(`[data-resize-dir="${dir}"]`);
  if (!el) throw new Error(`handle ${dir} not found`);
  return el as HTMLElement;
}

function contentEl(): HTMLElement {
  return screen.getByTestId('body').parentElement as HTMLElement;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('保存データの後方互換', () => {
  it('旧形式（x/y/scale のみ）でも位置・倍率を読み込む', () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 120, y: 60, scale: 1.2 }));
    setup();
    const root = screen.getByTestId('body').closest('.fixed') as HTMLElement;
    expect(root.style.left).toBe('120px');
    expect(root.style.top).toBe('60px');
    expect(root.style.transform).toBe('scale(1.2)');
    expect(screen.getByText('120%')).toBeTruthy();
  });

  it('壊れた保存データは既定へ（例外にしない）', () => {
    localStorage.setItem(KEY, '{{{');
    expect(() => setup()).not.toThrow();
  });

  it('保存された明示サイズを復元する', () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 0, y: 0, scale: 1, w: 480, h: 300 }));
    setup();
    expect(contentEl().style.width).toBe('480px');
    expect(contentEl().style.height).toBe('300px');
  });

  it('負のサイズは無視して自動サイズへ（壊れた値で潰れたパネルにしない）', () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 0, y: 0, scale: 1, w: -10, h: -10 }));
    setup();
    expect(contentEl().style.width).toBe('');
  });
});

describe('枠ドラッグによるリサイズ', () => {
  it('右辺を引くと幅が増える（高さは変えない）', () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 0, y: 0, scale: 1 }));
    stubContentRect(300, 200);
    setup({ minWidth: 100, minHeight: 100 });

    fireEvent.mouseDown(handle('e'), { clientX: 300, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 380, clientY: 0 });
    fireEvent.mouseUp(window);

    expect(contentEl().style.width).toBe('380px'); // 300 + 80
    expect(contentEl().style.height).toBe('200px'); // 縦は不変
  });

  it('下辺を引くと高さが増える', () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 0, y: 0, scale: 1 }));
    stubContentRect(300, 200);
    setup({ minWidth: 100, minHeight: 100 });

    fireEvent.mouseDown(handle('s'), { clientX: 0, clientY: 200 });
    fireEvent.mouseMove(window, { clientX: 0, clientY: 260 });
    fireEvent.mouseUp(window);

    expect(contentEl().style.height).toBe('260px');
  });

  it('【要】倍率が効いていても、掴んだ枠がカーソルに追従する（移動量を倍率で割る）', () => {
    // 200% 表示で 100px 動かしたら、レイアウト上は 50px ぶんだけ広がるのが正しい。
    // 割り忘れると 100px 広がり、画面上では 200px 動いて枠がカーソルから離れていく。
    localStorage.setItem(KEY, JSON.stringify({ x: 0, y: 0, scale: 2 }));
    stubContentRect(600, 400); // 実測は倍率込み → レイアウトは 300x200
    setup({ minWidth: 100, minHeight: 100 });

    fireEvent.mouseDown(handle('e'), { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 100, clientY: 0 });
    fireEvent.mouseUp(window);

    expect(contentEl().style.width).toBe('350px'); // 300 + 100/2
  });

  it('左辺を引くと、幅が増えたぶん左上が動いて右辺が動かない', () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 200, y: 100, scale: 1 }));
    stubContentRect(300, 200);
    setup({ minWidth: 100, minHeight: 100 });

    fireEvent.mouseDown(handle('w'), { clientX: 200, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 150, clientY: 0 }); // 左へ50
    fireEvent.mouseUp(window);

    const root = screen.getByTestId('body').closest('.fixed') as HTMLElement;
    expect(contentEl().style.width).toBe('350px'); // 300 + 50
    expect(root.style.left).toBe('150px'); // 200 - 50 ＝ 右辺は据え置き
  });

  it('下限より小さくできない。かつ下限に当たった後は左上も滑らない', () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 200, y: 0, scale: 1 }));
    stubContentRect(300, 200);
    setup({ minWidth: 250, minHeight: 100 });

    // 左辺を右へ 200 引く（300 → 100 相当だが下限 250 で止まる）
    fireEvent.mouseDown(handle('w'), { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 200, clientY: 0 });
    fireEvent.mouseUp(window);

    const root = screen.getByTestId('body').closest('.fixed') as HTMLElement;
    expect(contentEl().style.width).toBe('250px');
    // 実際に縮んだのは 50 だけ。素の移動量200を足すとパネルだけ滑って見える。
    expect(root.style.left).toBe('250px'); // 200 + (300-250)
  });

  it('リサイズしたサイズが保存される', () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 0, y: 0, scale: 1 }));
    stubContentRect(300, 200);
    setup({ minWidth: 100, minHeight: 100 });

    fireEvent.mouseDown(handle('se'), { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 40, clientY: 30 });
    fireEvent.mouseUp(window);

    const saved = JSON.parse(localStorage.getItem(KEY) as string);
    expect(saved.w).toBe(340);
    expect(saved.h).toBe(230);
  });

  it('resizable=false ならハンドルを出さない', () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 0, y: 0, scale: 1 }));
    setup({ resizable: false });
    expect(document.querySelector('[data-resize-dir]')).toBeNull();
  });
});

/**
 * 260729 敵対レビューで見つかった不具合の再発防止。
 * とくに「北/西の枠を引くとパネルが領域外へ歩いていき、グリップが画面外に出て
 * 移動も初期化もできなくなる（しかもその位置が保存される）」は復帰手段が無く致命的だった。
 */
describe('リサイズしても領域の外へ出さない', () => {
  const bounds = () => ({ left: 100, top: 100, right: 900, bottom: 700 });

  it('北の枠を上へ引いても、掴むためのグリップ（＝パネル上端）が領域より上へ出ない', () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 300, y: 120, scale: 1 }));
    stubContentRect(300, 200);
    setup({ getBounds: bounds, minWidth: 100, minHeight: 100 });

    fireEvent.mouseDown(handle('n'), { clientX: 0, clientY: 120 });
    fireEvent.mouseMove(window, { clientX: 0, clientY: -5000 }); // 画面外まで思い切り引く
    fireEvent.mouseUp(window);

    const root = screen.getByTestId('body').closest('.fixed') as HTMLElement;
    expect(parseFloat(root.style.top)).toBeGreaterThanOrEqual(100); // b.top より上へ行かない
    // 上端で止まったぶん、高さは「元の高さ＋動けた距離」で頭打ちになる
    expect(contentEl().style.height).toBe('220px'); // 200 + (120-100)
  });

  it('西の枠を左へ引いても、左端が領域より外へ出ない', () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 150, y: 300, scale: 1 }));
    stubContentRect(300, 200);
    setup({ getBounds: bounds, minWidth: 100, minHeight: 100 });

    fireEvent.mouseDown(handle('w'), { clientX: 150, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: -5000, clientY: 0 });
    fireEvent.mouseUp(window);

    const root = screen.getByTestId('body').closest('.fixed') as HTMLElement;
    expect(parseFloat(root.style.left)).toBeGreaterThanOrEqual(100);
    expect(contentEl().style.width).toBe('350px'); // 300 + (150-100)
  });

  it('東の枠を右へ引いても、右端が領域より外へ出ない', () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 700, y: 300, scale: 1 }));
    stubContentRect(150, 200);
    setup({ getBounds: bounds, minWidth: 100, minHeight: 100 });

    fireEvent.mouseDown(handle('e'), { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 5000, clientY: 0 });
    fireEvent.mouseUp(window);

    expect(contentEl().style.width).toBe('200px'); // b.right(900) - x(700)
  });

  it('掴んでいない軸には触らない（辺を引いただけで反対の軸が下限へ縮まない）', () => {
    // minHeight を自然サイズより大きくしておく。両軸を毎回クランプしていると、
    // 右辺を引いただけで高さが 400 へスナップしてパネルの形が勝手に変わる。
    localStorage.setItem(KEY, JSON.stringify({ x: 200, y: 200, scale: 1 }));
    stubContentRect(300, 200);
    setup({ getBounds: bounds, minWidth: 100, minHeight: 400 });

    fireEvent.mouseDown(handle('e'), { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 30, clientY: 0 });
    fireEvent.mouseUp(window);

    expect(contentEl().style.width).toBe('330px');
    expect(contentEl().style.height).toBe('200px'); // 元のまま
  });

  it('リサイズすると中身の高さ上限を外す印が付く（枠だけ伸びて中身が伸びない状態にしない）', () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 200, y: 200, scale: 1 }));
    stubContentRect(300, 200);
    setup({ getBounds: bounds, minWidth: 100, minHeight: 100 });

    expect(contentEl().getAttribute('data-panel-sized')).toBe('false');
    fireEvent.mouseDown(handle('s'), { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 0, clientY: 50 });
    fireEvent.mouseUp(window);
    expect(contentEl().getAttribute('data-panel-sized')).toBe('true');
  });
});

describe('拡大率とリサイズの併存', () => {
  it('± は倍率だけを変え、明示サイズには触れない', () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 0, y: 0, scale: 1, w: 400, h: 300 }));
    setup();
    fireEvent.click(screen.getByLabelText('拡大'));
    expect(screen.getByText('110%')).toBeTruthy();
    expect(contentEl().style.width).toBe('400px'); // サイズは据え置き
  });

  it('初期化は倍率も明示サイズも既定へ戻す', () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 10, y: 10, scale: 1.4, w: 400, h: 300 }));
    setup();
    fireEvent.click(screen.getByLabelText('位置とサイズを初期化'));
    expect(contentEl().style.width).toBe('');
    expect(contentEl().style.height).toBe('');
    expect(screen.getByText('100%')).toBeTruthy();
  });
});
