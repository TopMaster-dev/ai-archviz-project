import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEyedropper } from './eyedropperStore.js';

describe('eyedropperStore', () => {
  beforeEach(() => useEyedropper.setState({ active: false, onPick: null }));

  it('start でアクティブになり、pick でコールバックへ色を渡して終了する', () => {
    const cb = vi.fn();
    useEyedropper.getState().start(cb);
    expect(useEyedropper.getState().active).toBe(true);

    useEyedropper.getState().pick('#123456');
    expect(cb).toHaveBeenCalledWith('#123456');
    expect(useEyedropper.getState().active).toBe(false);
    expect(useEyedropper.getState().onPick).toBeNull();
  });

  it('cancel はコールバックを呼ばずに終了する', () => {
    const cb = vi.fn();
    useEyedropper.getState().start(cb);
    useEyedropper.getState().cancel();
    expect(cb).not.toHaveBeenCalled();
    expect(useEyedropper.getState().active).toBe(false);
    expect(useEyedropper.getState().onPick).toBeNull();
  });
});
