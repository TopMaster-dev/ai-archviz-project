import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { Bounds, OrbitControls } from '@react-three/drei';
import { Box } from 'lucide-react';
import { ModelRoot } from './ModelRoot.js';
import { exoticNormalizeScale, type ModelFormat } from '../utils/modelFormat.js';
import { unitGeometryScale, type ModelUnit } from '../utils/modelUnit.js';

// アップロード前のローカル 3Dモデルファイル（.glb/.gltf/.fbx/.obj）を、その場で 3D プレビュー表示する。
// 情報入力ポップアップ（エディタ App / ホーム UploadPanel 双方）の左側プレビューで使う（260630・クライアント要望）。
// 壊れた/未対応モデルや WebGL 失敗時は、キューブアイコン＋ファイル名のフォールバックへ落ちてクラッシュしない。

class PreviewErrorBoundary extends React.Component<
  { onError: () => void; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** 実寸オーバーレイの表示用フォーマット（mm・桁区切り）。 */
function fmtMm(v: number): string {
  return Math.round(v).toLocaleString('ja-JP');
}

type RawSize = { x: number; y: number; z: number };

// 読み込み済みの root からバウンディングを一度だけ計測して親へ返す（プレビューの二重ロードを避ける・③ 検証 #8）。
function MeasureOnLoad({
  root,
  format,
  onMeasured
}: {
  root: THREE.Object3D;
  format: ModelFormat | null;
  onMeasured: (raw: RawSize, format: ModelFormat | null) => void;
}) {
  useEffect(() => {
    const box = new THREE.Box3().setFromObject(root);
    const sz = box.getSize(new THREE.Vector3());
    onMeasured({ x: sz.x, y: sz.y, z: sz.z }, format);
  }, [root, format, onMeasured]);
  return null;
}

export function ModelFilePreview({
  file,
  className,
  unit = 'auto'
}: {
  file: File;
  className?: string;
  /** 取り込み単位（③・260717）。選択単位での実寸(W×D×H)をオーバーレイ表示する。 */
  unit?: ModelUnit;
}) {
  // ローダの形式判定用に拡張子を fragment(#glb 等)で付与（blob: URL は拡張子を持たないため）。
  const url = useMemo(() => {
    const dot = file.name.lastIndexOf('.');
    const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : '';
    const raw = URL.createObjectURL(file);
    return { full: ext ? `${raw}#${ext}` : raw, raw };
  }, [file]);
  useEffect(() => () => URL.revokeObjectURL(url.raw), [url]);

  const [failed, setFailed] = useState(false);
  const [rawSize, setRawSize] = useState<RawSize | null>(null);
  const [measuredFormat, setMeasuredFormat] = useState<ModelFormat | null>(null);
  useEffect(() => {
    // 別ファイルに差し替わったら失敗状態と計測値をリセット（前ファイルの寸法が残らないように）。
    setFailed(false);
    setRawSize(null);
    setMeasuredFormat(null);
  }, [url]);

  const handleMeasured = useCallback((raw: RawSize, format: ModelFormat | null) => {
    setRawSize(raw);
    setMeasuredFormat(format);
  }, []);

  // 実寸(mm)＝生バウンディング(モデル単位) × 幾何スケール × 1000。
  // 幾何スケールは描画側 ClayModel と同一：明示単位なら f_U、自動は FBX/OBJ の exoticNormalizeScale（glTFは1）。
  const dimText = useMemo(() => {
    if (!rawSize) return null;
    const rawMax = Math.max(rawSize.x, rawSize.y, rawSize.z);
    const explicit = unitGeometryScale(unit); // 'auto' は null
    const geomScale =
      explicit != null
        ? explicit
        : measuredFormat === 'fbx' || measuredFormat === 'obj'
          ? exoticNormalizeScale(rawMax)
          : 1;
    const w = rawSize.x * geomScale * 1000;
    const d = rawSize.z * geomScale * 1000;
    const h = rawSize.y * geomScale * 1000;
    if (![w, d, h].every((v) => Number.isFinite(v) && v > 0)) return null;
    return `${fmtMm(w)} × ${fmtMm(d)} × ${fmtMm(h)} mm`;
  }, [rawSize, measuredFormat, unit]);

  if (failed) {
    return (
      <div className={`flex flex-col items-center justify-center gap-1.5 bg-neutral-800 text-neutral-400 ${className ?? ''}`}>
        <Box className="h-8 w-8" />
        <span className="line-clamp-2 break-all px-1.5 text-center text-[9px] leading-tight">{file.name}</span>
      </div>
    );
  }

  return (
    <div className={`relative overflow-hidden bg-neutral-800 ${className ?? ''}`}>
      {/* 小さなプレビューなので dpr は控えめに（エディタの 3D Canvas と同時表示になるため GPU メモリ負荷を抑える）。 */}
      <Canvas camera={{ position: [2.4, 1.8, 2.4], fov: 45 }} dpr={[1, 1.5]} gl={{ antialias: true }}>
        <ambientLight intensity={1.3} />
        <directionalLight position={[5, 10, 5]} intensity={1.4} />
        <directionalLight position={[-5, 2, -5]} intensity={0.4} />
        <Suspense fallback={null}>
          {/* Bounds が FBX/OBJ の単位差（cm 等）を含めカメラを自動フィットするので、スケール正規化は不要。 */}
          <PreviewErrorBoundary key={url.full} onError={() => setFailed(true)}>
            <Bounds fit clip margin={1.2}>
              <ModelRoot url={url.full}>
                {(root, format) => (
                  <>
                    <primitive object={root} />
                    <MeasureOnLoad root={root} format={format} onMeasured={handleMeasured} />
                  </>
                )}
              </ModelRoot>
            </Bounds>
          </PreviewErrorBoundary>
        </Suspense>
        <OrbitControls makeDefault enablePan={false} enableZoom={false} autoRotate autoRotateSpeed={3} />
      </Canvas>
      {/* 選択単位での実寸(幅×奥行×高さ)。単位を変えると即時に更新される（③・260717）。 */}
      {dimText && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/65 px-1 py-0.5 text-center text-[8px] font-semibold leading-tight text-neutral-100">
          {dimText}
        </div>
      )}
    </div>
  );
}
