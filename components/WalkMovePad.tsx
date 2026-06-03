import React from 'react';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';

interface WalkMovePadProps {
  disabled: boolean;
  walkDigitalInputRef: React.MutableRefObject<{ forward: number; strafe: number }>;
  className?: string;
}

export const WalkMovePad: React.FC<WalkMovePadProps> = ({ disabled, walkDigitalInputRef, className = '' }) => {
  const setDigital = (forward: number, strafe: number) => {
    walkDigitalInputRef.current = { forward, strafe };
  };

  return (
    <div
      className={`grid grid-cols-3 gap-0.5 shrink-0 p-1 rounded-xl border border-white/10 bg-black/45 backdrop-blur-md shadow-xl pointer-events-auto ${className}`}
      onPointerLeave={() => setDigital(0, 0)}
    >
      <span />
      <button
        type="button"
        disabled={disabled}
        className="p-1 rounded-lg bg-white/5 hover:bg-white/15 disabled:opacity-30"
        onPointerDown={(e) => {
          e.preventDefault();
          setDigital(1, 0);
        }}
        onPointerUp={() => setDigital(0, 0)}
      >
        <ChevronUp className="w-3.5 h-3.5 text-white/80" />
      </button>
      <span />
      <button
        type="button"
        disabled={disabled}
        className="p-1 rounded-lg bg-white/5 hover:bg-white/15 disabled:opacity-30"
        onPointerDown={(e) => {
          e.preventDefault();
          setDigital(0, -1);
        }}
        onPointerUp={() => setDigital(0, 0)}
      >
        <ChevronLeft className="w-3.5 h-3.5 text-white/80" />
      </button>
      <span />
      <button
        type="button"
        disabled={disabled}
        className="p-1 rounded-lg bg-white/5 hover:bg-white/15 disabled:opacity-30"
        onPointerDown={(e) => {
          e.preventDefault();
          setDigital(0, 1);
        }}
        onPointerUp={() => setDigital(0, 0)}
      >
        <ChevronRight className="w-3.5 h-3.5 text-white/80" />
      </button>
      <span />
      <button
        type="button"
        disabled={disabled}
        className="p-1 rounded-lg bg-white/5 hover:bg-white/15 disabled:opacity-30"
        onPointerDown={(e) => {
          e.preventDefault();
          setDigital(-1, 0);
        }}
        onPointerUp={() => setDigital(0, 0)}
      >
        <ChevronDown className="w-3.5 h-3.5 text-white/80" />
      </button>
      <span />
    </div>
  );
};
