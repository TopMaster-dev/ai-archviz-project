import React, { useRef, useState, useCallback, useEffect } from 'react';

/** この距離(px)を超えたらドラッグ開始（クリックと区別） */
const DRAG_THRESHOLD_PX = 8;

export type NumericFieldProps = {
  value: number;
  onChange: (n: number) => void;
  /** 1px ドラッグあたりの値の変化量 */
  dragSensitivity?: number;
  className?: string;
  inputClassName?: string;
  disabled?: boolean;
};

export const NumericField: React.FC<NumericFieldProps> = ({
  value,
  onChange,
  dragSensitivity = 1,
  className = '',
  inputClassName = '',
  disabled = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const safeValue = Number.isFinite(value) ? value : 0;
  const shown = draft !== null ? draft : String(safeValue);

  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(null);
  }, [value]);

  const commitString = useCallback(
    (s: string) => {
      setDraft(null);
      const trimmed = s.trim();
      if (trimmed === '' || trimmed === '-' || trimmed === '.' || trimmed === '-.') return;
      const n = Number(trimmed.replace(/,/g, ''));
      if (Number.isFinite(n)) onChange(n);
    },
    [onChange]
  );

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    // preventDefault しない: クリックで input にフォーカスできるようにする

    const startX = e.clientX;
    const startV = safeValue;
    const pointerId = e.pointerId;
    let dragActive = false;

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!dragActive) {
        if (Math.abs(ev.clientX - startX) < DRAG_THRESHOLD_PX) return;
        dragActive = true;
        setIsDragging(true);
        inputRef.current?.blur();
        containerRef.current?.setPointerCapture(pointerId);
      }
      ev.preventDefault();
      onChange(startV + (ev.clientX - startX) * dragSensitivity);
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (dragActive) {
        try {
          containerRef.current?.releasePointerCapture(pointerId);
        } catch {
          /* ignore */
        }
      }
      setIsDragging(false);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };

    document.addEventListener('pointermove', onMove, { passive: false });
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  };

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      title="左右にドラッグで値を変更・クリックで直接入力"
      className={`flex items-stretch min-w-0 rounded-lg border border-white/10 overflow-hidden bg-black/30 select-none ${
        isDragging ? 'cursor-grabbing' : 'cursor-ew-resize'
      } ${disabled ? 'pointer-events-none opacity-40' : ''} ${className}`}
    >
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        disabled={disabled}
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commitString(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          }
        }}
        className={`numeric-field-input w-full min-w-0 min-h-0 h-full self-stretch border-0 bg-transparent px-2 py-0.5 text-xs font-mono text-white focus:outline-none focus:ring-0 focus-visible:ring-1 focus-visible:ring-emerald-500/50 transition-colors cursor-ew-resize focus:cursor-text select-text ${inputClassName}`}
      />
    </div>
  );
};
