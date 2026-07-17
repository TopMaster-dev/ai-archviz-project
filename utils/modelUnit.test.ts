import { describe, it, expect } from 'vitest';
import {
  normalizeModelUnit,
  isExplicitModelUnit,
  unitGeometryScale,
  sanitizeGeometryScale,
  type ModelUnit
} from './modelUnit.js';

describe('modelUnit', () => {
  describe('normalizeModelUnit', () => {
    it('通す: 既知の単位', () => {
      (['auto', 'mm', 'cm', 'm', 'inch', 'feet'] as ModelUnit[]).forEach((u) => {
        expect(normalizeModelUnit(u)).toBe(u);
      });
    });
    it('未知/未設定は auto', () => {
      expect(normalizeModelUnit(undefined)).toBe('auto');
      expect(normalizeModelUnit(null)).toBe('auto');
      expect(normalizeModelUnit('km')).toBe('auto');
      expect(normalizeModelUnit(123)).toBe('auto');
    });
  });

  describe('isExplicitModelUnit', () => {
    it('auto は明示単位でない', () => {
      expect(isExplicitModelUnit('auto')).toBe(false);
      expect(isExplicitModelUnit('mm')).toBe(true);
      expect(isExplicitModelUnit('feet')).toBe(true);
      expect(isExplicitModelUnit('xyz')).toBe(false);
    });
  });

  describe('unitGeometryScale (幾何プリスケール f_U)', () => {
    it('auto は null（既定挙動）', () => {
      expect(unitGeometryScale('auto')).toBeNull();
    });
    it('各単位のメートル係数を返す', () => {
      expect(unitGeometryScale('mm')).toBeCloseTo(0.001, 12);
      expect(unitGeometryScale('cm')).toBeCloseTo(0.01, 12);
      expect(unitGeometryScale('m')).toBeCloseTo(1, 12);
      expect(unitGeometryScale('inch')).toBeCloseTo(0.0254, 12);
      expect(unitGeometryScale('feet')).toBeCloseTo(0.3048, 12);
    });
    it('実寸整合: rawNative(units) × f_U = 実寸(m)', () => {
      // 800mm authored as 800 units（glTF-in-mm）を mm 指定 → 800 × 0.001 = 0.8m = 800mm
      const fU = unitGeometryScale('mm')!;
      expect(800 * fU).toBeCloseTo(0.8, 12);
      // 50cm authored as 50 units（FBX-in-cm）を cm 指定 → 50 × 0.01 = 0.5m
      const fCm = unitGeometryScale('cm')!;
      expect(50 * fCm).toBeCloseTo(0.5, 12);
    });
  });

  describe('sanitizeGeometryScale', () => {
    it('有限かつ正のみ採用、それ以外は null', () => {
      expect(sanitizeGeometryScale(0.001)).toBeCloseTo(0.001, 12);
      expect(sanitizeGeometryScale(1)).toBe(1);
      expect(sanitizeGeometryScale(0)).toBeNull();
      expect(sanitizeGeometryScale(-1)).toBeNull();
      expect(sanitizeGeometryScale(NaN)).toBeNull();
      expect(sanitizeGeometryScale(null)).toBeNull();
      expect(sanitizeGeometryScale(undefined)).toBeNull();
    });
  });
});
