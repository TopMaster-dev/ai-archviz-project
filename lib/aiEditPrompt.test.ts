import { describe, it, expect } from 'vitest';
import { describeObjectPlacements, buildAiEditReferenceGuide } from './aiEditPrompt.js';
import type { AiEditObjectReference, NormalizedRect } from '../types.js';

const obj = (placements: NormalizedRect[]): AiEditObjectReference => ({
  id: 'o1',
  imageDataUrl: null,
  placements,
  memo: '',
  placementMemos: [],
});

describe('formatPlacement: 多角形も矩形(bbox)で Gemini に伝える（260702 多角形の精度低下対策）', () => {
  it('矩形マスク → 従来どおり 左/上/幅/高さ（頂点列を含まない）', () => {
    const s = describeObjectPlacements(obj([{ x: 0.2, y: 0.3, width: 0.1, height: 0.4 }]));
    expect(s).toContain('左20.0%');
    expect(s).toContain('上30.0%');
    expect(s).toContain('幅10.0%');
    expect(s).toContain('高さ40.0%');
    expect(s).not.toContain('頂点[');
  });

  it('多角形マスク → 頂点列や境界パラグラフではなく、同じ bbox 矩形句を出す', () => {
    const s = describeObjectPlacements(
      obj([
        {
          x: 0.2,
          y: 0.2,
          width: 0.3,
          height: 0.4,
          points: [
            { x: 0.2, y: 0.2 },
            { x: 0.5, y: 0.25 },
            { x: 0.4, y: 0.6 },
          ],
        },
      ])
    );
    expect(s).not.toContain('頂点[');
    expect(s).not.toContain('→');
    expect(s).not.toContain('境界そのものを線');
    // bbox = 頂点 min/max: x0.2 y0.2 w0.3 h0.4
    expect(s).toContain('左20.0%');
    expect(s).toContain('上20.0%');
    expect(s).toContain('幅30.0%');
    expect(s).toContain('高さ40.0%');
  });

  it('多角形の bbox は頂点から導出（保存済み x/width が誤っていても頂点を正とする）', () => {
    const s = describeObjectPlacements(
      obj([
        {
          x: 0,
          y: 0,
          width: 1,
          height: 1, // 誤った保存 bbox
          points: [
            { x: 0.3, y: 0.4 },
            { x: 0.6, y: 0.4 },
            { x: 0.6, y: 0.7 },
            { x: 0.3, y: 0.7 },
          ],
        },
      ])
    );
    expect(s).toContain('左30.0%');
    expect(s).toContain('上40.0%');
    expect(s).toContain('幅30.0%');
    expect(s).toContain('高さ30.0%');
  });

  it('多角形を含む編集ガイドに頂点列が現れない（境界規則は憲法に一度だけ）', () => {
    const guide = buildAiEditReferenceGuide({
      hasStyle: false,
      objects: [
        obj([
          {
            x: 0.2,
            y: 0.2,
            width: 0.3,
            height: 0.4,
            points: [
              { x: 0.2, y: 0.2 },
              { x: 0.5, y: 0.25 },
              { x: 0.4, y: 0.6 },
            ],
          },
        ]),
      ],
    });
    expect(guide).not.toContain('頂点[');
    // 境界線を描かない規則自体は憲法に存在する（一度だけ）
    expect(guide).toContain('境界線');
  });
});
