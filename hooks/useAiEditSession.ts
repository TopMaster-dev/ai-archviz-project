import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AiEditObjectReference, AiEditVersion, NormalizedRect } from '../types.js';
import { normalizeStoredVersions } from '../lib/aiEditNormalize.js';
import { deleteAiRenderImages } from '../lib/db/aiRenderStorage.js';

function newObjectId() {
  return `obj_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function newVersionId() {
  return `ver_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

const STORAGE_KEY = 'archviz-ai-edit-session-v2';

// 履歴の最大保持件数。260619: 生成画像はクラウド保存しURL化したため履歴メタは軽量になり、上限を大幅緩和
// （クライアント要望「履歴を残したい」）。暴走防止の安全上限としてのみ機能する（実用上ほぼ無制限）。
export const MAX_AI_EDIT_VERSIONS = 200;

/**
 * 削除対象の版とその全子孫（再生成で連なった版）の id 集合を返す（260625）。
 * 親が削除されたら子・孫…も連鎖して含める（固定点反復）。子孫を取りこぼして親リンク切れの版を残さない。
 */
export function collectVersionsToDelete<T extends { id: string; parentId: string | null }>(
  versions: T[],
  idToDelete: string,
): Set<string> {
  const remove = new Set<string>([idToDelete]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const v of versions) {
      if (!remove.has(v.id) && v.parentId && remove.has(v.parentId)) {
        remove.add(v.id);
        changed = true;
      }
    }
  }
  return remove;
}

function capVersions(vers: AiEditVersion[]): AiEditVersion[] {
  return vers.length > MAX_AI_EDIT_VERSIONS ? vers.slice(vers.length - MAX_AI_EDIT_VERSIONS) : vers;
}

function loadStored(): { versions: AiEditVersion[]; activeVersionId: string | null } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const legacy = localStorage.getItem('archviz-ai-edit-session-v1');
      if (legacy) {
        const data = JSON.parse(legacy) as { versions?: unknown; activeVersionId?: string | null };
        const versions = normalizeStoredVersions(data.versions);
        return { versions, activeVersionId: data.activeVersionId ?? null };
      }
      return null;
    }
    const data = JSON.parse(raw) as { versions?: unknown; activeVersionId?: string | null };
    const versions = normalizeStoredVersions(data.versions);
    return { versions, activeVersionId: data.activeVersionId ?? null };
  } catch {
    return null;
  }
}

/**
 * @param options.persistLocal localStorage に履歴を保持するか（既定 true）。
 *   写真AI編集プロジェクト（2a）はプロジェクトごとに DB 保存するため false を渡し、
 *   グローバルな localStorage を介した他プロジェクトへの履歴の混入を防ぐ。
 */
export function useAiEditSession(options?: { persistLocal?: boolean }) {
  const persistLocal = options?.persistLocal ?? true;
  const [versions, setVersions] = useState<AiEditVersion[]>(() =>
    persistLocal ? capVersions(loadStored()?.versions ?? []) : []
  );
  const [activeVersionId, setActiveVersionId] = useState<string | null>(() =>
    persistLocal ? loadStored()?.activeVersionId ?? null : null
  );
  const lastHydratedActiveId = useRef<string | null>(null);
  const skipHydrateOnce = useRef(false);

  const [draftStyleRefDataUrl, setDraftStyleRefDataUrl] = useState<string | null>(null);
  const [draftStyleMemo, setDraftStyleMemo] = useState('');
  const [draftObjects, setDraftObjects] = useState<AiEditObjectReference[]>([]);
  const [activeObjectId, setActiveObjectId] = useState<string | null>(null);
  /** null = 次のドラッグは placements に追加。数値 = そのインデックスを置換 */
  const [placementEditIndex, setPlacementEditIndex] = useState<number | null>(null);
  const placementEditIndexRef = useRef<number | null>(null);
  placementEditIndexRef.current = placementEditIndex;

  const resetDraft = useCallback(() => {
    setDraftStyleRefDataUrl(null);
    setDraftStyleMemo('');
    setDraftObjects([]);
    setActiveObjectId(null);
    setPlacementEditIndex(null);
  }, []);

  const hydrateDraftFromVersion = useCallback((v: AiEditVersion) => {
    setDraftStyleRefDataUrl(v.styleRefDataUrl);
    setDraftStyleMemo(v.styleMemo ?? '');
    setDraftObjects(v.objects.map((o) => ({ ...o, placements: o.placements.map((p) => ({ ...p })) })));
    setActiveObjectId(null);
    setPlacementEditIndex(null);
  }, []);

  /**
   * AI レンダリング成功時: 新しいルート履歴を「追加」する（過去の履歴は保持＝見返せる）。
   * 各レンダーは独立したルート（parentId=null）。以降の編集は appendVersionAfterEdit で子として連なる。
   */
  const addVersionFromRender = useCallback(
    (outputDataUrl: string) => {
      const id = newVersionId();
      const ver: AiEditVersion = {
        id,
        parentId: null,
        createdAt: Date.now(),
        baseImageDataUrl: outputDataUrl,
        outputImageDataUrl: outputDataUrl,
        styleRefDataUrl: null,
        styleMemo: '',
        objects: [],
      };
      skipHydrateOnce.current = true;
      setVersions((prev) => capVersions([...prev, ver]));
      setActiveVersionId(id);
      resetDraft();
      lastHydratedActiveId.current = id;
    },
    [resetDraft]
  );

  const selectVersion = useCallback(
    (id: string) => {
      lastHydratedActiveId.current = null;
      setActiveVersionId(id);
      const v = versions.find((x) => x.id === id);
      if (v) hydrateDraftFromVersion(v);
      lastHydratedActiveId.current = id;
    },
    [versions, hydrateDraftFromVersion]
  );

  const addObjectDraft = useCallback((imageDataUrl: string | null = null) => {
    const normalizedImageDataUrl =
      typeof imageDataUrl === 'string' && imageDataUrl.trim().length > 0 ? imageDataUrl : null;
    const o: AiEditObjectReference = {
      id: newObjectId(),
      imageDataUrl: normalizedImageDataUrl,
      placements: [],
      memo: '',
      placementMemos: [],
    };
    setDraftObjects((prev) => [...prev, o]);
    setActiveObjectId(o.id);
    setPlacementEditIndex(null);
  }, []);

  const removeObject = useCallback((id: string) => {
    setDraftObjects((prev) => prev.filter((o) => o.id !== id));
    setActiveObjectId((cur) => (cur === id ? null : cur));
    setPlacementEditIndex(null);
  }, []);

  const updateObjectMemo = useCallback((id: string, memo: string) => {
    setDraftObjects((prev) => prev.map((o) => (o.id === id ? { ...o, memo } : o)));
  }, []);

  const setStyleRef = useCallback((dataUrl: string | null) => {
    setDraftStyleRefDataUrl(dataUrl);
  }, []);

  /** 次の矩形描画を「追加」モードに */
  const setAppendPlacementMode = useCallback(() => {
    setPlacementEditIndex(null);
  }, []);

  /** 次の矩形描画で placements[i] を置換 */
  const setReplacePlacementMode = useCallback((objectId: string, index: number) => {
    setActiveObjectId(objectId);
    setPlacementEditIndex(index);
  }, []);

  const commitPlacementRect = useCallback((objectId: string, rect: NormalizedRect) => {
    const idx = placementEditIndexRef.current;
    setDraftObjects((prev) =>
      prev.map((o) => {
        if (o.id !== objectId) return o;
        if (idx === null) {
          return {
            ...o,
            placements: [...o.placements, rect],
            placementMemos: [...o.placementMemos, ''],
          };
        }
        if (idx >= 0 && idx < o.placements.length) {
          const next = [...o.placements];
          next[idx] = rect;
          return { ...o, placements: next };
        }
        return {
          ...o,
          placements: [...o.placements, rect],
          placementMemos: [...o.placementMemos, ''],
        };
      })
    );
    setPlacementEditIndex(null);
  }, []);

  const removePlacementAt = useCallback((objectId: string, index: number) => {
    setDraftObjects((prev) =>
      prev.map((o) =>
        o.id === objectId
          ? {
              ...o,
              placements: o.placements.filter((_, i) => i !== index),
              placementMemos: o.placementMemos.filter((_, i) => i !== index),
            }
          : o
      )
    );
  }, []);

  const updatePlacementMemo = useCallback((objectId: string, index: number, memo: string) => {
    setDraftObjects((prev) =>
      prev.map((o) => {
        if (o.id !== objectId) return o;
        const next = [...o.placementMemos];
        while (next.length < o.placements.length) next.push('');
        if (index < 0 || index >= next.length) return o;
        next[index] = memo;
        return { ...o, placementMemos: next };
      })
    );
  }, []);

  const updateObjectImage = useCallback((id: string, imageDataUrl: string | null) => {
    setDraftObjects((prev) => prev.map((o) => (o.id === id ? { ...o, imageDataUrl } : o)));
  }, []);

  /** 編集実行成功後に子バージョンを追加 */
  const appendVersionAfterEdit = useCallback(
    (params: {
      parentId: string;
      baseImageDataUrl: string;
      outputImageDataUrl: string;
      styleRefDataUrl: string | null;
      styleMemo: string;
      objects: AiEditObjectReference[];
    }) => {
      const id = newVersionId();
      const ver: AiEditVersion = {
        id,
        parentId: params.parentId,
        createdAt: Date.now(),
        baseImageDataUrl: params.baseImageDataUrl,
        outputImageDataUrl: params.outputImageDataUrl,
        styleRefDataUrl: params.styleRefDataUrl,
        styleMemo: params.styleMemo,
        objects: params.objects.map((o) => ({
          ...o,
          placements: o.placements.map((p) => ({ ...p })),
        })),
      };
      skipHydrateOnce.current = true;
      setVersions((prev) => capVersions([...prev, ver]));
      setActiveVersionId(id);
      resetDraft();
      lastHydratedActiveId.current = id;
    },
    [resetDraft]
  );

  useLayoutEffect(() => {
    if (!activeVersionId || versions.length === 0) return;
    if (skipHydrateOnce.current) {
      skipHydrateOnce.current = false;
      return;
    }
    if (lastHydratedActiveId.current === activeVersionId) return;
    const v = versions.find((x) => x.id === activeVersionId);
    if (v) hydrateDraftFromVersion(v);
    lastHydratedActiveId.current = activeVersionId;
  }, [activeVersionId, versions, hydrateDraftFromVersion]);

  const activeVersion = versions.find((v) => v.id === activeVersionId) ?? null;

  /**
   * 履歴を外部データ（プロジェクトごとの保存内容）で丸ごと置き換える（2a・写真AI編集の per-project 化）。
   * プロジェクト切替時に、そのプロジェクトに紐づく aiEdit を読み込むために使う。
   */
  const replaceAll = useCallback(
    (vers: AiEditVersion[], activeId: string | null) => {
      lastHydratedActiveId.current = null;
      skipHydrateOnce.current = false;
      const capped = capVersions(vers);
      setVersions(capped);
      setActiveVersionId(activeId ?? (capped.length ? capped[capped.length - 1].id : null));
      resetDraft();
    },
    [resetDraft],
  );

  /**
   * 指定の生成結果（版）を削除する（260625・暗黙的フィードバックの「削除」項目に対応）。
   * その子孫（再生成で連なった版）も連鎖削除して履歴ツリーが壊れないようにする。アクティブ版が消えた場合は
   * 下の再選択 effect が最新の残存版（または空＝null）へ自動で移す。versions 変化で store/cloud へ自動 persist。
   */
  const deleteVersion = useCallback((idToDelete: string) => {
    setVersions((prev) => {
      // 親保護（260630・クライアント要望）: この版から派生した子孫（AI生成画像）が残っている間は
      // 元画像（親）を削除しない（UI でもゴミ箱を非表示）。先に子を削除すれば親も削除できる。
      // 判定は連鎖ユーティリティで単一ソース化（size>1 = 自分以外に子孫が居る = ブロック）。
      if (collectVersionsToDelete(prev, idToDelete).size > 1) return prev;
      const target = prev.find((v) => v.id === idToDelete);
      if (!target) return prev;
      const survivors = prev.filter((v) => v.id !== idToDelete);
      // 容量解放（260629）: 削除する版が参照していた Storage 画像のうち、生き残る版が
      // まだ参照していないものだけを物理削除する（親の output= 子の base 等は残す）。
      const keep = new Set<string>();
      for (const v of survivors) {
        for (const u of [v.outputImageDataUrl, v.baseImageDataUrl, v.styleRefDataUrl]) {
          if (u) keep.add(u);
        }
      }
      const orphaned = [target.outputImageDataUrl, target.baseImageDataUrl, target.styleRefDataUrl].filter(
        (u): u is string => !!u && !keep.has(u),
      );
      if (orphaned.length > 0) void deleteAiRenderImages(orphaned); // 非同期・ベストエフォート
      return survivors;
    });
  }, []);

  const clearSession = useCallback(() => {
    lastHydratedActiveId.current = null;
    skipHydrateOnce.current = false;
    setVersions([]);
    setActiveVersionId(null);
    resetDraft();
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem('archviz-ai-edit-session-v1');
    } catch {
      /* ignore */
    }
  }, [resetDraft]);

  useEffect(() => {
    if (versions.length === 0) {
      // 全削除後など、版が無ければ選択を解除する（空配列だと再選択できないため明示的に null へ）。
      if (activeVersionId !== null) setActiveVersionId(null);
      return;
    }
    if (!activeVersionId || !versions.some((v) => v.id === activeVersionId)) {
      setActiveVersionId(versions[versions.length - 1].id);
    }
  }, [versions, activeVersionId]);

  useEffect(() => {
    // 写真AI編集（persistLocal=false）は localStorage を使わない（プロジェクト間の混入防止）。
    if (!persistLocal) return;
    if (versions.length === 0) {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      return;
    }
    // 各履歴は生成画像(データURL=大)を持つため、容量超過しやすい。超過時は古い順に間引いて
    // 「最新の履歴」を優先して保存する（最新を失わないように）。in-memory の versions は全件保持。
    let slice = versions;
    for (;;) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ versions: slice, activeVersionId }));
        return;
      } catch {
        if (slice.length <= 1) return; // これ以上は減らせない
        slice = slice.slice(Math.max(1, Math.floor(slice.length / 4))); // 最古側を間引いて再挑戦
      }
    }
  }, [versions, activeVersionId, persistLocal]);

  return {
    versions,
    activeVersionId,
    activeVersion,
    draftStyleRefDataUrl,
    setStyleRef,
    draftStyleMemo,
    setDraftStyleMemo,
    draftObjects,
    addObjectFromDataUrl: (imageDataUrl: string) => addObjectDraft(imageDataUrl),
    addObjectDraft,
    removeObject,
    updateObjectMemo,
    updateObjectImage,
    updatePlacementMemo,
    activeObjectId,
    setActiveObjectId,
    placementEditIndex,
    setAppendPlacementMode,
    setReplacePlacementMode,
    commitPlacementRect,
    removePlacementAt,
    addVersionFromRender,
    selectVersion,
    appendVersionAfterEdit,
    deleteVersion,
    clearSession,
    replaceAll,
    resetDraft,
  };
}
