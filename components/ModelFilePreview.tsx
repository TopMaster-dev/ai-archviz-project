import React, { Suspense, useEffect, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Bounds, OrbitControls } from '@react-three/drei';
import { Box } from 'lucide-react';
import { ModelRoot } from './ModelRoot.js';

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

export function ModelFilePreview({ file, className }: { file: File; className?: string }) {
  // ローダの形式判定用に拡張子を fragment(#glb 等)で付与（blob: URL は拡張子を持たないため）。
  const url = useMemo(() => {
    const dot = file.name.lastIndexOf('.');
    const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : '';
    const raw = URL.createObjectURL(file);
    return { full: ext ? `${raw}#${ext}` : raw, raw };
  }, [file]);
  useEffect(() => () => URL.revokeObjectURL(url.raw), [url]);

  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]); // 別ファイルに差し替わったら失敗状態をリセット

  if (failed) {
    return (
      <div className={`flex flex-col items-center justify-center gap-1.5 bg-neutral-800 text-neutral-400 ${className ?? ''}`}>
        <Box className="h-8 w-8" />
        <span className="line-clamp-2 break-all px-1.5 text-center text-[9px] leading-tight">{file.name}</span>
      </div>
    );
  }

  return (
    <div className={`overflow-hidden bg-neutral-800 ${className ?? ''}`}>
      {/* 小さなプレビューなので dpr は控えめに（エディタの 3D Canvas と同時表示になるため GPU メモリ負荷を抑える）。 */}
      <Canvas camera={{ position: [2.4, 1.8, 2.4], fov: 45 }} dpr={[1, 1.5]} gl={{ antialias: true }}>
        <ambientLight intensity={1.3} />
        <directionalLight position={[5, 10, 5]} intensity={1.4} />
        <directionalLight position={[-5, 2, -5]} intensity={0.4} />
        <Suspense fallback={null}>
          {/* Bounds が FBX/OBJ の単位差（cm 等）を含めカメラを自動フィットするので、スケール正規化は不要。 */}
          <PreviewErrorBoundary key={url.full} onError={() => setFailed(true)}>
            <Bounds fit clip margin={1.2}>
              <ModelRoot url={url.full}>{(root) => <primitive object={root} />}</ModelRoot>
            </Bounds>
          </PreviewErrorBoundary>
        </Suspense>
        <OrbitControls makeDefault enablePan={false} enableZoom={false} autoRotate autoRotateSpeed={3} />
      </Canvas>
    </div>
  );
}
