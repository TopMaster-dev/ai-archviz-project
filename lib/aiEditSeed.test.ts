import { describe, it, expect } from 'vitest';
import {
  AI_EDIT_TEMPERATURE,
  ENABLE_GENERATION_SEED,
  AI_EDIT_BASE_SEED,
  SEED_OFFSET_COORDINATE,
  SEED_OFFSET_FINISH,
  SEED_OFFSET_ENHANCE,
  MAX_GENERATION_CANDIDATES,
} from './aiEditPrompt.js';

/**
 * 【案2・260818 クライアント承認】構図・画角が変わる件への対策。
 *
 * ・温度を下げる  … 入力からの逸脱を減らす（全画面採用では逸脱がそのまま構図の変化になる）
 * ・seed を固定  … 同じ操作で同じ結果になり、「直ったか」を判定できるようにする
 *
 * どちらも「起きにくくする」対策であって保証ではない。
 * 保証が要る場合は範囲外復元（案4）が必要、という前提でこのテストは書かれている。
 */

describe('生成温度', () => {
  it('通常編集の温度が十分低い（逸脱＝構図の変化を抑える）', () => {
    // 経緯: 0.25 →（260722）0.18 →（260818）0.05
    expect(AI_EDIT_TEMPERATURE).toBeLessThanOrEqual(0.1);
    expect(AI_EDIT_TEMPERATURE).toBeGreaterThan(0);
  });
});

describe('seed の割り当て', () => {
  const bands = [
    { name: 'エリア編集', base: 0 },
    { name: 'コーディネート', base: SEED_OFFSET_COORDINATE },
    { name: '仕上げ', base: SEED_OFFSET_FINISH },
    { name: '精細化', base: SEED_OFFSET_ENHANCE },
  ];

  it('候補ごとに異なる seed になる（3枚から選ぶ意味が残る）', () => {
    const seeds = Array.from({ length: MAX_GENERATION_CANDIDATES }, (_, i) => AI_EDIT_BASE_SEED + i);
    expect(new Set(seeds).size).toBe(MAX_GENERATION_CANDIDATES);
  });

  it('パス同士の seed 帯が衝突しない', () => {
    /*
      帯が重なると、別々のパス（生成本体・仕上げ・精細化）が同じ乱数系列を共有し、
      仕上げが生成本体と同じ癖を持つなど予期しない相関が出る。
    */
    const all: number[] = [];
    for (const b of bands) {
      for (let i = 0; i < MAX_GENERATION_CANDIDATES; i += 1) all.push(AI_EDIT_BASE_SEED + b.base + i);
    }
    expect(new Set(all).size).toBe(all.length);
  });

  it('各帯は候補数ぶん以上離れている（候補を増やしても衝突しない）', () => {
    const offsets = bands.map((b) => b.base).sort((x, y) => x - y);
    for (let i = 1; i < offsets.length; i += 1) {
      expect(offsets[i]! - offsets[i - 1]!, `${offsets[i - 1]} → ${offsets[i]}`).toBeGreaterThanOrEqual(
        MAX_GENERATION_CANDIDATES,
      );
    }
  });

  it('seed は有限の整数（モデルが拒否しうる値を作らない）', () => {
    for (const b of bands) {
      for (let i = 0; i < MAX_GENERATION_CANDIDATES; i += 1) {
        const s = AI_EDIT_BASE_SEED + b.base + i;
        expect(Number.isFinite(s), b.name).toBe(true);
        expect(Number.isInteger(s), b.name).toBe(true);
        expect(s, b.name).toBeGreaterThan(0);
      }
    }
  });

  it('フラグで従来挙動（seed を送らない）へ1行で戻せる', () => {
    expect(typeof ENABLE_GENERATION_SEED).toBe('boolean');
  });
});
