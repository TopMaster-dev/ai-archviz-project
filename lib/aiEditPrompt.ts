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

/** NormalizedRect の外接矩形（多角形は頂点 min/max、矩形は x/y/width/height）を 0..1 で返す。 */
function bboxOf(r: NormalizedRect): { x: number; y: number; w: number; h: number } {
  if (r.points && r.points.length >= 3) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of r.points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    if ([minX, minY, maxX, maxY].every((v) => Number.isFinite(v))) {
      return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
    }
  }
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}

/**
 * 領域の座標テキスト（画像編集・キャプション生成で共通）。
 * 多角形マスクでも「矩形（左/上/幅/高さ）」で Gemini に伝える（260702 クライアント報告「多角形は精度が低い」対応）。
 * 画像モデルは頂点列より単純な矩形の方が遥かに正確に領域を把握できるため、矩形＝矩形指定と同等の精度になる。
 * 実際の多角形の形は表示側 compositeMaskedEdit で厳密にクリップするので、テキストが矩形でも最終出力は損失なし。
 * 「境界線を描かない」制約は buildAiEditConstitution 内に一度だけ置き、ここでは繰り返さない（多重指示で逆に線を誘発するのを防ぐ）。
 */
function formatPlacement(r: NormalizedRect): string {
  const b = bboxOf(r);
  return `左${(b.x * 100).toFixed(1)}%, 上${(b.y * 100).toFixed(1)}%, 幅${(b.w * 100).toFixed(1)}%, 高さ${(b.h * 100).toFixed(1)}%（画像全体に対する正規化座標）`;
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

  // エリア編集の精度（260702 クライアント要望）: ①指定領域内に指示内容を必ず生成する（未編集で返さない）、
  // ②重なった家具は最も手前の対象だけを編集し、手前/周囲の別家具は奥行き・位置・形状を保持する。
  const overlapNote = hasAreaEdits
    ? '\n- 指定領域（矩形）内には、指示された編集内容を必ず明確に反映した結果を生成する。領域内を未編集・空欄・無変化のまま返さない。指示に沿った家具/仕上げ/オブジェクトを、ベース画像の遠近（パース）・スケール・光の向きに整合させて領域内にしっかり描画する。' +
      '\n- 指定領域に複数の家具が重なって写る場合は、その領域で最も手前に写っている対象オブジェクトのみを編集し、その手前や周囲にある別の家具（テーブル・椅子・観葉植物等）は前後関係（奥行き）・位置・形状を文脈として保持する（別物に置き換えたり溶かし込んだりしない）。'
    : '';

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
    ? '各オブジェクト参照画像を、テキストで指定した領域（正規化座標）に従って合成する。領域ごとに、シルエット・アームの形状・脚・生地のリブや柄・プロポーションなど、家具・小物の見た目のデザインは参照画像を正とする。ベース該当領域の既存家具の輪郭を保持したままの上塗りやテクスチャ転写、および形状の妥協的合成は行わない。領域外はベース画像を完全に保持し、指示にない既存の要素（家具・植物・装飾・小物・ドライフラワー等）を新たに追加・複製・増殖・拡大・改変しない。**配置座標と別途記載の短い日本語説明が食い違う場合は、位置・スケールの解釈では座標を必ず優先する。形状・材質の参照はオブジェクト参照画像に従う。**'
    : 'テキストで指定した複数領域（正規化座標）を厳密に編集し、領域外はベース画像を完全に保持し、指示にない既存の要素（家具・植物・装飾・小物・ドライフラワー等）を新たに追加・複製・増殖・拡大・改変しない。**配置座標の指定が、別途記載の短い日本語説明と食い違う場合は、座標を必ず優先する。**';

  return `
あなたは建築インテリアのAI編集エンジンです。次のルールを最優先で守ってください。

【絶対に変えない】
- 空間の形・寸法・カメラの画角・透視
- 壁・床・天井などの内装仕上げ（材種・柄・タイル目地・塗色・壁紙）を別素材に差し替えない
- 2D/3D図面で配置済みの窓・サッシ・ドア（建具）を勝手に追加・削除・移動・本数変更しない（既存建具の色・素材など見た目の変更のみ可）
- ドア（開き戸・引き戸）の正面・可動範囲・出入り動線上には家具・小物を配置しない（動線を塞がない）
- 参照画像のスタイルやオブジェクトを理由に、仕上げ材をコピーして全面に適用しない
- **出力画像に、単色の矩形・マスク・補助図形・凡例・座標グリッド・UI風の色面を一切含めない。フォトリアルな完成写真のみを出力する。**
- **編集領域・多角形・選択範囲の境界線（輪郭・ふち取り・ハイライト・うっすらした白や明色の線、色や明るさの段差）を出力に一切描画しない。編集は指定領域の内側に限定したまま、内縁付近で色・明るさをなだらかに変化させて非編集領域へ自然に溶け込ませ、はっきりした継ぎ目や線を作らない。**
- **ベース画像に過去の編集由来のうっすらした輪郭線・境界線・マスクの跡が残っている場合は、それらを周囲の質感・色に馴染ませて完全に消去し痕跡を残さない。ただし実在する細い影・配線・吊り線・目地・サッシなど本物の要素は消さない。**

【変更してよい範囲】
${MODE_INSTRUCTIONS[mode]}${overlapNote}

【参照画像の扱い】
- ベース画像: ${baseImageLine}
- スタイル参照がある場合: 照明の色温度・コントラスト・写真の「空気感」のみ参考にし、壁床天井のマテリアルはベース画像に厳密に一致させる
- オブジェクト参照がある場合: ${objectRefLine}${reflectNote}
出力: 編集後の最終画像1枚のみを高品質で生成する。
`.trim();
}

/** 「継ぎ目をなじませる（全体を1枚に均一化）」仕上げパスの有効化フラグ（キルスイッチ・260706）。false で UI から隠す。 */
export const ENABLE_HARMONIZE_FLATTEN = true;

/**
 * 「継ぎ目をなじませる」全体仕上げパス用プロンプト（260706 クライアント提案）。
 * 入力は一部領域を別生成して貼り合わせた画像で、境界に露出・WB・明るさのわずかな段差が残ることがある。
 * 唯一の仕事は継ぎ目を消し全体を1枚の自然な写真に均一化すること。構図・オブジェクト・仕上げ材・色は一切変えない。
 * ※創作系プロンプト（proVisualizer 等）は使わない＝全体ドリフト防止。呼び出しは低温度で。
 */
export function buildHarmonizePrompt(): string {
  return `
あなたは画像の継ぎ目を消す「合成仕上げ」専門のAIです。入力画像は、一部の領域だけを別に生成して貼り合わせたもので、その境界に露出・ホワイトバランス・明るさのわずかな段差（継ぎ目・境界線）が残っている場合があります。あなたの唯一の仕事は、この継ぎ目を消して全体を1枚の自然な写真として均一に仕上げることです。

【絶対に変えない】
- 構図・カメラの画角・透視
- 家具・小物・建具・植物・照明器具の位置・形状・数・種類（追加・削除・複製・移動をしない）
- 壁・床・天井の仕上げ材・柄・色、テクスチャ（別素材へ置換したり描き直したりしない）
- 照明の向き・光源の位置
- 出力に矩形・マスク・補助図形・UI風の色面・境界線を一切含めない

【やること】
- 境界付近の露出・ホワイトバランス・明るさ・色温度だけを画像全体でなだらかに連続させ、段差・線・むらを消す
- 変更は最小限に留める。継ぎ目が見当たらない場合は、ほぼ入力のまま返す

出力: 継ぎ目をなじませた最終画像1枚のみを、フォトリアルに生成する。
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
- 空間の形・寸法・天井高・開口（窓/ドア/サッシ）の位置と本数・カメラの画角と透視（建具を勝手に追加・削除・移動しない）
- ドア（開き戸・引き戸）の正面・可動範囲・出入り動線上には家具・小物・ラグを配置しない（動線を塞がない）
- 部屋そのものが別の部屋にならないこと（同じ空間のスタイル変更に留める）
- 出力に矩形・マスク・補助図形・凡例・UI風の色面を一切含めない。フォトリアルな完成写真のみを出力する。
- 編集領域・選択範囲の境界線（輪郭・うっすらした白や明色の線・色や明るさの段差）を描画しない。ベース画像に過去の編集由来の輪郭線・境界線の跡が残っている場合は周囲に馴染ませて消去する（実在する細い影・配線・吊り線・目地・サッシなど本物の要素は消さない）。

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
  // プロンプトインジェクション対策: 改行・制御文字を除去し空白を畳んで1行の短い意匠フレーズに正規化、
  // 1件あたり長さも上限化する（学習ヒントはユーザー由来テキストのため、構造突破を許さない）。
  const hints = (learnedHints ?? [])
    .map((h) => Array.from(h).map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch)).join('').replace(/ +/g, ' ').trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 5);
  if (hints.length === 0) return prompt;
  return `${prompt}

【参考: 高評価が多い意匠の傾向（あなたの好み＋全体の傾向の参考。強制ではない）】
- ${hints.join('\n- ')}
上記は好みの参考に留め、今回の指示・配置座標・ベース画像との整合を最優先すること。`;
}

export function buildAiEditReferenceGuide(params: {
  hasStyle: boolean;
  /** スタイル参照画像の枚数（複数対応・260707）。未指定なら hasStyle から 0/1 を推定。 */
  styleImageCount?: number;
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
  const styleCount = params.styleImageCount ?? (params.hasStyle ? 1 : 0);
  if (styleCount > 0) {
    if (styleCount === 1) {
      lines.push(`画像${idx}: スタイル・空気感の参照（ムードのみ参考、仕上げコピー禁止）`);
    } else {
      lines.push(
        `画像${idx}〜${idx + styleCount - 1}: スタイル・空気感の参照 ${styleCount}枚（いずれもムードのみ参考、仕上げコピー禁止。複数ある場合は共通する雰囲気・方向性を汲む）`
      );
    }
    if (params.styleMemo?.trim()) {
      lines.push(`  スタイル参照への補足: ${params.styleMemo.trim()}`);
    }
    idx += styleCount;
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

  // スタイル参照画像が無い「テキストのみのコーディネート指示」も必ずプロンプトへ反映する。
  // hasStyle=false のとき従来は styleMemo が落ちて指示が無視されていた（260702 クライアント指摘: プロンプトが読まれない）。
  // エリア編集は styleMemo を送らないため（機能独立）、ここに来るのは全体コーディネートのテキスト指示のみ。
  if (!params.hasStyle && !hasObjects && params.styleMemo?.trim()) {
    lines.push('');
    lines.push(`【ユーザーの編集指示（空間全体・最優先で反映する）】\n${params.styleMemo.trim()}`);
  }

  lines.push('');
  lines.push('上記に従い、ベース画像を編集した1枚の画像を生成してください。');

  return appendLearnedHints(lines.join('\n'), params.learnedHints);
}
