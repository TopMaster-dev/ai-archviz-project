import React from 'react';
import { Plus, Pencil, X, RectangleHorizontal } from 'lucide-react';
import type { CameraPreset } from '../types.js';
import { NumericField } from './NumericField.js';
import { RENDER_ASPECT_RATIOS } from '../utils/renderAspect.js';

const MAX_VISIBLE_CHIPS = 8;

export type CameraBarMode = 'orbit' | 'walk';

interface CameraPresetBarProps {
  presets: CameraPreset[];
  lastAppliedId: string | null;
  disabled: boolean;
  cameraMode: CameraBarMode;
  onCameraModeChange: (mode: CameraBarMode) => void;
  cameraFov: number;
  onCameraFovChange: (fov: number) => void;
  eyeHeightMm: number;
  onEyeHeightMmChange: (mm: number) => void;
  /** 3Dレンダリング比率（'16:9' 等・第2段 260703）。3Dビュー表示・AIレンダ・書き出しに連動。 */
  renderAspectRatio: string;
  onRenderAspectRatioChange: (key: string) => void;
  onSaveCurrent: () => void;
  onApply: (preset: CameraPreset) => void;
  onDelete: (id: string) => void;
  onRename: (id: string) => void;
}

export const CameraPresetBar: React.FC<CameraPresetBarProps> = ({
  presets,
  lastAppliedId,
  disabled,
  cameraMode,
  onCameraModeChange,
  cameraFov,
  onCameraFovChange,
  eyeHeightMm,
  onEyeHeightMmChange,
  renderAspectRatio,
  onRenderAspectRatioChange,
  onSaveCurrent,
  onApply,
  onDelete,
  onRename,
}) => {
  const visible = presets.slice(-MAX_VISIBLE_CHIPS);
  const presetLocked = disabled;

  return (
    <div className="glass px-2 py-1.5 rounded-2xl border border-white/10 flex flex-col gap-2 bg-black/45 backdrop-blur-md shadow-xl pointer-events-auto max-w-[min(92vw,560px)]">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[9px] font-black uppercase text-neutral-500 tracking-wider">画角</span>
          <input
            type="range"
            min={30}
            max={90}
            step={1}
            value={cameraFov}
            disabled={disabled}
            onChange={(e) => onCameraFovChange(Number(e.target.value))}
            className="w-[88px] accent-emerald-500 disabled:opacity-30"
          />
          <span className="text-[10px] font-mono text-white/80 w-8">{Math.round(cameraFov)}°</span>
        </div>
        <div className="w-px h-6 bg-white/15 shrink-0" aria-hidden />
        <div className="flex items-center gap-1.5 shrink-0">
          <RectangleHorizontal className="w-3.5 h-3.5 text-neutral-400 shrink-0" aria-hidden />
          <span className="text-[9px] font-black uppercase text-neutral-500 tracking-wider">比率</span>
          <select
            value={renderAspectRatio}
            disabled={disabled}
            onChange={(e) => onRenderAspectRatioChange(e.target.value)}
            title="3Dビューの表示・AIレンダリング・書き出しの画面比率"
            aria-label="レンダリング比率"
            className="rounded-lg bg-black/40 border border-white/15 text-white/90 text-[10px] font-bold px-1.5 py-1 accent-emerald-500 disabled:opacity-30 focus:outline-none focus:border-emerald-500/60"
          >
            {RENDER_ASPECT_RATIOS.map((r) => (
              <option key={r.key} value={r.key} className="bg-zinc-900 text-white">
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div className="w-px h-6 bg-white/15 shrink-0" aria-hidden />
        <div className="glass p-0.5 rounded-xl border border-white/10 flex shrink-0">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onCameraModeChange('orbit')}
            className={`px-2 py-1 rounded-lg text-[9px] font-black tracking-wider transition-colors ${
              cameraMode === 'orbit' ? 'bg-white text-black' : 'text-white/55 hover:text-white'
            } disabled:opacity-30`}
          >
            注視点回転
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onCameraModeChange('walk')}
            className={`px-2 py-1 rounded-lg text-[9px] font-black tracking-wider transition-colors ${
              cameraMode === 'walk' ? 'bg-white text-black' : 'text-white/55 hover:text-white'
            } disabled:opacity-30`}
          >
            ウォーク
          </button>
        </div>
        {cameraMode === 'walk' && (
          <>
            <div className="w-px h-6 bg-white/15 shrink-0" aria-hidden />
            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[9px] font-black uppercase text-neutral-500 tracking-wider">目線</span>
              <NumericField
                value={eyeHeightMm}
                onChange={onEyeHeightMmChange}
                dragSensitivity={10}
                className="w-[64px]"
                inputClassName="text-center text-[10px] text-cyan-300/90"
                disabled={disabled}
              />
              <span className="text-[8px] text-neutral-500 font-bold">mm</span>
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
        <button
          type="button"
          title="現在の視点を保存"
          disabled={presetLocked}
          onClick={onSaveCurrent}
          className="shrink-0 flex items-center gap-1 px-2 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider text-emerald-300/90 hover:bg-emerald-500/15 disabled:opacity-30 disabled:pointer-events-none transition-colors border border-emerald-500/25"
        >
          <Plus className="w-3.5 h-3.5" aria-hidden />
          視点を保存
        </button>
        <div className="w-px h-6 bg-white/15 shrink-0 self-center" aria-hidden />
        <div className="flex items-center gap-1 min-w-0 overflow-x-auto scroll-dark py-0.5 flex-1">
          {visible.length === 0 ? (
            <span className="text-[9px] text-white/35 font-bold px-2 whitespace-nowrap">保存した視点がありません</span>
          ) : (
            visible.map((p) => {
              const active = lastAppliedId === p.id;
              return (
                <div
                  key={p.id}
                  className={`flex items-center gap-0.5 shrink-0 rounded-lg pl-2 pr-0.5 py-0.5 border transition-colors ${
                    active
                      ? 'bg-white/15 border-white/25'
                      : 'bg-black/30 border-white/10 hover:border-white/20'
                  }`}
                >
                  <button
                    type="button"
                    title={p.label}
                    disabled={presetLocked}
                    onClick={() => onApply(p)}
                    className="text-[10px] font-bold text-white/90 max-w-[100px] truncate disabled:opacity-30"
                  >
                    {p.label}
                  </button>
                  <button
                    type="button"
                    title="名前を変更"
                    disabled={presetLocked}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRename(p.id);
                    }}
                    className="p-1 rounded-md text-white/45 hover:text-white/80 hover:bg-white/10 disabled:opacity-30"
                  >
                    <Pencil className="w-3 h-3" aria-hidden />
                  </button>
                  <button
                    type="button"
                    title="削除"
                    disabled={presetLocked}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(p.id);
                    }}
                    className="p-1 rounded-md text-white/35 hover:text-rose-300 hover:bg-rose-500/15 disabled:opacity-30"
                  >
                    <X className="w-3 h-3" aria-hidden />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
