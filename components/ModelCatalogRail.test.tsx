// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { ModelCatalogRail, ALL_CATEGORY, UPLOAD_CATEGORY, type FurnitureCatalogRailItem } from './ModelCatalogRail.js';

/**
 * 260730 クライアント要望②: 3Dモデルカタログを右サイドパネルへ移し、建材カタログと見た目・操作を揃える。
 * 旧「3Dオブジェクト」パネル（画面下の横長パネル）で担保していた挙動を、こちらへ引き継いで固定する。
 */

const items: FurnitureCatalogRailItem[] = [
  { id: 'c1', name: 'チェアA', type: 'チェア', url: 'https://x/1.glb' } as FurnitureCatalogRailItem,
  { id: 'c2', name: 'チェアB', type: 'チェア', url: 'https://x/2.glb' } as FurnitureCatalogRailItem,
  { id: 's1', name: 'ソファA', type: 'ソファ', url: 'https://x/3.glb' } as FurnitureCatalogRailItem,
  { id: 'u1', name: '自作モデル', type: UPLOAD_CATEGORY, url: 'https://x/4.glb' } as FurnitureCatalogRailItem,
];
const categories = [ALL_CATEGORY, 'チェア', 'ソファ', UPLOAD_CATEGORY];

// 建材カタログと同じ対応表（App.tsx の CATALOG_SLIDER_TO_GRID / CATALOG_GRID_TO_SLIDER）。
const SLIDER_TO_GRID: Record<number, number> = { 1: 4, 2: 1, 3: 2, 4: 3 };
const GRID_TO_SLIDER: Record<number, number> = { 4: 1, 1: 2, 2: 3, 3: 4 };

function setup(overrides: Partial<React.ComponentProps<typeof ModelCatalogRail>> = {}) {
  const onSelectCategory = vi.fn();
  const onPickItem = vi.fn();
  const onUploadModel = vi.fn();
  const onGridSizeChange = vi.fn();
  const utils = render(
    <ModelCatalogRail
      items={items}
      categories={categories}
      selectedCategory={ALL_CATEGORY}
      onSelectCategory={onSelectCategory}
      gridSize={1}
      onGridSizeChange={onGridSizeChange}
      sliderToGrid={SLIDER_TO_GRID}
      gridToSlider={GRID_TO_SLIDER}
      onPickItem={onPickItem}
      renderThumbnail={(item) => <span data-testid="thumb">{item.name}</span>}
      fetchStatus="ready"
      onUploadModel={onUploadModel}
      {...overrides}
    />,
  );
  return { ...utils, onSelectCategory, onPickItem, onUploadModel, onGridSizeChange };
}

const grid = () => screen.getByTestId('model-catalog-grid');

afterEach(() => cleanup());

describe('カテゴリ', () => {
  it('ALL は全件（アップロード分も含む）を出す', () => {
    setup({ selectedCategory: ALL_CATEGORY });
    for (const n of ['チェアA', 'チェアB', 'ソファA', '自作モデル']) {
      expect(within(grid()).getByText(n)).toBeTruthy();
    }
  });

  it('個別カテゴリはそのカテゴリだけに絞る', () => {
    setup({ selectedCategory: 'チェア' });
    expect(within(grid()).getByText('チェアA')).toBeTruthy();
    expect(within(grid()).queryByText('ソファA')).toBeNull();
  });

  it('選択中のカテゴリが常にハイライトされる（閉じても消えない＝レールでは常時表示）', () => {
    setup({ selectedCategory: 'ソファ' });
    expect(screen.getByRole('button', { name: 'ソファ' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: ALL_CATEGORY }).getAttribute('aria-pressed')).toBe('false');
  });

  it('カテゴリを押すと通知する', () => {
    const { onSelectCategory } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'ソファ' }));
    expect(onSelectCategory).toHaveBeenCalledWith('ソファ');
  });
});

describe('「＋」タイル', () => {
  it('アップロードを選ぶと一覧の先頭に出る', () => {
    const { onUploadModel } = setup({ selectedCategory: UPLOAD_CATEGORY });
    const plus = within(grid()).getByTitle(/3Dモデルを追加/);
    expect(grid().firstElementChild).toBe(plus);
    fireEvent.click(plus);
    expect(onUploadModel).toHaveBeenCalledTimes(1);
  });

  it('ALL では出さない（追加口はアップロードタブに限る）', () => {
    setup({ selectedCategory: ALL_CATEGORY });
    expect(screen.queryByTitle(/3Dモデルを追加/)).toBeNull();
  });

  it('onUploadModel が無ければ出さない（押せない口を作らない）', () => {
    setup({ selectedCategory: UPLOAD_CATEGORY, onUploadModel: undefined });
    expect(screen.queryByTitle(/3Dモデルを追加/)).toBeNull();
  });
});

describe('サムネイルサイズ（建材カタログと同じ操作）', () => {
  const slider = () => screen.getByLabelText('サムネイルの大きさ') as HTMLInputElement;

  it('列数は建材カタログと同じ式（5 - gridSize）で決まる', () => {
    // 建材側は Math.max(1, 5 - catalogGridSize)。state を共有している以上、
    // 式が違うと同じスライダー位置で2つのタブの見た目が食い違う。
    setup({ gridSize: 1 });
    expect(grid().style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
    cleanup();
    setup({ gridSize: 3 });
    expect(grid().style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
    cleanup();
    setup({ gridSize: 4 }); // 最大＝1列（リスト相当）
    expect(grid().style.gridTemplateColumns).toBe('1fr');
  });

  it('スライダーを右へ動かすほど列が減る（＝1枚が大きくなる）', () => {
    // 「4→1→2→3」のように飛ぶ並びになっていないこと。
    const cols: string[] = [];
    for (const gridSize of [1, 2, 3, 4]) {
      setup({ gridSize });
      cols.push(grid().style.gridTemplateColumns);
      cleanup();
    }
    expect(cols).toEqual([
      'repeat(4, minmax(0, 1fr))',
      'repeat(3, minmax(0, 1fr))',
      'repeat(2, minmax(0, 1fr))',
      '1fr',
    ]);
  });

  it('スライダーを動かすと親へ通知する（状態は建材カタログと共有）', () => {
    const { onGridSizeChange } = setup({ gridSize: 1 });
    fireEvent.change(slider(), { target: { value: '1' } });
    expect(onGridSizeChange).toHaveBeenCalledWith(SLIDER_TO_GRID[1]);
  });
});

describe('読み込み状態', () => {
  it('読み込み中はプレースホルダを出す', () => {
    setup({ fetchStatus: 'loading' });
    expect(screen.queryByTestId('model-catalog-grid')).toBeNull();
  });

  it('失敗時はメッセージを出す', () => {
    setup({ fetchStatus: 'error', fetchErrorMessage: 'ネットワークエラー' });
    expect(screen.getByText(/読み込みに失敗/)).toBeTruthy();
    expect(screen.getByText('ネットワークエラー')).toBeTruthy();
  });

  it('該当が無いカテゴリでは空の案内を出す', () => {
    setup({ selectedCategory: 'テーブル' });
    expect(screen.getByText(/3Dモデルがありません/)).toBeTruthy();
  });
});

describe('モデルを選ぶ', () => {
  it('タイルを押すと配置を依頼する', () => {
    const { onPickItem } = setup({ selectedCategory: 'チェア' });
    fireEvent.click(within(grid()).getByTitle('チェアA'));
    expect(onPickItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
  });
});
