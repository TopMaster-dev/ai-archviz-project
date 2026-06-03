import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AiEditObjectReference, AiEditVersion, NormalizedRect } from '../types.js';
import { normalizeStoredVersions } from '../lib/aiEditNormalize.js';

function newObjectId() {
  return `obj_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function newVersionId() {
  return `ver_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

const STORAGE_KEY = 'archviz-ai-edit-session-v2';

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

export function useAiEditSession() {
  const [versions, setVersions] = useState<AiEditVersion[]>(() => loadStored()?.versions ?? []);
  const [activeVersionId, setActiveVersionId] = useState<string | null>(
    () => loadStored()?.activeVersionId ?? null
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

  /** 初回 AI レンダリング成功時: 履歴 v0 を作成 */
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
      setVersions([ver]);
      setActiveVersionId(id);
      resetDraft();
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
      setVersions((prev) => [...prev, ver]);
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
    if (versions.length === 0) return;
    if (!activeVersionId || !versions.some((v) => v.id === activeVersionId)) {
      setActiveVersionId(versions[versions.length - 1].id);
    }
  }, [versions, activeVersionId]);

  useEffect(() => {
    try {
      if (versions.length === 0) {
        localStorage.removeItem(STORAGE_KEY);
        return;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ versions, activeVersionId }));
    } catch {
      /* quota */
    }
  }, [versions, activeVersionId]);

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
    clearSession,
    resetDraft,
  };
}
