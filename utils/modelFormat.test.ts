import { describe, it, expect } from 'vitest';
import { modelFormatOf, exoticNormalizeScale } from './modelFormat.js';

describe('modelFormatOf', () => {
  it('detects the format from a plain path extension', () => {
    expect(modelFormatOf('/models/chair.glb')).toBe('glb');
    expect(modelFormatOf('https://example.com/a/b/scene.gltf')).toBe('gltf');
    expect(modelFormatOf('https://cdn/x/sofa.fbx')).toBe('fbx');
    expect(modelFormatOf('https://cdn/x/table.obj')).toBe('obj');
  });

  it('is case-insensitive', () => {
    expect(modelFormatOf('CHAIR.GLB')).toBe('glb');
    expect(modelFormatOf('Scene.FBX')).toBe('fbx');
  });

  it('ignores query strings and fragments on real URLs', () => {
    expect(modelFormatOf('https://res.cloudinary.com/x/upload/v1/chair.glb?w=100')).toBe('glb');
    expect(modelFormatOf('https://host/model.obj#section')).toBe('obj');
  });

  it('uses the fragment hint for extension-less blob: URLs', () => {
    expect(modelFormatOf('blob:http://localhost:5173/uuid-1234#fbx')).toBe('fbx');
    expect(modelFormatOf('blob:http://localhost:5173/uuid-1234#.obj')).toBe('obj');
    expect(modelFormatOf('blob:http://localhost:5173/uuid-1234#glb')).toBe('glb');
  });

  it('returns null for unknown or missing extensions', () => {
    expect(modelFormatOf('https://host/model.stl')).toBeNull();
    expect(modelFormatOf('blob:http://localhost/uuid-no-hint')).toBeNull();
    expect(modelFormatOf('noextension')).toBeNull();
    expect(modelFormatOf('')).toBeNull();
    expect(modelFormatOf(null)).toBeNull();
    expect(modelFormatOf(undefined)).toBeNull();
  });
});

describe('exoticNormalizeScale', () => {
  it('leaves furniture-sized models (0.05m..4m) unscaled', () => {
    expect(exoticNormalizeScale(0.5)).toBe(1);
    expect(exoticNormalizeScale(2)).toBe(1);
    expect(exoticNormalizeScale(4)).toBe(1);
    expect(exoticNormalizeScale(0.05)).toBe(1);
  });

  it('shrinks oversized models (e.g. cm-authored FBX ~62m) into range', () => {
    // 62m -> max dim 4m
    expect(62 * exoticNormalizeScale(62)).toBeCloseTo(4, 6);
    // a 2m chair authored in cm = 200 units -> ~2m after scaling
    expect(200 * exoticNormalizeScale(200)).toBeCloseTo(4, 6);
  });

  it('enlarges tiny models below the min', () => {
    expect(0.01 * exoticNormalizeScale(0.01)).toBeCloseTo(0.05, 6);
  });

  it('is safe for non-finite / non-positive input', () => {
    expect(exoticNormalizeScale(0)).toBe(1);
    expect(exoticNormalizeScale(-3)).toBe(1);
    expect(exoticNormalizeScale(Number.NaN)).toBe(1);
    expect(exoticNormalizeScale(Number.POSITIVE_INFINITY)).toBe(1);
  });
});
