import React, { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Grid, GizmoHelper, GizmoViewport } from '@react-three/drei';
import { Box } from 'lucide-react';
import { ModelRoot } from './ModelRoot.js';
import { exoticNormalizeScale, type ModelFormat } from '../utils/modelFormat.js';
import { unitGeometryScale, type ModelUnit } from '../utils/modelUnit.js';
import { detectWallFaceYawDeg, normalizeUprightXDeg, normalizeYawDeg } from '../utils/modelOrientation.js';

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

// 読み込み済みの root からバウンディングを一度だけ計測し、壁側面(背面)を向けるヨーも推定して親へ返す
// （プレビューの二重ロードを避ける・③検証#8／①壁面自動推定）。uprightXDeg で上下補正後の姿勢で判定する。
function MeasureOnLoad({
  root,
  format,
  uprightXDeg,
  onMeasured,
  onSuggestYaw
}: {
  root: THREE.Object3D;
  format: ModelFormat | null;
  uprightXDeg: number;
  onMeasured: (raw: RawSize, format: ModelFormat | null) => void;
  onSuggestYaw?: (yawDeg: number) => void;
}) {
  // 素の寸法（intrinsic）: root は回転グループの子なので world 計測は親回転を含んでしまう。
  // computeGltfFootprintBaseMm と同様に「親なしクローン」を計測して root ローカル姿勢の実寸を得る。
  useEffect(() => {
    const clone = root.clone();
    clone.updateWorldMatrix(true, true);
    const sz = new THREE.Box3().setFromObject(clone).getSize(new THREE.Vector3());
    onMeasured({ x: sz.x, y: sz.y, z: sz.z }, format);
  }, [root, format, onMeasured]);
  // 壁側面(背面)を向けるヨー推定。detectWallFaceYawDeg は root 基準で評価するのでラッパ回転に非依存。
  useEffect(() => {
    if (!onSuggestYaw) return;
    try {
      onSuggestYaw(detectWallFaceYawDeg(root, uprightXDeg));
    } catch {
      /* 検出失敗（特殊ジオメトリ）→ 提案なし。 */
    }
  }, [root, uprightXDeg, onSuggestYaw]);
  return null;
}

/** 上下補正(90°刻み)を適用した後の見かけ寸法（X軸90/270°で Y↔Z が入れ替わる）。 */
function applyUprightToSize(sz: RawSize, uprightXDeg: number): RawSize {
  return normalizeUprightXDeg(uprightXDeg) % 180 === 90 ? { x: sz.x, y: sz.z, z: sz.y } : sz;
}

/**
 * プレビュー表示の正規化＋接地（260724・クライアント要望）。モデルの実寸に依存せず、常に「最大辺＝TARGET_SIZE」に
 * スケールして一定サイズで見せ、底面を y=0（床グリッド上）へ・X/Z中心を原点へ合わせる。これで巨大/極小モデルでも
 * 見た目の大きさが揃い、グリッドが常に画面内に入る。回転（上下/前後）を内側グループで適用したうえで world バウンディングを
 * 計測するので、回転後の姿勢でも正しく接地する。回転や差し替えのたびに再計測する。
 */
const PREVIEW_TARGET_SIZE = 2.6;
function NormalizedModel({
  root,
  uprightRad,
  yawRad,
  children,
}: {
  root: THREE.Object3D;
  uprightRad: number;
  yawRad: number;
  children?: React.ReactNode;
}) {
  const ref = useRef<THREE.Group>(null);
  useLayoutEffect(() => {
    const g = ref.current;
    if (!g) return;
    // いったん等倍・原点へ戻してから、回転込みの素の world バウンディングを計測する。
    g.scale.setScalar(1);
    g.position.set(0, 0, 0);
    g.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(g);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (!(maxDim > 0) || !Number.isFinite(maxDim)) return;
    // 最大辺を TARGET_SIZE に揃える＝実寸に依らず一定サイズ。
    g.scale.setScalar(PREVIEW_TARGET_SIZE / maxDim);
    g.updateWorldMatrix(true, true);
    // スケール後にもう一度計測し、X/Z中心を原点・底面を y=0（床）へ。
    const box2 = new THREE.Box3().setFromObject(g);
    const center = box2.getCenter(new THREE.Vector3());
    g.position.set(-center.x, -box2.min.y, -center.z);
  }, [root, uprightRad, yawRad]);
  return (
    <group ref={ref}>
      {/* 配置と同順で：外側ヨー(Y)→内側 上下補正(X・ジオメトリ焼込相当)。 */}
      <group rotation={[0, yawRad, 0]}>
        <group rotation={[uprightRad, 0, 0]}>
          <primitive object={root} />
          {children}
        </group>
      </group>
    </group>
  );
}

export function ModelFilePreview({
  file,
  className,
  unit = 'auto',
  uprightXDeg = 0,
  yawDeg = 0,
  onSuggestYaw,
  interactive = true,
  showGuides = true
}: {
  file: File;
  className?: string;
  /** 取り込み単位（③・260717）。選択単位での実寸(W×D×H)をオーバーレイ表示する。 */
  unit?: ModelUnit;
  /** 取り込み向きの上下補正（①・260717・X軸0/90/180/270°）。プレビューと寸法に反映。 */
  uprightXDeg?: number;
  /** 取り込み向きの前後ヨー（①・260717）。プレビューの見た目に反映（寸法は不変）。 */
  yawDeg?: number;
  /** 壁側面(背面)を向けるための推定ヨー(度)を親へ通知（自動推定・①）。 */
  onSuggestYaw?: (yawDeg: number) => void;
  /** ドラッグで視点回転/ズームできるか（260723・クライアント「位置変更」＝操作可能に）。false は従来の自動回転サムネ。 */
  interactive?: boolean;
  /** 前後上下が分かる視覚ガイド（XYZ軸ギズモ＋床グリッド）を出すか（260723・クライアント要望）。 */
  showGuides?: boolean;
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

  // 実寸(mm)＝上下補正後バウンディング(モデル単位) × 幾何スケール × 1000。
  // 幾何スケールは描画側 ClayModel と同一：明示単位なら f_U、自動は FBX/OBJ の exoticNormalizeScale（glTFは1）。
  // 前後ヨーは平面内の向き回転なので W×D×H（intrinsic）には影響しない。
  const dimText = useMemo(() => {
    if (!rawSize) return null;
    const sz = applyUprightToSize(rawSize, uprightXDeg);
    const rawMax = Math.max(rawSize.x, rawSize.y, rawSize.z);
    const explicit = unitGeometryScale(unit); // 'auto' は null
    const geomScale =
      explicit != null
        ? explicit
        : measuredFormat === 'fbx' || measuredFormat === 'obj'
          ? exoticNormalizeScale(rawMax)
          : 1;
    const w = sz.x * geomScale * 1000;
    const d = sz.z * geomScale * 1000;
    const h = sz.y * geomScale * 1000;
    if (![w, d, h].every((v) => Number.isFinite(v) && v > 0)) return null;
    return `${fmtMm(w)} × ${fmtMm(d)} × ${fmtMm(h)} mm`;
  }, [rawSize, measuredFormat, unit, uprightXDeg]);

  const uprightRad = (normalizeUprightXDeg(uprightXDeg) * Math.PI) / 180;
  const yawRad = (normalizeYawDeg(yawDeg) * Math.PI) / 180;

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
      {/* 小さなプレビューなので dpr は控えめに（エディタの 3D Canvas と同時表示になるため GPU メモリ負荷を抑える）。
          カメラ・ターゲットは固定。モデル側を NormalizedModel で常に一定サイズ（最大辺=TARGET_SIZE）へ正規化して接地するので、
          実寸に依らず見た目の大きさが揃い、床グリッドも常に画面内に入る（260724・クライアント要望）。 */}
      <Canvas camera={{ position: [2.7, 2.2, 2.7], fov: 45 }} dpr={[1, 1.5]} gl={{ antialias: true }}>
        <ambientLight intensity={1.3} />
        <directionalLight position={[5, 10, 5]} intensity={1.4} />
        <directionalLight position={[-5, 2, -5]} intensity={0.4} />
        <Suspense fallback={null}>
          <PreviewErrorBoundary key={url.full} onError={() => setFailed(true)}>
            <ModelRoot url={url.full}>
              {(root, format) => (
                <NormalizedModel root={root} uprightRad={uprightRad} yawRad={yawRad}>
                  <MeasureOnLoad
                    root={root}
                    format={format}
                    uprightXDeg={uprightXDeg}
                    onMeasured={handleMeasured}
                    onSuggestYaw={onSuggestYaw}
                  />
                </NormalizedModel>
              )}
            </ModelRoot>
          </PreviewErrorBoundary>
        </Suspense>
        {/* 床面グリッド（どこが床か＝上下の基準）。正規化で底面が y=0 に接地するのでモデルはこの上に立つ（260723/260724・④）。 */}
        {showGuides && (
          <Grid
            position={[0, 0, 0]}
            infiniteGrid
            cellSize={0.25}
            cellThickness={0.5}
            cellColor="#3f4650"
            sectionSize={1}
            sectionThickness={1}
            sectionColor="#6b7280"
            fadeDistance={20}
            fadeStrength={1}
            followCamera={false}
          />
        )}
        {/* XYZ 軸ギズモ（右上）。Y=上・Z=前後・X=左右がひと目で分かる。クリックで各面へスナップも可（260723・④）。 */}
        {showGuides && (
          <GizmoHelper alignment="top-right" margin={[44, 44]}>
            <GizmoViewport axisColors={['#ef4444', '#22c55e', '#3b82f6']} labelColor="#ffffff" />
          </GizmoHelper>
        )}
        <OrbitControls
          makeDefault
          target={[0, 1, 0]}
          enablePan={interactive}
          enableZoom={interactive}
          autoRotate={!interactive}
          autoRotateSpeed={3}
        />
      </Canvas>
      {/* 選択単位・向きでの実寸(幅×奥行×高さ)。単位/上下を変えると即時に更新される（③④①・260717）。 */}
      {dimText && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/65 px-1 py-0.5 text-center text-[8px] font-semibold leading-tight text-neutral-100">
          {dimText}
        </div>
      )}
    </div>
  );
}
