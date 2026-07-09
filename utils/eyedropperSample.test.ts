import { describe, it, expect, afterEach } from 'vitest';
import { mapPointToSourcePixel, findSamplableElement, findSamplableAtPoint } from './eyedropperSample.js';

const rect = { left: 100, top: 50, width: 200, height: 100 };

describe('mapPointToSourcePixel', () => {
  it('fill: rect いっぱいに引き伸ばして線形対応', () => {
    // 中央
    expect(mapPointToSourcePixel(rect, 400, 200, 'fill', 200, 100)).toEqual({ sx: 200, sy: 100 });
    // 左上端
    expect(mapPointToSourcePixel(rect, 400, 200, 'fill', 100, 50)).toEqual({ sx: 0, sy: 0 });
    // 右下端（クランプで naturalW-1 / naturalH-1）
    expect(mapPointToSourcePixel(rect, 400, 200, 'fill', 300, 150)).toEqual({ sx: 399, sy: 199 });
  });

  it('矩形の外は null', () => {
    expect(mapPointToSourcePixel(rect, 400, 200, 'fill', 99, 100)).toBeNull();
    expect(mapPointToSourcePixel(rect, 400, 200, 'fill', 200, 49)).toBeNull();
    expect(mapPointToSourcePixel(rect, 400, 200, 'fill', 301, 100)).toBeNull();
  });

  it('contain: レターボックス余白は null、内側は正しく対応', () => {
    // 画像 100x100 を 200x100 の枠へ contain → scale=min(2,1)=1、幅100・高さ100、左右に (200-100)/2=50 の余白
    // 左側の余白（dx=25）は null
    expect(mapPointToSourcePixel(rect, 100, 100, 'contain', 100 + 25, 50 + 50)).toBeNull();
    // 中央（dx=100 → content内 cx=50）→ 元の中央
    expect(mapPointToSourcePixel(rect, 100, 100, 'contain', 100 + 100, 50 + 50)).toEqual({ sx: 50, sy: 50 });
    // content 左端（dx=50 → cx=0）
    expect(mapPointToSourcePixel(rect, 100, 100, 'contain', 100 + 50, 50 + 0)).toEqual({ sx: 0, sy: 0 });
  });

  it('cover: はみ出し分は切れて中央基準で対応', () => {
    // 画像 100x100 を 200x100 の枠へ cover → scale=max(2,1)=2、内容 200x200、縦に (100-200)/2=-50 のオフセット
    // 枠中央 (dx=100,dy=50) → cx=100, cy=100 → sx=100/200*100=50, sy=100/200*100=50
    expect(mapPointToSourcePixel(rect, 100, 100, 'cover', 100 + 100, 50 + 50)).toEqual({ sx: 50, sy: 50 });
  });

  it('none: 原寸中央配置。枠より小さい画像は周囲余白が null', () => {
    // 画像 50x50 を 200x100 枠へ none → 中央配置、offX=75, offY=25
    // 枠中央 → content 中央
    expect(mapPointToSourcePixel(rect, 50, 50, 'none', 100 + 100, 50 + 50)).toEqual({ sx: 25, sy: 25 });
    // 余白（dx=10）は null
    expect(mapPointToSourcePixel(rect, 50, 50, 'none', 100 + 10, 50 + 50)).toBeNull();
  });

  it('不正な寸法は null', () => {
    expect(mapPointToSourcePixel(rect, 0, 100, 'fill', 200, 100)).toBeNull();
    expect(mapPointToSourcePixel({ left: 0, top: 0, width: 0, height: 0 }, 100, 100, 'fill', 0, 0)).toBeNull();
  });
});

describe('findSamplableElement', () => {
  it('canvas / img のみ受理し、それ以外や null は null', () => {
    const canvas = document.createElement('canvas');
    const img = document.createElement('img');
    const div = document.createElement('div');
    expect(findSamplableElement(canvas)).toBe(canvas);
    expect(findSamplableElement(img)).toBe(img);
    expect(findSamplableElement(div)).toBeNull();
    expect(findSamplableElement(null)).toBeNull();
  });
});

describe('findSamplableAtPoint', () => {
  const orig = document.elementsFromPoint;
  afterEach(() => { (document as unknown as { elementsFromPoint: unknown }).elementsFromPoint = orig; });

  it('上に重なる非canvas要素（ツールチップ等）を飛ばして、下の canvas を拾う', () => {
    const div = document.createElement('div');
    const canvas = document.createElement('canvas');
    (document as unknown as { elementsFromPoint: unknown }).elementsFromPoint = () => [div, canvas];
    expect(findSamplableAtPoint(10, 10)).toBe(canvas);
  });

  it('スタックに canvas/img が無ければ null', () => {
    (document as unknown as { elementsFromPoint: unknown }).elementsFromPoint = () => [
      document.createElement('div'),
      document.createElement('span'),
    ];
    expect(findSamplableAtPoint(10, 10)).toBeNull();
  });
});
