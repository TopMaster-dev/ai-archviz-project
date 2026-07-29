// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { InUsePanel, type InUseEntry } from './InUsePanel.js';

/**
 * 260730 クライアント要望②: 右サイドパネル下部に「使用中の建材 / 3Dモデル」を出す。
 * 高さはドラッグで変更でき、サムネイルの大きさはカタログ側のスライダーに追従し、
 * 収まらない分はパネル内でスクロールする。
 */

const KEY = 'test.in-use.v1';

function entries(n: number): InUseEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `k${i}`,
    label: `品目${i}`,
    sub: `メーカー${i}`,
    thumbnail: <span data-testid="thumb">{`品目${i}`}</span>,
  }));
}

function setup(overrides: Partial<React.ComponentProps<typeof InUsePanel>> = {}) {
  return render(
    <InUsePanel
      title="使用中の建材"
      entries={entries(3)}
      columns={3}
      storageKey={KEY}
      emptyMessage="適用された建材はありません"
      {...overrides}
    />,
  );
}

const panel = () => screen.getByTestId('in-use-panel');
const grip = () => screen.getByTestId('in-use-resize');
const grid = () => screen.getByTestId('in-use-grid');

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

describe('表示', () => {
  it('見出しと件数を出す', () => {
    setup({ entries: entries(5) });
    expect(screen.getByText('使用中の建材')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('何も使っていないときは案内を出す（空のグリッドを残さない）', () => {
    setup({ entries: [] });
    expect(screen.getByText('適用された建材はありません')).toBeTruthy();
    expect(screen.queryByTestId('in-use-grid')).toBeNull();
  });

  it('サムネイルの列数はカタログ側と同じ値に従う', () => {
    setup({ columns: 4 });
    expect(grid().style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
    cleanup();
    setup({ columns: 1 });
    expect(grid().style.gridTemplateColumns).toBe('1fr');
  });

  it('収まらない分はパネル内でスクロールする（パネル自体は伸びない）', () => {
    setup({ entries: entries(40) });
    expect(grid().className).toContain('overflow-y-auto');
    // 件数が増えてもパネルの高さは変わらない
    expect(panel().style.height).toBe('168px');
  });

  it('名前とメーカーがホバーで分かる', () => {
    setup({ entries: entries(1) });
    expect(within(grid()).getByTitle('品目0（メーカー0）')).toBeTruthy();
  });
});

describe('高さのドラッグ変更', () => {
  it('上端を上へ引くと高くなる', () => {
    setup();
    fireEvent.mouseDown(grip(), { clientY: 500 });
    fireEvent.mouseMove(window, { clientY: 440 }); // 上へ60
    fireEvent.mouseUp(window);
    expect(panel().style.height).toBe('228px'); // 168 + 60
  });

  it('下へ引くと低くなる', () => {
    setup();
    fireEvent.mouseDown(grip(), { clientY: 500 });
    fireEvent.mouseMove(window, { clientY: 540 }); // 下へ40
    fireEvent.mouseUp(window);
    expect(panel().style.height).toBe('128px'); // 168 - 40
  });

  it('潰れるほど低くできない（見出しが読めなくなる）', () => {
    setup();
    fireEvent.mouseDown(grip(), { clientY: 500 });
    fireEvent.mouseMove(window, { clientY: 5000 });
    fireEvent.mouseUp(window);
    expect(parseInt(panel().style.height, 10)).toBeGreaterThanOrEqual(96);
  });

  it('レールを埋め尽くすほど高くできない（カタログが見えなくなる）', () => {
    setup();
    fireEvent.mouseDown(grip(), { clientY: 500 });
    fireEvent.mouseMove(window, { clientY: -5000 });
    fireEvent.mouseUp(window);
    expect(parseInt(panel().style.height, 10)).toBeLessThanOrEqual(520);
  });

  it('変えた高さは保存され、開き直しても残る', () => {
    const { unmount } = setup();
    fireEvent.mouseDown(grip(), { clientY: 500 });
    fireEvent.mouseMove(window, { clientY: 460 });
    fireEvent.mouseUp(window);
    unmount();
    setup();
    expect(panel().style.height).toBe('208px');
  });

  it('保存値が壊れていても既定へ戻るだけ', () => {
    localStorage.setItem(KEY, 'not-a-number');
    setup();
    expect(panel().style.height).toBe('168px');
  });

  it('建材と3Dモデルで高さを別々に覚える', () => {
    setup({ storageKey: 'a.v1' });
    fireEvent.mouseDown(grip(), { clientY: 500 });
    fireEvent.mouseMove(window, { clientY: 460 });
    fireEvent.mouseUp(window);
    cleanup();
    setup({ storageKey: 'b.v1' });
    expect(panel().style.height).toBe('168px'); // 別キーなので既定のまま
  });
});
