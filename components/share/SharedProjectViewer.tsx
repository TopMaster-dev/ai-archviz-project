import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Loader2, X } from 'lucide-react';
import type { OrbitControls as OrbitControlsImpl } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomViewer } from '../RoomViewer.js';
import { SketchCanvas } from '../SketchCanvas.js';
import { LoadingOverlay } from '../LoadingOverlay.js';
import { useAuth } from '../../lib/auth/AuthContext.js';
import { isSupabaseConfigured } from '../../lib/db/supabaseClient.js';
import { createProject, getSharedProject, isFreePlanLimitError } from '../../lib/db/projects.js';
import { useLoadingStore } from '../../lib/store/loadingStore.js';
import type { SharedProject } from '../../lib/db/types.js';
import type { AiEditVersion } from '../../types.js';

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
  const walkDigitalInputRef = useRef({ forward: 0, strafe: 0, rotate: 0, reset: false });
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

  // 種別（2a）: 'photo' = 写真をAI編集する専用プロジェクト。共有時は 2D/3D を出さず AI画像だけ表示する。
  const isPhoto = project?.data?.kind === 'photo';
  const effectiveView: '3d' | '2d' | 'ai' = isPhoto ? 'ai' : view;

  // 読み込み後のローディング画面（クライアント要望）: プロジェクト取得後も 3D 生成に少し間があり
  // 「何も表示されない時間」が出るため、3Dビュー表示中はオーバーレイを出す。RoomViewer の Canvas
  // onCreated が useLoadingStore.hide('view') を呼ぶので、3Dが描画され次第自動的に解除される。
  useEffect(() => {
    if (status !== 'ready') return;
    const loading = useLoadingStore.getState();
    if (effectiveView === '3d') {
      loading.show('view', '3Dビューを準備しています…');
      // WebGL 初期化に失敗しても固まらないよう 8 秒でセーフティ解除（本体 App と同方針）。
      const safety = window.setTimeout(() => loading.hide('view'), 8000);
      return () => {
        window.clearTimeout(safety);
        loading.hide('view');
      };
    }
    loading.hide('view');
    return () => loading.hide('view');
  }, [status, effectiveView]);

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
  // AI画像編集の生成結果（共有・読み取り専用の履歴＋拡大表示用）。
  const aiVersions: AiEditVersion[] = data?.aiEdit?.versions ?? [];

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
        {/* 写真AI編集('photo')の共有では 2D/3D は出さない（クライアント要望）。空間デザイン('full')のみ切替を表示。 */}
        {isPhoto ? (
          <span className="shrink-0 rounded-md bg-white/10 px-2.5 py-1 text-[11px] font-bold text-neutral-200">
            AI画像編集
          </span>
        ) : (
          <div className="flex shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-white/5 p-0.5">
            {(['2d', '3d', 'ai'] as const).map((k) => (
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
        )}
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
        {effectiveView === '3d' && (
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

        {effectiveView === '2d' && (
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

        {effectiveView === 'ai' && (
        <div className="absolute inset-0 bg-neutral-950">
          <SharedAiEditView versions={aiVersions} />
        </div>
        )}
      </div>

      {/* 読み込み後の描画待ち（主に3D）を覆うローディング画面。RoomViewer 準備完了で自動解除。 */}
      <LoadingOverlay />
    </div>
  );
}

/**
 * 共有ビューの「AI画像編集」表示（読み取り専用）。本家 AiEditWorkspace の要点を再現:
 * 左に生成履歴（新しい順・サムネ＋日時・クリックで選択）、中央に選択中の生成画像を拡大表示、
 * 画像クリックで全画面ライトボックス（クライアント要望「履歴表示＋生成画像の拡大」）。
 */
function SharedAiEditView({ versions }: { versions: AiEditVersion[] }) {
  const sorted = [...versions].sort((a, b) => b.createdAt - a.createdAt);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const selected = sorted.find((v) => v.id === selectedId) ?? sorted[0] ?? null;

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  if (sorted.length === 0) {
    return <p className="mt-10 text-center text-sm text-neutral-400">共有できるAI画像はありません。</p>;
  }

  return (
    <div className="flex h-full min-h-0">
      {/* 生成履歴（新しい順） */}
      <aside className="w-24 shrink-0 space-y-2 overflow-y-auto border-r border-white/10 bg-neutral-900/60 p-2 sm:w-36">
        {sorted.map((v) => {
          const active = v.id === selected?.id;
          return (
            <button
              key={v.id}
              type="button"
              onClick={() => setSelectedId(v.id)}
              title={new Date(v.createdAt).toLocaleString('ja-JP')}
              className={`block w-full overflow-hidden rounded-lg border text-left transition ${
                active ? 'border-emerald-500 ring-1 ring-emerald-500/40' : 'border-white/10 hover:border-white/30'
              }`}
            >
              <img src={v.outputImageDataUrl} alt="生成履歴" className="aspect-video w-full object-cover" loading="lazy" />
              <span className="block px-1.5 py-1 text-[9px] leading-tight text-neutral-400">
                {new Date(v.createdAt).toLocaleString('ja-JP')}
              </span>
            </button>
          );
        })}
      </aside>

      {/* 選択中の生成画像を拡大表示（クリックで全画面拡大） */}
      <div className="flex min-w-0 flex-1 items-center justify-center p-3 sm:p-6">
        {selected && (
          <button
            type="button"
            onClick={() => setLightbox(selected.outputImageDataUrl)}
            title="クリックで拡大"
            className="max-h-full max-w-full"
          >
            <img
              src={selected.outputImageDataUrl}
              alt="AI生成画像"
              className="max-h-[calc(100vh-9rem)] max-w-full rounded-lg object-contain"
            />
          </button>
        )}
      </div>

      {/* ライトボックス（全画面拡大・クリック/Escで閉じる） */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[10060] flex items-center justify-center bg-black/90 p-4"
          onClick={() => setLightbox(null)}
        >
          <img src={lightbox} alt="拡大表示" className="max-h-full max-w-full object-contain" />
          <button
            type="button"
            onClick={() => setLightbox(null)}
            aria-label="閉じる"
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      )}
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
      {status === 'loading' && <Loader2 className="h-8 w-8 animate-spin text-emerald-400" />}
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
