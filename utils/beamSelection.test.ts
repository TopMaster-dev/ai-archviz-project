import { describe, it, expect } from 'vitest';
import { toggleBeamSelection } from './beamSelection.js';

describe('toggleBeamSelection (260715 #7a: 梁の複数選択トグル)', () => {
  it('adds an unselected beam and makes it primary', () => {
    const r = toggleBeamSelection([], 'b1');
    expect(r.nextBeamMeshes).toEqual(['Beam_b1']);
    expect(r.nextPrimary).toBe('b1');
  });

  it('appends a second beam, keeping the first, new one becomes primary', () => {
    const r = toggleBeamSelection(['Beam_b1'], 'b2');
    expect(r.nextBeamMeshes).toEqual(['Beam_b1', 'Beam_b2']);
    expect(r.nextPrimary).toBe('b2');
  });

  it('removes an already-selected beam and moves primary to the last remaining', () => {
    const r = toggleBeamSelection(['Beam_b1', 'Beam_b2', 'Beam_b3'], 'b2');
    expect(r.nextBeamMeshes).toEqual(['Beam_b1', 'Beam_b3']);
    expect(r.nextPrimary).toBe('b3');
  });

  it('deselecting the last selected beam yields empty set and null primary', () => {
    const r = toggleBeamSelection(['Beam_b1'], 'b1');
    expect(r.nextBeamMeshes).toEqual([]);
    expect(r.nextPrimary).toBeNull();
  });

  it('drops non-beam meshes (wall selection is exclusive from beam multi-select)', () => {
    const r = toggleBeamSelection(['Sketch_Wall_0', 'Beam_b1'], 'b2');
    expect(r.nextBeamMeshes).toEqual(['Beam_b1', 'Beam_b2']);
    expect(r.nextPrimary).toBe('b2');
  });

  it('starting from only wall meshes, toggling a beam yields just that beam', () => {
    const r = toggleBeamSelection(['Sketch_Wall_0', 'Sketch_Floor'], 'b1');
    expect(r.nextBeamMeshes).toEqual(['Beam_b1']);
    expect(r.nextPrimary).toBe('b1');
  });

  it('handles beam ids that contain underscores', () => {
    const r = toggleBeamSelection(['Beam_wall_2_a'], 'wall_2_a');
    expect(r.nextBeamMeshes).toEqual([]);
    expect(r.nextPrimary).toBeNull();
  });
});
