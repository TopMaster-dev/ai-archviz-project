import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomViewer } from '../RoomViewer.js';
import { SketchCanvas } from '../SketchCanvas.js';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { isSupabaseConfigured } from '../../lib/db/supabaseClient.js';
import { createProject, getSharedProject, isFreePlanLimitError } from '../../lib/db/projects.js';
import type { SharedProject } from '../../lib/db/types.js';

/**
 * 閲覧用URL（共有・2b）のビューア。`?share=<token>` で開かれたときに index.tsx から描画する。
 *
 * 設計上の要点:
 * - 認証ゲート（AuthGate）の手前で描画するため、未ログインの訪問者でも閲覧できる。
 *   読み取りは SECURITY DEFINER の RPC `get_shared_project` 経由（projects RLS をバイパス）。
 * - シングルトンの useProjectStore には一切触れない。共有データ(project.data)を RoomViewer の
 *   props へ「直接」流し込む。これによりエディタ側の autosave がビューアのデータで本人の
 *   プロジェクトを上書きする事故を構造的に防ぐ。
 * - すべての編集系コールバックを no-op にして読み取り専用にする（RoomViewer は完全に props 駆動）。
 */
export function SharedProjectViewer({ token }: { token: string }) {
  const { userId } = useAuth();
  const [status, setStatus] = useState<'loading' | 'ready' | 'notfound' | 'error' | 'unconfigured'>('loading');
  const [project, setProject] = useState<SharedProject | null>(null);
  const [copying, setCopying] = useState(false);
  const [copyErr, setCopyErr] = useState<string | null>(null);
  // 共有ビューの表示切替（3Dビュー以外に 2D・AI画像も共有・260623）。すべて読み取り専用。
  const [view, setView] = useState<'3d' | '2d' | 'ai'>('3d');
  const [sharedCeilingView, setSharedCeilingView] = useState(false);

  // RoomViewer が要求する各種 ref（ビューア専用に都度生成。エディタとは共有しない）。
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const orbitControlsRef = useRef<OrbitControlsImpl | null>(null);
  const walkDigitalInputRef = useRef({ forward: 0, strafe: 0 });
  const cameraWalkStateRef = useRef({ yaw: 0, pitch: 0 });

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      setStatus('unconfigured');
      return;
    }
    let active = true;
    setStatus('loading');
    getSharedProject(token)
      .then((p) => {
        if (!active) return;
        if (!p) {
          setStatus('notfound');
        } else {
          setProject(p);
          setStatus('ready');
        }
      })
      .catch(() => {
        if (active) setStatus('error');
      });
    return () => {
      active = false;
    };
  }, [token]);

  // ?share を外して通常画面（ログイン or ホーム）へ戻る。
  const goAppRoot = () => {
    window.location.href = window.location.origin + window.location.pathname;
  };

  const handleCopy = async () => {
    if (!userId) {
      goAppRoot(); // 未ログイン: まずログイン画面へ。
      return;
    }
    if (!project) return;
    setCopying(true);
    setCopyErr(null);
    try {
      await createProject(`${project.name} のコピー`, project.data);
      goAppRoot(); // 自分のホーム画面へ遷移し、複製を表示。
    } catch (e) {
      setCopying(false);
      setCopyErr(
        isFreePlanLimitError(e)
          ? 'フリープランの保存上限に達しています。不要なプロジェクトを削除してから再度お試しください。'
          : '複製に失敗しました。時間をおいて再度お試しください。',
      );
    }
  };

  if (status !== 'ready' || !project) {
    return <CenteredMessage status={status} onHome={goAppRoot} />;
  }

  // --- 共有データを RoomViewer の props へ直接マッピング（防御的にデフォルトを補う） ---
  const data = project.data;
  const sketchPoints = data?.sketch?.points ?? [];
  const openings = data?.sketch?.openings ?? [];
  const wallDivisions = data?.sketch?.wallDivisions ?? {};
  const selections = data?.materials?.selections ?? {};
  const materialSettings = data?.materials?.materialSettings ?? {};
  const furnitureItems = data?.scene?.furniture ?? [];
  const beams = data?.scene?.beams ?? [];
  // 注: 天井高(roomHeightMm)はエディタの local state で保持され現状 data へ永続化されない既知の制約。
  //     保存値が未設定/作成時の既定(2400)の場合はエディタ表示の既定 2700mm にフォールバックする。
  const storedH = data?.scene?.roomHeightMm;
  const roomHeightMm = storedH && storedH > 0 && storedH !== 2400 ? storedH : 2700;
  const roomHeight = roomHeightMm / 1000;
  // AI画像編集の生成結果（共有・読み取り専用ギャラリー用）。
  const aiVersions = data?.aiEdit?.versions ?? [];

  return (
    <div className="flex h-screen w-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="shrink-0 text-sm font-bold">Arise</span>
          <span className="hidden shrink-0 rounded bg-white/10 px-2 py-0.5 text-[10px] text-neutral-300 sm:inline">
            閲覧用（編集できません）
          </span>
          <span className="min-w-0 truncate text-sm text-neutral-300" title={project.name}>
            {project.name}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-white/5 p-0.5">
          {(['3d', '2d', 'ai'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setView(k)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-bold transition ${view === k ? 'bg-white text-black' : 'text-neutral-300 hover:text-white'}`}
            >
              {k === '3d' ? '3Dビュー' : k === '2d' ? '2Dビュー' : 'AI画像'}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {copyErr && <span className="hidden text-[11px] text-red-300 md:inline">{copyErr}</span>}
          {userId ? (
            <button
              type="button"
              onClick={() => void handleCopy()}
              disabled={copying}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              {copying ? '複製中…' : '複製して編集'}
            </button>
          ) : (
            <button
              type="button"
              onClick={goAppRoot}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500"
            >
              ログインして編集
            </button>
          )}
        </div>
      </header>

      {copyErr && (
        <p className="shrink-0 bg-red-500/10 px-4 py-1.5 text-center text-[11px] text-red-300 md:hidden">{copyErr}</p>
      )}

      <div className="relative min-h-0 flex-1">
        {view === '3d' && (
        <RoomViewer
          selections={selections as Record<string, never>}
          onMeshClick={() => {}}
          activeCategory={null}
          activeMeshes={[]}
          cameraRef={cameraRef}
          sketchPoints={sketchPoints}
          roomHeight={roomHeight}
          snapshotMode={false}
          furnitureItems={furnitureItems}
          onFurnitureUpdate={() => {}}
          beams={beams}
          onBeamPatch={() => {}}
          onBeamSelect3D={() => {}}
          activeFurnitureId={null}
          onFurnitureSelect={() => {}}
          hideFurniture={false}
          maskMode={false}
          materialSettings={materialSettings}
          wallDivisions={wallDivisions}
          isRendering={false}
          captureStep="idle"
          openings={openings}
          setOpenings={() => {}}
          selectedOpeningId={null}
          onOpeningSelect={() => {}}
          outsideBackgroundColor="#b8d8ff"
          orbitControlsRef={orbitControlsRef}
          cameraBlendRequest={null}
          cameraMode="orbit"
          cameraFov={50}
          eyeHeightMm={1500}
          walkSessionKey={0}
          walkInitialYaw={0}
          walkInitialPitch={0}
          walkSpawnXZ={null}
          walkDigitalInputRef={walkDigitalInputRef}
          cameraWalkStateRef={cameraWalkStateRef}
        />
        )}

        {view === '2d' && (
        <div className="absolute inset-0">
          <SketchCanvas
            readOnly
            initialPoints={sketchPoints}
            gridSize={1000}
            lengthSnapSize={1000}
            isLengthSnapEnabled
            angleSnap={45}
            isAngleSnapEnabled
            onGridSizeChange={() => {}}
            onLengthSnapSizeChange={() => {}}
            onLengthSnapToggle={() => {}}
            onAngleSnapChange={() => {}}
            onAngleSnapToggle={() => {}}
            onSketchUpdate={() => {}}
            onApply={() => {}}
            openings={openings}
            setOpenings={() => {}}
            selectedOpeningId={null}
            onOpeningSelect={() => {}}
            toolMode="select"
            setToolMode={() => {}}
            addKind="furniture"
            setAddKind={() => {}}
            furnitureItems={furnitureItems}
            onFurnitureUpdate={() => {}}
            roomHeight={roomHeightMm}
            activeFurnitureId={null}
            onFurnitureSelect={() => {}}
            underlay={null}
            onUnderlayChange={() => {}}
            beams={beams}
            onBeamsChange={() => {}}
            isCeilingView={sharedCeilingView}
            onCeilingViewChange={setSharedCeilingView}
            onClearAll={() => {}}
          />
        </div>
        )}

        {view === 'ai' && (
        <div className="absolute inset-0 overflow-y-auto bg-neutral-950 p-4">
          {aiVersions.length === 0 ? (
            <p className="mt-10 text-center text-sm text-neutral-400">共有できるAI画像はありません。</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {aiVersions.map((v) => (
                <div key={v.id} className="overflow-hidden rounded-xl border border-white/10 bg-neutral-900">
                  <img src={v.outputImageDataUrl} alt="AI生成画像" className="w-full object-contain" loading="lazy" />
                </div>
              ))}
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}

function CenteredMessage({
  status,
  onHome,
}: {
  status: 'loading' | 'notfound' | 'error' | 'unconfigured' | 'ready';
  onHome: () => void;
}) {
  const text =
    status === 'loading'
      ? '読み込み中…'
      : status === 'notfound'
        ? 'リンクが無効か、共有が取り消された可能性があります。'
        : status === 'unconfigured'
          ? '共有リンクはこの環境では利用できません。'
          : '読み込みに失敗しました。時間をおいて再度お試しください。';
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-neutral-950 text-neutral-300">
      <p className="text-sm">{text}</p>
      {status !== 'loading' && (
        <button
          type="button"
          onClick={onHome}
          className="rounded-lg bg-neutral-800 px-4 py-2 text-xs transition hover:bg-neutral-700"
        >
          Arise を開く
        </button>
      )}
    </div>
  );
}
