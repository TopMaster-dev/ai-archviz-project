// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { catalogChipClass, CatalogChipRow, catalogGridColumns, CATALOG_SCROLL_Y } from './CatalogChips.js';

/**
 * 260731 クライアント要望: 建材カタログと3Dモデルカタログでボタンの形が違っていたため、
 * チップの見た目を1か所に集約した。
 *
 * ここで守るのは「3つの行（建材の面カテゴリ／建材のブランド／3Dモデルのカテゴリ）が
 * 同じ形になること」。どれか1つだけ別のクラスに戻されたら気付けるようにする。
 * 2Dビューの右レールも同じ ModelCatalogRail を通るので、ここが揃えば自動的に揃う。
 */
describe('catalogChipClass', () => {
  it('形と大きさは状態にかかわらず同じ（色だけが変わる）', () => {
    const shape = ['rounded-xl', 'px-4', 'py-2.5', 'text-[10px]', 'font-black', 'uppercase'];
    for (const cls of [
      catalogChipClass({ active: false }),
      catalogChipClass({ active: true }),
      catalogChipClass({ active: false, accent: true }),
      catalogChipClass({ active: true, accent: true }),
    ]) {
      for (const s of shape) expect(cls).toContain(s);
    }
  });

  it('選択中は白、非選択は暗いグレー', () => {
    expect(catalogChipClass({ active: true })).toContain('bg-white');
    expect(catalogChipClass({ active: false })).toContain('bg-[#111]');
  });

  it('アップロード（accent）は選択中でも緑のまま', () => {
    expect(catalogChipClass({ active: true, accent: true })).toMatch(/emerald/);
    expect(catalogChipClass({ active: false, accent: true })).toMatch(/emerald/);
    // 白へ反転すると他のカテゴリと見分けが付かなくなる
    expect(catalogChipClass({ active: true, accent: true })).not.toContain('bg-white');
  });

  it('小さい丸ピル（旧・建材ブランド行の形）に戻っていない', () => {
    const cls = catalogChipClass({ active: false });
    expect(cls).not.toContain('rounded-full');
    expect(cls).not.toContain('h-7');
    expect(cls).not.toContain('text-[9px]');
  });
});

describe('CatalogChipRow', () => {
  afterEach(() => cleanup());

  it('固定チップはスクロールする側に入らない', () => {
    render(
      <CatalogChipRow testId="row" pinned={<button>アップロード</button>}>
        <button>ALL</button>
      </CatalogChipRow>,
    );
    const scroller = screen.getByTestId('row');
    expect(scroller.contains(screen.getByRole('button', { name: 'アップロード' }))).toBe(false);
    expect(scroller.contains(screen.getByRole('button', { name: 'ALL' }))).toBe(true);
  });

  it('固定チップが無ければ区切り線も出さない', () => {
    const { container } = render(
      <CatalogChipRow testId="row">
        <button>ALL</button>
      </CatalogChipRow>,
    );
    expect(container.querySelector('[aria-hidden]')).toBeNull();
  });

  it('スクロールバーを隠さない（右にまだあることが分かるように）', () => {
    render(
      <CatalogChipRow testId="row">
        <button>ALL</button>
      </CatalogChipRow>,
    );
    const scroller = screen.getByTestId('row');
    expect(scroller.className).toContain('overflow-x-auto');
    expect(scroller.className).not.toContain('no-scrollbar');
  });
});

/**
 * 260731 クライアント指摘「横スクロールを出さないでほしい」。
 *
 * 使用中パネルに横スクロールバーが出ていた。原因は2つとも「一見正しく見える」書き方:
 *  - 1列のときの `'1fr'`（= minmax(auto, 1fr)）。auto は中身の最小幅なので、
 *    `gigHy6rFTqaHfCMoKbZGfKg11IFiPsXK56bfCLGl` のような改行できない品番で列が広がる。
 *  - `overflow-y-auto` だけの指定。CSS では片方が visible 以外なら、もう片方の visible は
 *    auto に計算される＝1px あふれると横バーが出る。
 * どちらも「たまたま短い名前ばかり」だと再発に気付けないので、ここで固定する。
 */
describe('catalogGridColumns', () => {
  it('1列でも minmax(0, ...) を使う（長い品番で列が広がらない）', () => {
    expect(catalogGridColumns(1)).toBe('repeat(1, minmax(0, 1fr))');
    expect(catalogGridColumns(1)).not.toBe('1fr');
  });

  it('複数列も同じ式（列数だけが変わる）', () => {
    expect(catalogGridColumns(3)).toBe('repeat(3, minmax(0, 1fr))');
    expect(catalogGridColumns(4)).toBe('repeat(4, minmax(0, 1fr))');
  });

  it('どの列数でも最小幅は 0（＝はみ出す余地を作らない）', () => {
    for (let n = 1; n <= 6; n += 1) expect(catalogGridColumns(n)).toContain('minmax(0,');
  });

  it('0以下でも壊れた値を返さない', () => {
    expect(catalogGridColumns(0)).toBe('repeat(1, minmax(0, 1fr))');
    expect(catalogGridColumns(-3)).toBe('repeat(1, minmax(0, 1fr))');
  });
});

describe('CATALOG_SCROLL_Y', () => {
  it('横は明示的に閉じる（overflow-y だけだと横バーが出る）', () => {
    expect(CATALOG_SCROLL_Y).toContain('overflow-y-auto');
    expect(CATALOG_SCROLL_Y).toContain('overflow-x-hidden');
  });
});
