import type { AiEditMode, AiEditObjectReference, NormalizedRect } from '../types.js';

const MODE_INSTRUCTIONS: Record<AiEditMode, string> = {
  lighting_atmosphere:
    '時間帯・ライティング・空気感（ムード）を中心に調整する。建具・家具の大きな形状変更は行わない。',
  furniture_fixture:
    '家具・小物・造作の差し替え・追加・複数配置を行う。空間の形・開口位置は維持する。オブジェクト参照画像があるときは、その家具のデザイン・シルエットを参照画像に合わせる（ベースの下絵形状に縛られない）。',
  joinery:
    '建具（サッシ・ドア等）の見た目の変更に限定する。壁・床・天井の仕上げは変えない。',
};

/** スタイル/オブジェクトの有無からプロンプト用モードを自動決定（UIには出さない） */
export function resolvePromptMode(hasStyle: boolean, hasObjects: boolean): AiEditMode {
  if (hasObjects) return 'furniture_fixture';
  if (hasStyle) return 'lighting_atmosphere';
  return 'lighting_atmosphere';
}

function formatPlacement(r: NormalizedRect): string {
  return `左${(r.x * 100).toFixed(1)}%, 上${(r.y * 100).toFixed(1)}%, 幅${(r.width * 100).toFixed(1)}%, 高さ${(r.height * 100).toFixed(1)}%（画像全体に対する正規化座標）`;
}

/** オブジェクト1件の配置テキスト（画像編集・キャプション生成で共通） */
export function describeObjectPlacements(o: AiEditObjectReference): string {
  if (o.placements.length === 0) {
    return '配置矩形未指定（画像内の適切な位置に自然に配置）';
  }
  if (o.placements.length === 1) {
    return `配置: ${formatPlacement(o.placements[0])}`;
  }
  return o.placements.map((p, j) => `領域${j + 1}: ${formatPlacement(p)}`).join(' / ');
}

function buildAiEditConstitution(
  mode: AiEditMode,
  opts?: { hasAreaEdits?: boolean; hasObjectRefs?: boolean }
): string {
  const hasAreaEdits = !!opts?.hasAreaEdits;
  const hasObjectRefs = !!opts?.hasObjectRefs;

  const reflectNote = hasObjectRefs
    ? `

【オブジェクト合成時の反射（任意の整合）】
- オブジェクト参照の合成に伴い、鏡・床・ガラスなどへの映り込みが物理的に矛盾する場合、当該反射のみをベース空間と整合するよう更新してよい。
- 壁・床・天井の仕上げを別素材に差し替えたり、カメラや空間の幾何を変えない。`
    : '';

  const baseImageLine = hasAreaEdits
    ? '空間の箱・開口・カメラの画角・透視、および壁・床・天井の仕上げの正解データとして扱う。配置座標で指定した領域に写っている既存の家具・小物は差し替え対象であり、そのシルエットをベースに維持する必要はない（対応するオブジェクト参照画像の形状・材質表現に従ってよい）。'
    : '編集対象の元画像（幾何・仕上げの正解データとして扱う）';

  const objectRefLine = hasObjectRefs
    ? '各オブジェクト参照画像を、テキストで指定した領域（正規化座標）に従って合成する。領域ごとに、シルエット・アームの形状・脚・生地のリブや柄・プロポーションなど、家具・小物の見た目のデザインは参照画像を正とする。ベース該当領域の既存家具の輪郭を保持したままの上塗りやテクスチャ転写、および形状の妥協的合成は行わない。領域外はベース画像を維持する。**配置座標と別途記載の短い日本語説明が食い違う場合は、位置・スケールの解釈では座標を必ず優先する。形状・材質の参照はオブジェクト参照画像に従う。**'
    : 'テキストで指定した複数領域（正規化座標）を厳密に編集し、領域外はベース画像を維持する。**配置座標の指定が、別途記載の短い日本語説明と食い違う場合は、座標を必ず優先する。**';

  return `
あなたは建築インテリアのAI編集エンジンです。次のルールを最優先で守ってください。

【絶対に変えない】
- 空間の形・寸法・カメラの画角・透視
- 壁・床・天井などの内装仕上げ（材種・柄・タイル目地・塗色・壁紙）を別素材に差し替えない
- 参照画像のスタイルやオブジェクトを理由に、仕上げ材をコピーして全面に適用しない
- **出力画像に、単色の矩形・マスク・補助図形・凡例・座標グリッド・UI風の色面を一切含めない。フォトリアルな完成写真のみを出力する。**

【変更してよい範囲】
${MODE_INSTRUCTIONS[mode]}

【参照画像の扱い】
- ベース画像: ${baseImageLine}
- スタイル参照がある場合: 照明の色温度・コントラスト・写真の「空気感」のみ参考にし、壁床天井のマテリアルはベース画像に厳密に一致させる
- オブジェクト参照がある場合: ${objectRefLine}${reflectNote}
出力: 編集後の最終画像1枚のみを高品質で生成する。
`.trim();
}

/**
 * コーディネート（完全お任せ）モードのプロンプト（管理表 row 207/213）。
 * ユーザーの個別指定なしに、空間全体を魅力的に再コーディネートする。
 * 部屋の形・寸法・開口・カメラは維持し、家具/装飾/演出を一新する。
 */
export function buildCoordinatePrompt(): string {
  return `
あなたは経験豊富なインテリアコーディネーター兼建築ビジュアライゼーションのAIです。
ベース画像の空間を、お任せで魅力的に「再コーディネート」してください。

【絶対に変えない】
- 空間の形・寸法・天井高・開口（窓/ドア）の位置・カメラの画角と透視
- 部屋そのものが別の部屋にならないこと（同じ空間のスタイル変更に留める）
- 出力に矩形・マスク・補助図形・凡例・UI風の色面を一切含めない。フォトリアルな完成写真のみを出力する。

【お任せで提案してよい範囲】
- 家具・ラグ・カーテン等のファブリック・照明器具・アート・観葉植物・小物の選定と配置
- 配色・素材感・照明演出（時間帯/ムード）による空間全体のコーディネート
- 全体として調和の取れた、実在感のある上質なインテリアにまとめる

出力: 再コーディネート後の最終画像1枚のみを高品質・フォトリアルに生成する。
`.trim();
}

/**
 * in-context反映（管理表 row 211/219・フェーズ1）: ユーザーが過去に高評価した傾向を参考としてプロンプト末尾に添える。
 * あくまで参考であり、今回の指示・座標・ベース画像の整合を最優先する旨を明記する。
 */
function appendLearnedHints(prompt: string, learnedHints?: string[]): string {
  const hints = (learnedHints ?? []).map((h) => h.trim()).filter(Boolean).slice(0, 5);
  if (hints.length === 0) return prompt;
  return `${prompt}

【参考: このユーザーが過去に高評価した傾向（好みの参考・強制ではない）】
- ${hints.join('\n- ')}
上記は好みの参考に留め、今回の指示・配置座標・ベース画像との整合を最優先すること。`;
}

export function buildAiEditReferenceGuide(params: {
  hasStyle: boolean;
  styleMemo?: string;
  objects: AiEditObjectReference[];
  /** objectId → AI が生成した位置説明（参考）。座標が優先。 */
  placementNarratives?: Record<string, string>;
  /** コーディネート（完全お任せ）モード。true のとき個別指定を無視し全体を再コーディネートする。 */
  coordinate?: boolean;
  /** in-context反映（row 211/219）: 過去に高評価した傾向（styleMemo）。プロンプト末尾に参考添付。 */
  learnedHints?: string[];
}): string {
  if (params.coordinate) return appendLearnedHints(buildCoordinatePrompt(), params.learnedHints);
  const hasObjects = params.objects.length > 0;
  const hasObjectRefs = params.objects.some((o) => !!o.imageDataUrl);
  const mode = resolvePromptMode(params.hasStyle, hasObjects);
  const narr = params.placementNarratives ?? {};
  const lines: string[] = [
    buildAiEditConstitution(mode, { hasAreaEdits: hasObjects, hasObjectRefs }),
    '',
  ];

  lines.push('【入力画像の順序】');
  lines.push('画像1: ベース（編集対象）');

  let idx = 2;
  if (params.hasStyle) {
    lines.push(`画像${idx}: スタイル・空気感の参照（ムードのみ参考、仕上げコピー禁止）`);
    if (params.styleMemo?.trim()) {
      lines.push(`  スタイル参照への補足: ${params.styleMemo.trim()}`);
    }
    idx++;
  }

  params.objects.forEach((o, i) => {
    if (o.imageDataUrl) {
      lines.push(`画像${idx}: エリア編集の参照画像${i + 1}`);
      idx++;
    }
    const placeDesc = describeObjectPlacements(o);
    const memo = o.memo?.trim() ? `全体補足: ${o.memo.trim()}` : '';
    const shortN = narr[o.id]?.trim();
    const narLine = shortN
      ? ` AIによる位置説明（参考・座標と矛盾する場合は座標を優先）: ${shortN}`
      : '';
    lines.push(
      `エリア編集${i + 1}: ${placeDesc}。${narLine}${memo ? ` ${memo}` : ''}${
        o.imageDataUrl ? '（参照画像あり）' : '（テキストのみ）'
      }`
    );
  });

  lines.push('');
  lines.push('上記に従い、ベース画像を編集した1枚の画像を生成してください。');

  return appendLearnedHints(lines.join('\n'), params.learnedHints);
}
