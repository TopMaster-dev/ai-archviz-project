import { describe, it, expect } from 'vitest';
import { buildAgentProjectSummary } from './agentProjectContext.js';

describe('buildAgentProjectSummary（プロジェクト文脈の要約）', () => {
  it('情報が無ければ null', () => {
    expect(buildAgentProjectSummary({})).toBeNull();
    expect(buildAgentProjectSummary({ furniture: [], materials: [] })).toBeNull();
  });

  it('部屋・家具・建材・予算をまとめる', () => {
    const s = buildAgentProjectSummary({
      floorAreaM2: 12.34,
      roomWidthM: 4.1,
      roomDepthM: 3.0,
      ceilingHeightMm: 2700,
      wallCount: 4,
      furniture: [
        { name: 'ソファ', count: 1, widthMm: 1800, depthMm: 900 },
        { name: 'チェア', count: 1 },
        { name: 'チェア', count: 1 },
      ],
      materials: [
        { surface: '床', name: 'オークフローリング' },
        { surface: '壁', name: '白クロス' },
      ],
      budgetYen: 1234000,
    });
    expect(s).toContain('約12.3㎡');
    expect(s).toContain('天井高 2700mm');
    expect(s).toContain('壁 4面');
    expect(s).toContain('ソファ×1');
    expect(s).toContain('チェア×2'); // 同名は集約
    expect(s).toContain('床=オークフローリング');
    expect(s).toContain('¥1,234,000');
  });

  it('異常な床面積は出さない', () => {
    const s = buildAgentProjectSummary({ floorAreaM2: 0, ceilingHeightMm: 2400 });
    expect(s).not.toContain('㎡');
    expect(s).toContain('天井高 2400mm');
  });
});
