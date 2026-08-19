/**
 * 16:9 書き出し: A3 の長辺（420mm）× DPI を長辺ピクセルとし、幅×高さ = 長辺 × round(長辺×9/16)。
 */
export function longEdgePxForA3Dpi(dpi: number): number {
  return Math.round((420 / 25.4) * dpi);
}

export type ExportPreset16x9 = {
  id: string;
  dpi: number;
  label: string;
  width: number;
  height: number;
};

function buildPreset(dpi: number, label: string): ExportPreset16x9 {
  const width = longEdgePxForA3Dpi(dpi);
  const height = Math.max(1, Math.round((width * 9) / 16));
  return { id: String(dpi), dpi, label, width, height };
}

/** 高解像書き出しの選択肢（DPI は A3 長辺換算の目安） */
export const EXPORT_PRESETS_16_9: ExportPreset16x9[] = [
  buildPreset(300, '美術印刷・近くで見るポスター'),
  buildPreset(250, '一般的なカタログ・プレゼン用'),
  buildPreset(200, '離れて見る・コスト優先'),
  buildPreset(150, '最低限'),
];

/** 300dpi 相当の長辺（後方互換・他モジュール用） */
export const PRINT_EXPORT_LONG_EDGE_PX = EXPORT_PRESETS_16_9[0]!.width;

/**
 * 任意比率の書き出しプリセット（第2段・260703）。長辺を A3（420mm）× dpi 相当のピクセルにし、
 * 比率(ratioValue=幅/高さ)から短辺を導く。横長は幅＝長辺、縦長は高さ＝長辺（向きを保つ）。
 * ratioValue=16/9 のときは EXPORT_PRESETS_16_9 と同一寸法になる（後方互換）。
 */
export function exportPresetsForRatio(ratioValue: number): ExportPreset16x9[] {
  const r = ratioValue > 0 ? ratioValue : 16 / 9;
  const labels: Array<[number, string]> = [
    [300, '美術印刷・近くで見るポスター'],
    [250, '一般的なカタログ・プレゼン用'],
    [200, '離れて見る・コスト優先'],
    [150, '最低限'],
  ];
  return labels.map(([dpi, label]) => {
    const longEdge = longEdgePxForA3Dpi(dpi);
    // 横長（r>=1）は長辺＝幅、縦長（r<1）は長辺＝高さ。
    const width = r >= 1 ? longEdge : Math.max(1, Math.round(longEdge * r));
    const height = r >= 1 ? Math.max(1, Math.round(longEdge / r)) : longEdge;
    return { id: String(dpi), dpi, label, width, height };
  });
}

export const PREVIEW_RENDER_MAX_SIDE = 1600;

/**
 * 2K検証フラグ（260722・クライアント要望）。true で AIレンダリング/エリア編集/コーディネートの生成解像度を 2K に上げる。
 * 【重要】2K は過去に「編集経路」で生成が途中劣化し白っぽくぼやける事象があった（gemini-3-pro-image-preview のモデル挙動）。
 * その一因は編集経路だけ responseModalities が ['TEXT','IMAGE'] だったことと推定され、2K/4K 時は実績のあるレンダー/書き出し
 * 経路と同じ画像のみ（['IMAGE']）へ自動で切替える（lib/gemini.ts）。**実機で白ぼやけが出ないことを確認してから true を既定化**すること。
 * false のときは 1K のままで、クライアント承認済みの現行挙動（継ぎ目なし）を一切変えない。
 * ※2K でも Gemini の出力トークンは 1K とほぼ同じ（≒1,120 トークン）＝費用はほぼ不変（4K のみ約2倍）。
 * 【260722・クライアント要望で 2K を有効化＝検証モード】まず開発者の自アカウント/検証環境で AIレンダリング・
 * エリア編集・コーディネートを数枚生成し「白ぼやけが出ないこと」を目視確認してから本番でクライアントに使わせること。
 * 白ぼやけが再発したら本フラグを false に戻して再デプロイ（他は一切変更不要・1行で即ロールバック）。
 */
export const ENABLE_2K_PREVIEW = true;

export const PREVIEW_GEMINI_IMAGE_SIZE = ENABLE_2K_PREVIEW ? '2K' : '1K';

/**
 * Gemini がその imageSize で返す画像の長辺（16:9 実測）。
 *
 * AIレンダリングは生成結果をそのまま1つ目の版にするため、「図面からパース作成」は
 * 常にこの長辺で始まる。「AIで写真編集」の取り込み写真も同じ長辺へ揃えることで、
 * 両プロジェクトの出力サイズを一致させる（260812 クライアント要望）。
 * ENABLE_2K_PREVIEW を切り替えたら、こちらも自動で追従する。
 */
export const PREVIEW_GEMINI_LONG_EDGE = ENABLE_2K_PREVIEW ? 2688 : 1344;

/**
 * 【260818 実測】Gemini が 2K / 16:9 で実際に返す長辺。
 *
 * クライアント実ファイル2件（概算見積_20260810.xlsx / _20260812.xlsx に埋め込まれた
 * AIレンダ画像）がいずれも 2752x1536（比 1.79167）だった。
 * PREVIEW_GEMINI_LONG_EDGE(2688) は 16:9 の理論値から置いた推定で、実測と 64px ずれている。
 *
 * 【重要】土台の上限をこの値より小さくしてはいけない。
 * 小さくすると、モデルへ渡す画像（縮小後）と要求する出力（2752）の解像度が食い違い、
 * モデルが忠実に写し取らず描き直す＝構図が動く原因になる
 *（260817 クライアント報告「構図が若干拡大される」の想定原因）。
 */
export const MEASURED_GEMINI_2K_LONG_EDGE = 2752;

/**
 * 手段1: 生成結果を版の寸法へリサイズせず、モデルが返した寸法のまま採用する
 *（縦横比がずれた場合だけ補正）。編集1回ごとのリサンプル（損失A）を無くすのが目的。
 *
 * 【260818 フェーズ0でいったん false へ戻した】
 * クライアントより「手法1・2の導入前は構図がずれていなかった」とのご指摘があり、
 * 手段1・2 を導入前の状態へ完全に巻き戻して切り分けるため。
 * 併せて入れた手段2（上限2688）が、実測の生成長辺2752より小さかったため、
 * モデルへの入力と要求出力の解像度が食い違う状態を作っていた（MEASURED_GEMINI_2K_LONG_EDGE 参照）。
 *
 * このフラグは keepGeneratedSize の既定引数にもなっており、呼び出し4箇所
 *（エリア編集・コーディネート・精細化・画質を戻す）すべてが従う。
 * 以前は呼び出し側2箇所しかガードしておらず、残り2箇所が巻き戻らなかった。
 *
 * 再度 true にするときは、AREA_EDIT_BASE_MAX_SIDE が
 * MEASURED_GEMINI_2K_LONG_EDGE 以上であることを必ず確認すること。
 */
export const ENABLE_KEEP_GENERATED_SIZE = false;

/**
 * エリア編集/コーディネートの「土台画像」を縮小する長辺上限。
 * モデルへ送る画像もこの上限で丸められる（compressDataUrlToBudget の maxSide）。
 *
 * 【260818 フェーズ0】手段2（上限＝PREVIEW_GEMINI_LONG_EDGE＝2688）を巻き戻した。
 * 実際の生成長辺は 2752 で上限のほうが小さく、モデルへは 2688 の画像を渡しながら
 * 2752 の出力を求める形になっていた。従来の 3072 では 2752 がそのまま通り、入出力が一致していた。
 *
 * 【不変条件】この値は MEASURED_GEMINI_2K_LONG_EDGE 未満にしてはならない。
 * 下回ると入出力の解像度が食い違い、モデルが写し取らず描き直す＝構図が動く。
 */
export const AREA_EDIT_BASE_MAX_SIDE = 3072;

export const EXPORT_GEMINI_IMAGE_SIZE = '4K';

/** 書き出し API 投入前の入力長辺上限（ペイロード緩和） */
export const EXPORT_RENDER_INPUT_MAX_SIDE = 4096;

export const VIEW_ASPECT_RATIO_LABEL = '16 : 9';

export const PREVIEW_ASPECT_RATIO = '16:9';

export function getPrintExport16x9Dimensions(): { width: number; height: number; aspectLabel: string } {
  const p = EXPORT_PRESETS_16_9[0]!;
  return { width: p.width, height: p.height, aspectLabel: VIEW_ASPECT_RATIO_LABEL };
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

export function describePixelAspect(width: number, height: number): string {
  if (width <= 0 || height <= 0) return '—';
  const g = gcd(width, height);
  const rw = width / g;
  const rh = height / g;
  const r = width / height;
  const target = 16 / 9;
  if (Math.abs(r - target) < 0.02) return `${VIEW_ASPECT_RATIO_LABEL}（${rw}:${rh}）`;
  return `${rw}:${rh}（${r.toFixed(3)}）`;
}

/**
 * 選択プリセット直下に表示する注意書き（list-disc 用・文頭に中黒は付けない）。
 * aspectLabel を渡すと比率をその表記（'3 : 4' 等）で示す。未指定はピクセル実比から導出（丸め由来の
 * 非整数比になり得るため、呼び出し側で選択比率のラベルを渡すのが望ましい・260703 第2段）。
 */
export function exportPresetFooterLines(preset: ExportPreset16x9, aspectLabel?: string): string[] {
  const longEdge = Math.max(preset.width, preset.height);
  const ratioText = aspectLabel ?? describePixelAspect(preset.width, preset.height);
  return [
    `A3 長辺（420mm）を ${preset.dpi}dpi としたときの長辺ピクセル（約 ${longEdge}px）に相当する ${ratioText} です。`,
    'プレビュー画像を高品質に拡大します（色・内容は画面と同一。元が低解像度のときは拡大により細部がやわらかくなることがあります）。「AIで高精細化」オン時は、構図・色を維持したままAIで質感と輪郭を精細化します（ぼやけ低減）。',
    'アプリ内の表示は低解像のままです。印刷にはダウンロード画像を使用してください。',
    '最終出力は印刷所・DTP の指定に合わせてください。',
  ];
}

/**
 * 高解像度書き出し（img2img）のプロンプト（第3段 260703）。プレビュー画像の構図・視点・色・配置を厳密に
 * 維持したまま解像度と細部だけを高める（新規要素の追加・構図変更を禁止）＝プレビューとの差異を抑える。
 * ※プレビューAIレンダの創作用プロンプト（useAiRenderer）とは別。書き出しは「今見えている絵の高精細版」。
 */
export const EXPORT_UPSCALE_PROMPT =
  'この画像を、内容を変えずに高解像度化（アップスケール）してください。構図・視点・画角・色味・' +
  '光の当たり方・素材や仕上げの質感・写っているオブジェクトの位置と形状は一切変更しないでください。' +
  '既存の要素を追加・削除・置き換えたり、レイアウトや構図を変えたりしてはいけません。' +
  '存在しない模様やディテールを新たに創作せず、いま写っているものだけを、より鮮明・高精細に描き直してください。';

/** 用紙サイズ書き出しの注意書き（list-disc 用・第3段 260703）。paperRatioLabel は向きに応じ '1 : 1.414' / '1.414 : 1'。 */
export function exportPaperFooterLines(
  paperLabel: string,
  imageAspectLabel: string,
  px: { w: number; h: number },
  paperRatioLabel = '1 : 1.414',
): string[] {
  return [
    `${paperLabel}（用紙比率 ${paperRatioLabel}）に、${imageAspectLabel} で生成した画像を中央へ余白付きで配置します（${px.w}×${px.h}px）。`,
    'AI は用紙比率を直接生成できないため、対応比率で生成した画像を用紙枠へ収める方式です（生成し直さないので構図は変わりません）。',
    '余白は白で塗られます。フチなし印刷や別レイアウトが必要な場合は編集ソフトで調整してください。',
    '最終出力は印刷所・DTP の指定に合わせてください。',
  ];
}

/** 画像書き出しダイアログの「プレビュー用」行 */
export const EXPORT_PREVIEW_OPTION_ID = 'preview';

export const EXPORT_PREVIEW_LABEL = 'プレビュー用';

export const EXPORT_PREVIEW_DESCRIPTION =
  'API で再生成せず、現在の履歴画像をそのまま PNG として保存します。';

/** プレビュー即時保存の注意書き */
export function exportPreviewFooterLines(): string[] {
  return [
    '履歴画像のピクセル寸法を変えずに保存します。',
    '大きな印刷用の出力は dpi プリセット（クラウド API 経由の高解像レンダ）を選んでください。',
  ];
}

export const PREVIEW_USAGE_LINES: string[] = [
  '【プレビュー用 AI レンダリング】',
  `・キャプチャ画像の長辺を最大約 ${PREVIEW_RENDER_MAX_SIDE}px に抑えてから API に送ります。`,
  `・API の imageSize は ${PREVIEW_GEMINI_IMAGE_SIZE} 相当です。`,
  '・印刷用の高解像 PNG は AI 画像編集画面の「画像書き出し」から行ってください。',
];
