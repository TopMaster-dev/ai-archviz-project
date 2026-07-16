import { useState, useRef, useEffect } from 'react';
import { RenderState } from '../types.js';
import { geminiAuthHeaders } from '../lib/byok.js';
import { recordAiUsage } from '../lib/db/aiUsage.js';
import { downscaleDataUrlIfNeeded } from '../utils/downscaleDataUrl.js';
import {
  PREVIEW_GEMINI_IMAGE_SIZE,
  PREVIEW_RENDER_MAX_SIDE,
} from '../utils/printExportSpec.js';
import { normalizeRenderAspectKey } from '../utils/renderAspect.js';
import { useProjectStore } from '../lib/store/projectStore.js';

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
  // 多重起動ガード（ボタンの disabled に依存せず、レンダー＝クレジットの二重消費を防ぐ・row 49/50）。
  const inFlightRef = useRef(false);

  const handleInstantRender = async (timeOfDay?: 'day' | 'evening' | 'night') => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setRenderState(prev => ({ ...prev, isRendering: true, generationLog: ["AIレンダリングを開始中..."] }));
    setSnapshotMode(true);
    setError(null);

    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise(resolve => setTimeout(resolve, 150));

    let successUrl: string | null = null;
    try {
      // メインの3Dルームキャンバスを確実に選ぶ（RoomViewer が onCreated で data-arise-room を付与）。
      // 3Dビュー中は家具サムネイル生成用の隠しキャンバス(256x256)が一時的にマウントされ、DOM 上で
      // ルームキャンバスより前に来るため、単純な querySelector('canvas') では真っ白/家具のミニ画像を
      // 掴んでしまい「手前の壁だけ/真っ白」なレンダー結果になる不具合があった（その上で編集すると失敗）。
      const canvas =
        (document.querySelector('canvas[data-arise-room]') as HTMLCanvasElement | null) ||
        Array.from(document.querySelectorAll('canvas'))
          .filter((c) => c.width > 256 && c.height > 256)
          .sort((a, b) => b.width * b.height - a.width * a.height)[0] ||
        document.querySelector('canvas');
      if (!canvas) throw new Error("Canvas not found");
      
      const rawImage = canvas.toDataURL('image/png');
      const previewImage = await downscaleDataUrlIfNeeded(rawImage, PREVIEW_RENDER_MAX_SIDE);

      // 3Dビューは選択比率にレターボックス表示され、キャプチャもその比率になる。生成比率を一致させて
      // 構図ズレ/引き伸ばしを防ぐ（第2段 260703・未指定は 16:9）。
      const aspectRatio = normalizeRenderAspectKey(useProjectStore.getState().camera.renderAspectRatio);

      const res = await fetch('/api/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...geminiAuthHeaders() },
        body: JSON.stringify({
          image: previewImage,
          prompt: 'フォトリアルな建築写真として仕上げてください。光の反射と質感を強調してください。',
          aspectRatio,
          imageSize: PREVIEW_GEMINI_IMAGE_SIZE,
          timeOfDay, // ユーザーが設定した時間帯（昼/夕方/夜）をレンダープロンプトへ反映（260717）
        }),
      });

      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Generation failed');

      // トークン計測（row 58・無効時は no-op）。レンダーは生成画像1枚。
      void recordAiUsage({ feature: 'render', usage: data.usage, model: data.model, imageCount: 1 });

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
      inFlightRef.current = false;
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
