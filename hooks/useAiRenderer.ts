import { useState, useRef, useEffect } from 'react';
import { RenderState } from '../types.js';
import { downscaleDataUrlIfNeeded } from '../utils/downscaleDataUrl.js';
import {
  PREVIEW_ASPECT_RATIO,
  PREVIEW_GEMINI_IMAGE_SIZE,
  PREVIEW_RENDER_MAX_SIDE,
} from '../utils/printExportSpec.js';

export type UseAiRendererOptions = {
  /** キャンバスからの AI レンダリング成功時（編集セッションの v0 シード用など） */
  onCanvasRenderSuccess?: (dataUrl: string) => void;
};

export function useAiRenderer(options?: UseAiRendererOptions) {
  const onSuccessRef = useRef(options?.onCanvasRenderSuccess);
  useEffect(() => {
    onSuccessRef.current = options?.onCanvasRenderSuccess;
  }, [options?.onCanvasRenderSuccess]);
  const [renderState, setRenderState] = useState<RenderState>({
    isRendering: false,
    resultImageUrl: null,
    generationLog: []
  });
  const [captureStep, setCaptureStep] = useState<'idle' | 'pt-base' | 'mask'>('idle');
  const [snapshotMode, setSnapshotMode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleInstantRender = async () => {
    setRenderState(prev => ({ ...prev, isRendering: true, generationLog: ["AIレンダリングを開始中..."] }));
    setSnapshotMode(true);
    setError(null);

    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise(resolve => setTimeout(resolve, 150));

    let successUrl: string | null = null;
    try {
      const canvas = document.querySelector('canvas');
      if (!canvas) throw new Error("Canvas not found");
      
      const rawImage = canvas.toDataURL('image/png');
      const previewImage = await downscaleDataUrlIfNeeded(rawImage, PREVIEW_RENDER_MAX_SIDE);

      const res = await fetch('/api/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: previewImage,
          prompt: 'フォトリアルな建築写真として仕上げてください。光の反射と質感を強調してください。',
          aspectRatio: PREVIEW_ASPECT_RATIO,
          imageSize: PREVIEW_GEMINI_IMAGE_SIZE,
        }),
      });

      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Generation failed');

      successUrl = data.url;
      setRenderState(prev => ({
        ...prev,
        resultImageUrl: data.url,
        generationLog: [...prev.generationLog, `AI Rendered: ${new Date().toLocaleTimeString()}`],
      }));
    } catch (e: any) {
      console.error(e);
      setError(e.message);
      alert(`エラー: ${e.message}`);
    } finally {
      setRenderState(prev => ({ ...prev, isRendering: false }));
      setSnapshotMode(false);
      if (successUrl) onSuccessRef.current?.(successUrl);
    }
  };

  return {
    renderState,
    setRenderState,
    captureStep,
    setCaptureStep,
    snapshotMode,
    setSnapshotMode,
    error,
    setError,
    handleInstantRender,
  };
}
