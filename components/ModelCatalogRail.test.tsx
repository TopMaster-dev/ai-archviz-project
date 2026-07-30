// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { ModelCatalogRail, ALL_CATEGORY, UPLOAD_CATEGORY, type FurnitureCatalogRailItem } from './ModelCatalogRail.js';
import { CATALOG_PAD_X } from './CatalogChips.js';

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

  it('目盛りは左から 小 → 中 → 大 → 最大（260730 クライアント要望）', () => {
    // 建材カタログと同じ式（5 - gridSize）を使うと、左端だけが最大になり
    // 「最大 → 小 → 中 → 大」という並びになる（あちらは1列＝リスト行＝最小のため成立している）。
    // ここは1列＝大きなタイル1枚＝最大なので、スライダー位置から列数を決める。
    const colsBySliderPos: string[] = [];
    for (const sliderPos of [1, 2, 3, 4]) {
      setup({ gridSize: SLIDER_TO_GRID[sliderPos] });
      colsBySliderPos.push(grid().style.gridTemplateColumns);
      cleanup();
    }
    expect(colsBySliderPos).toEqual([
      'repeat(4, minmax(0, 1fr))', // 小
      'repeat(3, minmax(0, 1fr))', // 中
      'repeat(2, minmax(0, 1fr))', // 大
      'repeat(1, minmax(0, 1fr))', // 最大
    ]);
  });

  it('右へ動かすほど列は必ず減る（並びが飛ばない）', () => {
    const counts = [1, 2, 3, 4].map((sliderPos) => {
      setup({ gridSize: SLIDER_TO_GRID[sliderPos] });
      const css = grid().style.gridTemplateColumns;
      cleanup();
      return Number(css.match(/repeat\((\d+)/)?.[1]);
    });
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]).toBeLessThan(counts[i - 1] as number);
    }
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

/**
 * 260730 クライアント要望: 「アップロード」カテゴリを最も左に固定表示する。
 * カテゴリが増えて右へスクロールしても、自分がアップロードしたモデルへ常に1クリックで戻れること。
 * ＝「スクロールする側に入っていない」ことがこの機能の本体なので、そこを固定する。
 */
describe('「アップロード」カテゴリの左端固定', () => {
  const scroller = () => screen.getByTestId('category-scroller');

  it('スクロールする側には入らない（右へスクロールしても消えない）', () => {
    setup();
    const upload = screen.getByRole('button', { name: UPLOAD_CATEGORY });
    expect(scroller().contains(upload)).toBe(false);
  });

  it('他のカテゴリはスクロールする側に入る', () => {
    setup();
    for (const cat of [ALL_CATEGORY, 'チェア', 'ソファ']) {
      expect(scroller().contains(screen.getByRole('button', { name: cat }))).toBe(true);
    }
  });

  it('カテゴリ全体の中で最も左に置かれる', () => {
    setup();
    const row = scroller().parentElement as HTMLElement;
    const upload = screen.getByRole('button', { name: UPLOAD_CATEGORY });
    expect(row.firstElementChild).toBe(upload);
  });

  it('形と大きさは他のカテゴリと同じ（色だけ緑）', () => {
    setup();
    const upload = screen.getByRole('button', { name: UPLOAD_CATEGORY });
    const other = screen.getByRole('button', { name: 'チェア' });
    // 形（角丸・余白・文字）は共通、色だけが違う。
    for (const cls of ['rounded-xl', 'px-4', 'py-2.5', 'text-[10px]', 'font-black']) {
      expect(upload.className).toContain(cls);
      expect(other.className).toContain(cls);
    }
    expect(upload.className).toMatch(/emerald/);
    expect(other.className).not.toMatch(/emerald/);
  });

  it('選択中でも緑のまま（白黒に反転して他と紛れない）', () => {
    setup({ selectedCategory: UPLOAD_CATEGORY });
    const upload = screen.getByRole('button', { name: UPLOAD_CATEGORY });
    expect(upload.getAttribute('aria-pressed')).toBe('true');
    expect(upload.className).toMatch(/emerald/);
  });

  it('アップロードカテゴリが無いカタログでは固定枠を出さない', () => {
    setup({ categories: [ALL_CATEGORY, 'チェア'] });
    expect(screen.queryByRole('button', { name: UPLOAD_CATEGORY })).toBeNull();
  });

  it('押せばそのカテゴリへ切り替わる', () => {
    const { onSelectCategory } = setup();
    fireEvent.click(screen.getByRole('button', { name: UPLOAD_CATEGORY }));
    expect(onSelectCategory).toHaveBeenCalledWith(UPLOAD_CATEGORY);
  });
});

/**
 * 260731 クライアント要望②「下へスクロールしてもカテゴリボタンが隠れないよう、上部は固定表示に」。
 *
 * 上部（サイズ調整＋カテゴリ）と一覧を別の箱に分けることで実現している。
 * 誰かが一覧側の箱へ上部を戻すと、この不具合は静かに再発する（見た目は同じなので気付けない）。
 */
describe('上部の固定表示', () => {
  const header = () => screen.getByTestId('model-catalog-header');
  const scroller = () => screen.getByTestId('model-catalog-scroller');

  it('カテゴリはスクロールする箱の外にある', () => {
    setup();
    expect(scroller().contains(screen.getByTestId('category-scroller'))).toBe(false);
    expect(header().contains(screen.getByTestId('category-scroller'))).toBe(true);
  });

  it('サムネイルの大きさ調整もスクロールで消えない', () => {
    setup();
    const slider = screen.getByLabelText('サムネイルの大きさ');
    expect(scroller().contains(slider)).toBe(false);
    expect(header().contains(slider)).toBe(true);
  });

  it('一覧だけが縦スクロールする', () => {
    setup();
    expect(scroller().className).toContain('overflow-y-auto');
    expect(scroller().contains(screen.getByTestId('model-catalog-grid'))).toBe(true);
    expect(header().className).not.toContain('overflow-y-auto');
  });

  it('上部は縮まない（一覧が長くても押し潰されない）', () => {
    setup();
    expect(header().className).toContain('shrink-0');
  });

  it('上部と一覧の左右余白は同じ（境目で左端がずれない）', () => {
    setup();
    for (const cls of CATALOG_PAD_X.split(' ')) {
      expect(header().className).toContain(cls);
      expect(scroller().className).toContain(cls);
    }
  });
});

/**
 * 260731 敵対レビュー: 上部を shrink-0 にしたので、縦が足りないと一覧側だけが 0px まで潰れ、
 * 縮まない上部が下の「使用中」パネルへはみ出す。上部は前面なのでクリックまで奪う。
 * 外枠で切り落として、はみ出しが下の枠へ侵入しないようにする。
 */
describe('縦が足りないときの押し出し防止', () => {
  it('外枠が中身を切り落とす（下の枠へはみ出さない）', () => {
    const { container } = setup();
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('overflow-hidden');
    expect(root.className).toContain('min-h-0');
  });
});
