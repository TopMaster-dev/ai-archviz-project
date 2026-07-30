// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MaterialCard } from './MaterialCard.js';
import type { Product } from '../types.js';

/**
 * 260731 クライアント指摘「横スクロールを出さないでほしい」。
 *
 * 建材名は品番そのままのことがあり、`gigHy6rFTqaHfCMoKbZGfKg11IFiPsXK56bfCLGl` のように
 * 途中で改行できない。この手の名前が1件でも混ざると、カードが親からはみ出して
 * 使用中パネル・カタログに横スクロールバーが出る。
 *
 * 守るべきは「カードは親より広くならない」こと。CSS の実寸は jsdom で測れないので、
 * それを成立させている指定（min-w-0 と truncate）が消えていないことを固定する。
 */

/** 実際に横スクロールを起こしていた名前。 */
const LONG_NAME = 'gigHy6rFTqaHfCMoKbZGfKg11IFiPsXK56bfCLGl_AC_UF1000_1000_QL80_';

const product = (name = LONG_NAME): Product =>
  ({
    id: 'p1',
    name,
    brand: 'SANGETSU',
    pricePerUnit: 3100,
    textureUrl: 'https://x/t.jpg',
  }) as Product;

function setup(columns: number, name?: string) {
  const onSelect = vi.fn();
  render(
    <MaterialCard
      product={product(name)}
      columns={columns}
      selected={false}
      disabled={false}
      onSelect={onSelect}
      thumbnailUrl="https://x/thumb.jpg"
    />,
  );
  return { onSelect, card: screen.getByRole('button') };
}

afterEach(() => cleanup());

describe('リスト表示（1列）', () => {
  it('親より広がらない（グリッドの子は既定 min-width:auto ＝中身の最小幅）', () => {
    const { card } = setup(1);
    expect(card.className).toContain('min-w-0');
  });

  it('名前は省略表示（改行できない品番でも押し広げない）', () => {
    setup(1);
    expect(screen.getByText(LONG_NAME).className).toContain('truncate');
  });

  it('メーカー名も省略表示（こちらだけ長いこともある）', () => {
    setup(1);
    expect(screen.getByText('SANGETSU').className).toContain('truncate');
  });

  it('省略の前提になる min-w-0 が中の列にも付いている', () => {
    const { card } = setup(1);
    const textCol = screen.getByText(LONG_NAME).parentElement as HTMLElement;
    expect(textCol.className).toContain('min-w-0');
    expect(card.contains(textCol)).toBe(true);
  });

  it('サムネイルと価格は縮まない（潰れて読めなくならない）', () => {
    const { card } = setup(1);
    expect((card.querySelector('img') as HTMLElement).className).toContain('shrink-0');
    expect(screen.getByText('¥3,100').className).toContain('shrink-0');
  });

  it('全文はホバーで読める（省略しても情報は失わない）', () => {
    const { card } = setup(1);
    expect(card.getAttribute('title')).toBe(LONG_NAME);
  });
});

describe('タイル表示（2列以上）', () => {
  it('親より広がらない', () => {
    const { card } = setup(3);
    expect(card.className).toContain('min-w-0');
  });

  it('名前は2行までで打ち切る（タイルの高さを崩さない）', () => {
    setup(3);
    expect(screen.getByText(LONG_NAME).className).toContain('line-clamp-2');
  });

  it('はみ出しはタイル内で隠す', () => {
    const { card } = setup(3);
    expect(card.className).toContain('overflow-hidden');
  });
});

describe('表示の中身', () => {
  it('価格は3桁区切り', () => {
    setup(1, '床材A');
    expect(screen.getByText('¥3,100')).toBeTruthy();
  });

  it('短い名前でも同じ作り（長さで分岐しない）', () => {
    const { card } = setup(1, '床材A');
    expect(card.className).toContain('min-w-0');
    expect(screen.getByText('床材A').className).toContain('truncate');
  });
});
