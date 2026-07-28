// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { FurnitureAssetStrip, ALL_CATEGORY, UPLOAD_CATEGORY, type FurnitureAssetStripItem } from './FurnitureAssetStrip.js';

/**
 * 260729 クライアント要望②③④のリグレッション。
 * このコンポーネントは今までテストが1本も無く、カタログのレイアウトは
 * 「幅から算出する calc()」「列数決め打ちの grid-cols-4」など壊れやすい箇所が多い。
 * 見た目の細部ではなく「利用者が困る挙動」だけを固定する。
 */

// jsdom は ResizeObserver を実装しない。カテゴリバーの幅計測で使っているだけなので、
// 何もしないスタブで足りる（計測結果に依存するテストはここでは書かない）。
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}

const items: FurnitureAssetStripItem[] = [
  { id: 'c1', name: 'チェアA', type: 'チェア', url: 'https://x/1.glb' } as FurnitureAssetStripItem,
  { id: 'c2', name: 'チェアB', type: 'チェア', url: 'https://x/2.glb' } as FurnitureAssetStripItem,
  { id: 's1', name: 'ソファA', type: 'ソファ', url: 'https://x/3.glb' } as FurnitureAssetStripItem,
  { id: 'u1', name: '自作モデル', type: UPLOAD_CATEGORY, url: 'https://x/4.glb' } as FurnitureAssetStripItem,
];

const categories = [ALL_CATEGORY, 'チェア', 'ソファ', UPLOAD_CATEGORY];

function setup(overrides: Partial<React.ComponentProps<typeof FurnitureAssetStrip>> = {}) {
  const onSelectedAssetCategoryChange = vi.fn();
  const onUploadModel = vi.fn();
  const onPickItem = vi.fn();
  const utils = render(
    <FurnitureAssetStrip
      processedCatalog={items}
      assetCategories={categories}
      selectedAssetCategory={null}
      onSelectedAssetCategoryChange={onSelectedAssetCategoryChange}
      onPickItem={onPickItem}
      renderThumbnail={(item) => <span data-testid="thumb">{item.name}</span>}
      fetchStatus="ready"
      onUploadModel={onUploadModel}
      {...overrides}
    />,
  );
  return { ...utils, onSelectedAssetCategoryChange, onUploadModel, onPickItem };
}

/** ポップアップのサムネイル一覧（grid）を取り出す。 */
function grid(): HTMLElement {
  const el = document.querySelector('[data-testid="asset-grid"]');
  if (!el) throw new Error('grid not found');
  return el as HTMLElement;
}

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

describe('選択中カテゴリのハイライト（要望④）', () => {
  it('パネルを閉じていても、どれかのカテゴリが必ずハイライトされる', () => {
    // 以前は selectedAssetCategory が「開いているか」も兼ねていたため、閉じると
    // どのカテゴリも光らず「今どれを見ているのか分からない」状態だった。
    setup({ selectedAssetCategory: null });
    const all = screen.getByRole('button', { name: ALL_CATEGORY });
    expect(all.getAttribute('aria-pressed')).toBe('true'); // 既定は ALL
  });

  it('開いているカテゴリがハイライトされる', () => {
    setup({ selectedAssetCategory: 'ソファ' });
    expect(screen.getByRole('button', { name: 'ソファ' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: ALL_CATEGORY }).getAttribute('aria-pressed')).toBe('false');
  });

  it('閉じた後も、最後に選んだカテゴリのハイライトが残る', () => {
    const { rerender } = setup({ selectedAssetCategory: 'ソファ' });
    // 閉じる（selectedAssetCategory=null）。ハイライトは「ソファ」に残り続けること。
    rerender(
      <FurnitureAssetStrip
        processedCatalog={items}
        assetCategories={categories}
        selectedAssetCategory={null}
        onSelectedAssetCategoryChange={() => {}}
        onPickItem={() => {}}
        renderThumbnail={(item) => <span>{item.name}</span>}
        fetchStatus="ready"
      />,
    );
    expect(screen.getByRole('button', { name: 'ソファ' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: ALL_CATEGORY }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('ALL カテゴリ（要望④）', () => {
  it('ALL は全件（アップロード分も含む）を出す', () => {
    setup({ selectedAssetCategory: ALL_CATEGORY });
    const g = grid();
    for (const name of ['チェアA', 'チェアB', 'ソファA', '自作モデル']) {
      expect(within(g).getByText(name)).toBeTruthy();
    }
  });

  it('個別カテゴリはそのカテゴリだけに絞る', () => {
    setup({ selectedAssetCategory: 'チェア' });
    const g = grid();
    expect(within(g).getByText('チェアA')).toBeTruthy();
    expect(within(g).queryByText('ソファA')).toBeNull();
  });

  it('ALL では「＋」タイルを出さない（追加口はアップロードタブに限る）', () => {
    setup({ selectedAssetCategory: ALL_CATEGORY });
    expect(screen.queryByTitle(/3Dモデルを追加/)).toBeNull();
  });
});

describe('「＋」タイル（要望③）', () => {
  it('アップロードを選ぶと一覧の先頭に「＋」タイルが出る', () => {
    const { onUploadModel } = setup({ selectedAssetCategory: UPLOAD_CATEGORY });
    const g = grid();
    const plus = within(g).getByTitle(/3Dモデルを追加/);
    expect(plus).toBeTruthy();
    // 先頭であること（DOM順がそのまま表示順）
    expect(g.firstElementChild).toBe(plus);
    fireEvent.click(plus);
    expect(onUploadModel).toHaveBeenCalledTimes(1);
  });

  it('onUploadModel が無ければ「＋」タイルは出さない（押せない口を作らない）', () => {
    setup({ selectedAssetCategory: UPLOAD_CATEGORY, onUploadModel: undefined });
    expect(screen.queryByTitle(/3Dモデルを追加/)).toBeNull();
  });
});

describe('サムネイルサイズスライダー（要望②）', () => {
  const slider = () => screen.getByLabelText(/サムネイルの大きさ/) as HTMLInputElement;

  it('既定は4列（従来と同じ見え方）', () => {
    setup({ selectedAssetCategory: 'チェア' });
    expect(grid().style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
  });

  it('右へ動かすと列が減る＝1枚が大きくなる', () => {
    setup({ selectedAssetCategory: 'チェア' });
    fireEvent.change(slider(), { target: { value: '4' } });
    expect(grid().style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
  });

  it('左へ動かすと列が増える＝1枚が小さくなる', () => {
    setup({ selectedAssetCategory: 'チェア' });
    fireEvent.change(slider(), { target: { value: '1' } });
    expect(grid().style.gridTemplateColumns).toBe('repeat(6, minmax(0, 1fr))');
  });

  it('2行ぶんの高さが列数に追従する（4列決め打ちの計算が残っていない）', () => {
    setup({ selectedAssetCategory: 'チェア' });
    const h4 = grid().style.maxHeight;
    fireEvent.change(slider(), { target: { value: '4' } });
    const h2 = grid().style.maxHeight;
    expect(h4).not.toBe(h2); // 列数が変われば2行の高さも変わる
    expect(h2).toContain('/ 2 * 2'); // 2列ぶんのセル高で計算されている
  });

  it('選んだ大きさは保存され、開き直しても残る', () => {
    const { unmount } = setup({ selectedAssetCategory: 'チェア' });
    fireEvent.change(slider(), { target: { value: '3' } });
    unmount();
    setup({ selectedAssetCategory: 'チェア' });
    expect(slider().value).toBe('3');
    expect(grid().style.gridTemplateColumns).toBe('repeat(3, minmax(0, 1fr))');
  });

  it('保存値が壊れていても既定へ戻るだけ（表示は壊れない）', () => {
    localStorage.setItem('arise.asset-strip.thumb-size.v1', 'not-a-number');
    setup({ selectedAssetCategory: 'チェア' });
    expect(grid().style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
  });
});
