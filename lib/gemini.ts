import type { AiEditObjectReference } from '../types.js';
import { buildAiEditReferenceGuide, describeObjectPlacements } from './aiEditPrompt.js';

export const GEMINI_IMAGE_MODEL = 'gemini-3-pro-image-preview';

/** 配置説明用 Flash モデル（サーバー側 `process.env.GEMINI_PLACEMENT_CAPTION_MODEL` で上書き） */
export function resolvePlacementCaptionModel(): string {
  return (
    (typeof process !== 'undefined' && process.env?.GEMINI_PLACEMENT_CAPTION_MODEL?.trim()) ||
    'gemini-2.0-flash'
  );
}

export function parseImageDataUrl(dataUrl: string): { mimeType: string; base64: string } {
  const m = dataUrl.match(/^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i);
  if (m) {
    return { mimeType: m[1], base64: m[2] };
  }
  const stripped = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  return { mimeType: 'image/png', base64: stripped };
}

/** ベース画像と配置座標から、オブジェクトごとの短い日本語位置説明を生成（失敗時は {}） */
export async function generatePlacementNarratives(
  apiKey: string,
  params: { baseImageDataUrl: string; objects: AiEditObjectReference[] }
): Promise<Record<string, string>> {
  if (!params.objects.length) return {};

  const spec = params.objects
    .map((o, i) => {
      const pid = JSON.stringify(o.id);
      return `- objectId: ${pid} / 参照番号: ${i + 1} / 配置: ${describeObjectPlacements(o)}`;
    })
    .join('\n');

  const userText = `あなたは建築インテリアの画像編集アシスタントです。次の「ベース画像」を見て、各 objectId の配置矩形が空間のどこに当たるか、日本語で短い位置説明を付けてください。
説明はインテリア向けに自然な言い方で、1オブジェクトあたり40文字以内。配置座標の数値は繰り返さない。

【配置仕様（正規化座標は優先。説明は参考用）】
${spec}

次の JSON のみを返してください。前後に説明文やマークダウンを付けないこと。
{"descriptions":[{"objectId":"<idと同じ文字列>","text":"<日本語1行>"}]}`;

  const base = parseImageDataUrl(params.baseImageDataUrl);
  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: userText },
          { inlineData: { mimeType: base.mimeType, data: base.base64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.35,
      responseModalities: ['TEXT'],
    },
  };

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${resolvePlacementCaptionModel()}:generateContent`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return {};
    const result = await response.json();
    const raw = result.candidates?.[0]?.content?.parts?.find((p: { text?: string }) => p.text)?.text;
    if (!raw || typeof raw !== 'string') return {};
    return parsePlacementNarrativesJson(raw);
  } catch {
    return {};
  }
}

function parsePlacementNarrativesJson(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```$/m);
  if (fence) s = fence[1].trim();
  try {
    const parsed = JSON.parse(s) as { descriptions?: Array<{ objectId?: string; text?: string }> };
    const arr = parsed.descriptions;
    if (!Array.isArray(arr)) return {};
    for (const row of arr) {
      if (row && typeof row.objectId === 'string' && typeof row.text === 'string') {
        out[row.objectId] = row.text.trim();
      }
    }
  } catch {
    return {};
  }
  return out;
}

export interface AgentChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * AIエージェント相談（建築・内装デザインのアドバイス）。Flash モデルでテキスト応答（管理表 row 208/214）。
 * 直近の会話履歴を contents に変換し、最新のユーザー発話にだけ現在の画像を参考添付する。
 */
export async function generateAgentReply(
  apiKey: string,
  params: { messages: AgentChatMessage[]; imageDataUrl?: string | null }
): Promise<string> {
  const system = `あなたは建築・内装に精通したプロのAIデザインアドバイザーです。Arise（2D作図→3D→AIパース→概算見積もりの空間デザインツール）のユーザーを支援します。
- 配色・素材・家具・照明・レイアウト・コーディネート、見積もりや進め方の相談に、日本語で具体的かつ実務的に助言する。
- 不要な前置きは避け、要点は短い段落や箇条書きで簡潔に。
- 画像が添付されている場合は、その空間を踏まえて助言する。`;

  const lastIdx = params.messages.length - 1;
  const contents = params.messages.map((m, i) => {
    const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
      { text: m.content },
    ];
    if (m.role === 'user' && i === lastIdx && params.imageDataUrl) {
      const img = parseImageDataUrl(params.imageDataUrl);
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
    }
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });

  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { temperature: 0.6, responseModalities: ['TEXT'] },
  };
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${resolvePlacementCaptionModel()}:generateContent`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const t = await response.text().catch(() => '');
    throw new Error(`エージェント応答の取得に失敗しました (${response.status}) ${t.slice(0, 200)}`);
  }
  const result = await response.json();
  const text = result.candidates?.[0]?.content?.parts?.find((p: { text?: string }) => p.text)?.text;
  if (!text || typeof text !== 'string') throw new Error('エージェントの応答が空でした。');
  return text.trim();
}

/** マルチ参照対応のインテリア編集（ベース + スタイル0〜1 + オブジェクト複数） */
export async function generateGeminiImageEdit(
  apiKey: string,
  params: {
    baseImageDataUrl: string;
    styleImageDataUrl: string | null;
    styleMemo?: string;
    objects: AiEditObjectReference[];
    /** Gemini imageConfig.aspectRatio（例: 16:9） */
    aspectRatio?: string;
    /** 例: 1K, 2K, 4K */
    imageSize?: string;
    placementNarratives?: Record<string, string>;
    /** コーディネート（完全お任せ）モード。個別指定なしで空間全体を再コーディネート（row 207/213）。 */
    coordinate?: boolean;
  }
): Promise<string> {
  const instruction = buildAiEditReferenceGuide({
    hasStyle: !!params.styleImageDataUrl,
    styleMemo: params.styleMemo?.trim() || undefined,
    objects: params.objects,
    placementNarratives: params.placementNarratives,
    coordinate: params.coordinate,
  });

  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
    { text: instruction },
  ];

  const base = parseImageDataUrl(params.baseImageDataUrl);
  parts.push({
    inlineData: { mimeType: base.mimeType, data: base.base64 },
  });

  if (params.styleImageDataUrl) {
    const st = parseImageDataUrl(params.styleImageDataUrl);
    parts.push({
      inlineData: { mimeType: st.mimeType, data: st.base64 },
    });
  }

  for (const o of params.objects) {
    if (!o.imageDataUrl) continue;
    const ob = parseImageDataUrl(o.imageDataUrl);
    parts.push({
      inlineData: { mimeType: ob.mimeType, data: ob.base64 },
    });
  }

  const aspectRatio = params.aspectRatio || '16:9';
  const imageSize = params.imageSize || '2K';

  const payload = {
    contents: [
      {
        role: 'user',
        parts,
      },
    ],
    generationConfig: {
      temperature: 0.25,
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio,
        imageSize,
      },
    },
  };

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API 通信エラー: ${response.status} - ${errText}`);
  }

  const result = await response.json();
  const candidate = result.candidates?.[0];
  if (!candidate?.content?.parts?.length) {
    throw new Error('No candidates returned from Gemini API');
  }

  let dataUrl = '';
  for (const part of candidate.content.parts) {
    if (part.inlineData?.data && part.inlineData?.mimeType) {
      dataUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
      break;
    }
    if (part.text?.includes('data:image')) {
      dataUrl = part.text;
      break;
    }
  }

  if (!dataUrl) {
    throw new Error('Could not extract image data from response.');
  }
  return dataUrl;
}

export type GeminiClayRenderOptions = {
  aspectRatio?: string;
  imageSize?: string;
};

export async function generateGeminiImage(
  apiKey: string,
  baseImageBase64: string,
  userInstruction: string = '',
  options?: GeminiClayRenderOptions
) {
  const proVisualizerPrompt = `
1. 役割と専門性
あなたは、建築ビジュアライゼーション（Architectural Visualization）に特化した、世界最高峰のAIレタッチ・エンジニアです。
ユーザーがアップロードする画像を読み取り、画角や構図、テクスチャの意匠、色、パターンを100%維持しながら、実写写真のような質感、反射、空気感を付与した画像を生成・提案することが任務です。

2. 画質とカメラ設定の共通定義
すべての画像生成において、以下の「物理的なカメラ設定」を前提としてください。
カメラ: 高性能デジタル一眼レフ（DSLR）、35mm単焦点レンズ。
設定: 絞り値 f/8、ISO 100。室内の明るさに露出を合わせてください。
品質: 8k解像度、極めて精細なディテール、フォトリアル、建築写真クオリティ。

3. テクスチャ保護（最優先事項）
ユーザーの意匠を尊重するため、以下のルールを厳守してください。
非破壊的向上: 元の画像のテクスチャ（木目、布の柄、タイルの割り付け、色味）を勝手に変更したり、別の素材に置き換えたりしないでください。
ディテール強化: 素材を「変える」のではなく、表面の微細な凹凸（マイクロサーフェス）、光沢、反射のみを強調してください。
パースの維持: 直線的な建具のラインや家具のスケール感を歪ませないでください。

4. ライティングと影の処理
元の画像はフラットなベースカラー画像です。あなたは自然な太陽光やダウンライトの環境光（Global Illumination）、およびリアルな影（Ambient Occlusion）をゼロから計算して美しく描き込んでください。
元の画像に含まれる物理的なライティング（パストレーシングによる光の回り込み）を正解として扱ってください。
間接照明: 壁や天井の隅（アンビエントオクルージョン）の自然な陰影を深めてください。
反射: 床や金属面への映り込み（レイトレーシング反射）をより鮮明に、かつリアルに表現してください。

5. 窓と屋外風景（時間帯）の表現
元の画像における「窓ガラス」の越しの背景色を基準に、屋外の時間帯と風景を推論して描き込んでください。
- 窓が「白や明るい色」の場合：自然光があふれる昼の風景（青空、樹木など）。室内に露出を合わせたカメラの性質を再現し、やや白飛び気味（オーバーエクスポージャー）で柔らかく表現してください。
- 窓が「黒や暗い色」の場合：夜の風景（暗い空、遠くの街明かりなど）。室内照明が窓ガラスに反射する様子や、夜特有の落ち着いた空気感を描写してください。
- 窓が「オレンジや暖色系」の場合：夕景やマジックアワーの風景（美しい夕焼け空など）。暖かみのある夕日が室内に差し込む様子を表現してください。
いずれの時間帯においても、風景は主張しすぎず、室内のライティング（床に落ちる光や影）と完全に矛盾しないように自然に馴染ませてください。

${userInstruction}
`;

  const genCfg: Record<string, unknown> = {
    temperature: 0.2,
    responseModalities: ['IMAGE'],
  };
  if (options?.aspectRatio?.trim() || options?.imageSize?.trim()) {
    genCfg.imageConfig = {
      aspectRatio: options?.aspectRatio?.trim() || '16:9',
      imageSize: options?.imageSize?.trim() || '2K',
    };
  }

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: proVisualizerPrompt },
          {
            inlineData: {
              mimeType: 'image/png',
              data: baseImageBase64,
            },
          },
        ],
      },
    ],
    generationConfig: genCfg,
  };

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API 通信エラー: ${response.status} - ${errText}`);
  }

  const result = await response.json();
  const candidate = result.candidates?.[0];
  if (!candidate?.content?.parts?.length) {
    throw new Error('No candidates returned from Gemini API');
  }

  let dataUrl = '';
  for (const part of candidate.content.parts) {
    if (part.inlineData?.data && part.inlineData?.mimeType) {
      dataUrl = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
      break;
    }
    if (part.text?.includes('data:image')) {
      dataUrl = part.text;
      break;
    }
  }

  if (!dataUrl) throw new Error('Could not extract image data from response.');
  return dataUrl;
}
