// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { InUsePanel, RAIL_BG, maxHeightFor } from './InUsePanel.js';

/**
 * 260730 クライアント要望②: 右サイドパネル下部に「使用中の建材 / 3Dモデル」を出す。
 * 高さはドラッグで変更でき、サムネイルの大きさはカタログ側のスライダーに追従し、
 * 収まらない分はパネル内でスクロールする。
 */

const KEY = 'test.in-use.v1';

/** カタログと同じカードを渡す想定なので、テストでも「子要素をそのまま並べる」形にする。 */
function cards(n: number) {
  return Array.from({ length: n }, (_, i) => (
    <button key={i} data-testid="card" title={`品目${i}（メーカー${i}）`}>
      {`品目${i}`}
    </button>
  ));
}

function setup(overrides: Partial<React.ComponentProps<typeof InUsePanel>> = {}) {
  return render(
    <InUsePanel
      title="使用中の建材"
      count={3}
      columns={3}
      storageKey={KEY}
      emptyMessage="適用された建材はありません"
      {...overrides}
    >
      {cards((overrides.count as number) ?? 3)}
    </InUsePanel>,
  );
}

const panel = () => screen.getByTestId('in-use-panel');
const grip = () => screen.getByTestId('in-use-resize');
const grid = () => screen.getByTestId('in-use-grid');

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

describe('表示', () => {
  it('見出しと件数を出す', () => {
    setup({ count: 5 });
    expect(screen.getByText('使用中の建材')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('何も使っていないときは案内を出す（空のグリッドを残さない）', () => {
    setup({ count: 0 });
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
    setup({ count: 40 });
    expect(grid().className).toContain('overflow-y-auto');
    // 件数が増えてもパネルの高さは変わらない
    expect(panel().style.height).toBe('168px');
  });

  it('名前とメーカーがホバーで分かる', () => {
    setup({ count: 1 });
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

/**
 * 260731 クライアント要望①「カタログとの境目が分かりづらいので、使用中パネルの背景色を変えてほしい」。
 *
 * レールの地色（RAIL_BG）と同じ・ほぼ同じに戻されたら、この指摘がそのまま再発する。
 * 「見た目の調整」は次の改修で無意識に巻き戻りやすいので、明度差を数値で固定する。
 */
describe('カタログとの見分け（背景色）', () => {
  /** '#rrggbb' / 'rgb(r, g, b)' から明度（0-255）を出す。 */
  const luminance = (color: string): number => {
    const hex = color.match(/^#([0-9a-f]{6})$/i);
    const rgb = hex
      ? [parseInt(hex[1].slice(0, 2), 16), parseInt(hex[1].slice(2, 4), 16), parseInt(hex[1].slice(4, 6), 16)]
      : (color.match(/\d+/g) ?? []).slice(0, 3).map(Number);
    if (rgb.length < 3) throw new Error(`色を解釈できない: ${color}`);
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  };

  it('レールの地色をそのまま使っていない', () => {
    setup();
    const bg = panel().style.backgroundColor;
    expect(bg).toBeTruthy();
    expect(luminance(bg)).not.toBeCloseTo(luminance(RAIL_BG), 1);
  });

  it('カタログより明るい（下の枠が沈んで見えない）', () => {
    setup();
    expect(luminance(panel().style.backgroundColor)).toBeGreaterThan(luminance(RAIL_BG) + 5);
  });

  it('上境界も色を付けて区切る（色差だけに頼らない）', () => {
    setup();
    expect(panel().className).toMatch(/border-t/);
    expect(panel().className).toMatch(/emerald/);
  });

  it('明るくしすぎない（サムネイルより背景が目立たない）', () => {
    setup();
    expect(luminance(panel().style.backgroundColor)).toBeLessThan(60);
  });
});

/**
 * 260731 敵対レビュー: 使用中パネルを広げすぎると、カタログの一覧が 0px まで潰れる。
 *
 * 上部（カテゴリ等）は shrink-0 で縮まないため、潰れた分が下の枠へはみ出す。
 * さらに高さは端末をまたいで復元されるので、大きな画面で広げた値のまま
 * ノートPCで開くと「初回表示から壊れている」状態になる。画面高でも頭打ちにする。
 */
describe('画面の高さに対する上限', () => {
  it('縦の短い端末では 520px まで広げられない', () => {
    expect(maxHeightFor(768)).toBeLessThan(520);
    expect(maxHeightFor(768)).toBe(Math.round(768 * 0.45));
  });

  it('大きな画面では従来どおり 520px が上限', () => {
    expect(maxHeightFor(1440)).toBe(520);
  });

  it('極端に低い画面でも下限（見出しが読める高さ）は守る', () => {
    expect(maxHeightFor(200)).toBeGreaterThanOrEqual(96);
  });

  it('画面高が取れない環境では従来の上限を使う（SSR・テスト）', () => {
    expect(maxHeightFor(undefined)).toBe(520);
    expect(maxHeightFor(NaN)).toBe(520);
  });

  it('カタログ側に必ず余地を残す（画面の半分を超えない）', () => {
    for (const h of [400, 600, 768, 900, 1080, 1440]) {
      expect(maxHeightFor(h)).toBeLessThanOrEqual(h / 2);
    }
  });

  it('大画面で保存した高さは、低い画面で開くと詰められる', () => {
    localStorage.setItem(KEY, '520'); // 大画面で目一杯広げた状態
    setup(); // jsdom の innerHeight は 768
    expect(parseInt(panel().style.height, 10)).toBeLessThanOrEqual(maxHeightFor(768));
  });
});
