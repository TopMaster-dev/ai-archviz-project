import { describe, it, expect } from 'vitest';
import { describeObjectPlacements, buildAiEditReferenceGuide, buildEnhanceDetailPrompt, detectAreaEditIntent, buildNaturalizePrompt, buildHarmonizePrompt, isSurfacePlaneFinish } from './aiEditPrompt.js';
import type { AiEditObjectReference, NormalizedRect } from '../types.js';

const obj = (placements: NormalizedRect[]): AiEditObjectReference => ({
  id: 'o1',
  imageDataUrl: null,
  placements,
  memo: '',
  placementMemos: [],
});

describe('formatPlacement: 多角形も矩形(bbox)で Gemini に伝える（260702 多角形の精度低下対策）', () => {
  it('矩形マスク → 従来どおり 左/上/幅/高さ（頂点列を含まない）', () => {
    const s = describeObjectPlacements(obj([{ x: 0.2, y: 0.3, width: 0.1, height: 0.4 }]));
    expect(s).toContain('左20.0%');
    expect(s).toContain('上30.0%');
    expect(s).toContain('幅10.0%');
    expect(s).toContain('高さ40.0%');
    expect(s).not.toContain('頂点[');
  });

  it('多角形マスク → 頂点列や境界パラグラフではなく、同じ bbox 矩形句を出す', () => {
    const s = describeObjectPlacements(
      obj([
        {
          x: 0.2,
          y: 0.2,
          width: 0.3,
          height: 0.4,
          points: [
            { x: 0.2, y: 0.2 },
            { x: 0.5, y: 0.25 },
            { x: 0.4, y: 0.6 },
          ],
        },
      ])
    );
    expect(s).not.toContain('頂点[');
    expect(s).not.toContain('→');
    expect(s).not.toContain('境界そのものを線');
    // bbox = 頂点 min/max: x0.2 y0.2 w0.3 h0.4
    expect(s).toContain('左20.0%');
    expect(s).toContain('上20.0%');
    expect(s).toContain('幅30.0%');
    expect(s).toContain('高さ40.0%');
  });

  it('多角形の bbox は頂点から導出（保存済み x/width が誤っていても頂点を正とする）', () => {
    const s = describeObjectPlacements(
      obj([
        {
          x: 0,
          y: 0,
          width: 1,
          height: 1, // 誤った保存 bbox
          points: [
            { x: 0.3, y: 0.4 },
            { x: 0.6, y: 0.4 },
            { x: 0.6, y: 0.7 },
            { x: 0.3, y: 0.7 },
          ],
        },
      ])
    );
    expect(s).toContain('左30.0%');
    expect(s).toContain('上40.0%');
    expect(s).toContain('幅30.0%');
    expect(s).toContain('高さ30.0%');
  });

  it('多角形を含む編集ガイドに頂点列が現れない（境界規則は憲法に一度だけ）', () => {
    const guide = buildAiEditReferenceGuide({
      hasStyle: false,
      objects: [
        obj([
          {
            x: 0.2,
            y: 0.2,
            width: 0.3,
            height: 0.4,
            points: [
              { x: 0.2, y: 0.2 },
              { x: 0.5, y: 0.25 },
              { x: 0.4, y: 0.6 },
            ],
          },
        ]),
      ],
    });
    expect(guide).not.toContain('頂点[');
    // 境界線を描かない規則自体は憲法に存在する（一度だけ）
    expect(guide).toContain('境界線');
  });
});

describe('フォーカス化＋領域メモ（260707）', () => {
  it('「配置」ではなく「フォーカス領域」の言い回しになる', () => {
    const s = describeObjectPlacements(obj([{ x: 0.2, y: 0.3, width: 0.1, height: 0.4 }]));
    expect(s).toContain('フォーカス領域');
    expect(s).not.toContain('配置:');
  });

  it('領域メモ（placementMemos）があればその領域の指示として併記される', () => {
    const o: AiEditObjectReference = {
      id: 'o1',
      imageDataUrl: null,
      placements: [{ x: 0.2, y: 0.3, width: 0.1, height: 0.4 }],
      memo: '',
      placementMemos: ['このソファを北欧風に'],
    };
    const s = describeObjectPlacements(o);
    expect(s).toContain('この領域の指示: このソファを北欧風に');
  });

  it('placementMemos が placements より短い/未指定でも落ちない', () => {
    const o: AiEditObjectReference = {
      id: 'o1',
      imageDataUrl: null,
      placements: [
        { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        { x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
      ],
      memo: '',
      placementMemos: ['領域1のみ'], // 2件目のメモ無し
    };
    const s = describeObjectPlacements(o);
    expect(s).toContain('この領域の指示: 領域1のみ');
    expect(s).toContain('フォーカス領域1');
    expect(s).toContain('フォーカス領域2');
  });

  it('領域メモは制御文字（改行等）を除去し長さ上限で丸める（プロンプト注入対策）', () => {
    const long = 'あ'.repeat(200);
    const o: AiEditObjectReference = {
      id: 'o1',
      imageDataUrl: null,
      placements: [{ x: 0.2, y: 0.3, width: 0.1, height: 0.4 }],
      memo: '',
      placementMemos: [`改行\nと\tタブ${long}`],
    };
    const s = describeObjectPlacements(o);
    expect(s).not.toContain('\n改行'); // 改行が原文のまま残らない
    // 120字上限（メモ部分）で丸められる＝原文200字がそのまま乗らない
    expect(s).not.toContain('あ'.repeat(160));
  });
});

describe('範囲外の扱いをモードで出し分ける（260708 再修正・自然/厳密）', () => {
  it('既定（strictConfine未指定）＝自然モード: 自然な統合を優先し、厳密限定の文言を出さない', () => {
    const guide = buildAiEditReferenceGuide({
      hasStyle: false,
      objects: [obj([{ x: 0.2, y: 0.2, width: 0.3, height: 0.3 }])],
    });
    expect(guide).toContain('自然な仕上がりを最優先');
    expect(guide).not.toContain('厳密に限定');
  });

  it('strictConfine=true＝厳密モード: 範囲外を変えない旨を明示する', () => {
    const guide = buildAiEditReferenceGuide({
      hasStyle: false,
      objects: [obj([{ x: 0.2, y: 0.2, width: 0.3, height: 0.3 }])],
      strictConfine: true,
    });
    expect(guide).toContain('厳密に限定');
    expect(guide).toContain('範囲外は変更しない');
    expect(guide).not.toContain('自然な仕上がりを最優先');
  });
});

describe('向き・角度の維持（260708 クライアント報告「3Dで置いた家具と向きがそろわない」対策）', () => {
  it('エリア編集の憲法に「向き・角度の維持を最優先」の指示が入る', () => {
    const guide = buildAiEditReferenceGuide({
      hasStyle: false,
      objects: [obj([{ x: 0.2, y: 0.2, width: 0.3, height: 0.3 }])],
    });
    expect(guide).toContain('向き・角度の維持を最優先');
    expect(guide).toContain('勝手に回転・反転');
  });

  it('オブジェクト参照ありでも、向き・角度は元の家具（パース）に合わせる指示が入る', () => {
    const o: AiEditObjectReference = {
      id: 'o1',
      imageDataUrl: 'data:image/png;base64,AAA',
      placements: [{ x: 0.2, y: 0.2, width: 0.3, height: 0.3 }],
      memo: '',
      placementMemos: [],
    };
    const guide = buildAiEditReferenceGuide({ hasStyle: false, objects: [o] });
    expect(guide).toContain('設置の向き・角度・カメラに対する見え方は参照画像ではなく');
  });
});

describe('重なり・遮蔽の維持（260708 クライアント報告「奥のオブジェクトが空き場所へ移動される」対策）', () => {
  it('エリア編集の憲法に、重なりを避けて動かさない旨の指示が入る', () => {
    const guide = buildAiEditReferenceGuide({
      hasStyle: false,
      objects: [obj([{ x: 0.2, y: 0.2, width: 0.3, height: 0.3 }])],
    });
    expect(guide).toContain('重なり・遮蔽の維持');
    expect(guide).toContain('元の位置から絶対に動かさない');
  });

  it('「いちばん手前だけ編集」の決めつけを外し、奥の対象も差し替える／対象以外は動かさない旨が入る（260708 round2）', () => {
    const guide = buildAiEditReferenceGuide({
      hasStyle: false,
      objects: [obj([{ x: 0.2, y: 0.2, width: 0.3, height: 0.3 }])],
    });
    // 対象は必ずしも最前面ではない（奥の対象を差し替える）。
    expect(guide).toContain('必ずしも最も手前の家具とは限らない');
    expect(guide).toContain('奥の対象自体を差し替え');
    // 対象以外は動かさない・変形しない。
    expect(guide).toContain('対象以外は動かさない');
    // 旧「最も手前に写っている対象オブジェクトのみを編集」という決めつけ文言は残っていない。
    expect(guide).not.toContain('最も手前に写っている対象オブジェクトのみを編集');
  });

  it('範囲外の“似た家具・オブジェクト”を編集しない旨が、種類を問わず入る（260709 対象の取り違え防止）', () => {
    const guide = buildAiEditReferenceGuide({
      hasStyle: false,
      objects: [obj([{ x: 0.2, y: 0.2, width: 0.3, height: 0.3 }])],
    });
    expect(guide).toContain('対象の取り違え防止');
    expect(guide).toContain('種類は問わない');
    // 範囲外のより目立つ同種の家具を代わりに編集してはならない旨。
    expect(guide).toContain('範囲外のより目立つ同種の家具を代わりに編集してはならない');
  });

  it('囲っていない場所に家具を追加・複製しない旨が入る（260709 勝手な追加生成の抑止）', () => {
    const guide = buildAiEditReferenceGuide({
      hasStyle: false,
      objects: [obj([{ x: 0.2, y: 0.2, width: 0.3, height: 0.3 }])],
    });
    expect(guide).toContain('指定領域以外に足さない');
    expect(guide).toContain('囲みのない領域は、元画像のまま何も足さず');
    expect(guide).toContain('椅子を余分に作らない');
  });
});

describe('画質を保つハイブリッド（260708）: 見本画像の役割をプロンプトに明示', () => {
  it('hasQualityRef=true で画像順に「画質・素材の見本」が入り、巻き戻さない指示が入る', () => {
    const guide = buildAiEditReferenceGuide({
      hasStyle: false,
      objects: [obj([{ x: 0.2, y: 0.2, width: 0.3, height: 0.3 }])],
      hasQualityRef: true,
    });
    expect(guide).toContain('画質・素材の見本');
    expect(guide).toContain('巻き戻さない');
    // 見本は画像2に入り、ベースは直近画像である旨。
    expect(guide).toContain('画像2: 画質・素材の見本');
    expect(guide).toContain('直近の画像');
  });

  it('既定（hasQualityRef 未指定）では見本画像の記述を出さない', () => {
    const guide = buildAiEditReferenceGuide({
      hasStyle: false,
      objects: [obj([{ x: 0.2, y: 0.2, width: 0.3, height: 0.3 }])],
    });
    expect(guide).not.toContain('画質・素材の見本');
  });
});

describe('画質を高める（精細化・260710）: 単一画像の後処理・内容不変・見本画像を使わない', () => {
  const p = buildEnhanceDetailPrompt();

  it('内容を変えない不変条件が明示される', () => {
    expect(p).toContain('絶対に変えない');
    expect(p).toContain('追加・削除・複製・移動・回転をしない');
    // 精細化の目的だけ
    expect(p).toContain('精細');
  });

  it('新しい要素を描き足さない（ゴースト/湧き出し防止の意図）', () => {
    expect(p).toContain('描き足さない');
    expect(p).toContain('追加しない');
  });

  it('2枚目の見本/参照画像を前提とする語を含まない（＝単一画像パスであることの担保）', () => {
    // 旧ハイブリッドのゴースト原因＝2枚目画像。精細化は1枚だけなので、これらの語が混入していないこと。
    expect(p).not.toContain('見本');
    expect(p).not.toContain('参照画像');
    expect(p).not.toContain('2枚');
    expect(p).not.toContain('再コーディネート');
  });

  it('出力に矩形・マスク・境界線を含めない指示がある', () => {
    expect(p).toContain('矩形');
    expect(p).toContain('境界線');
  });
});

describe('面の仕上げ（緑化/タイル/塗装/造作 等）の意図判定＋プロンプト（③④・260717）', () => {
  const withImage = (memo: string): AiEditObjectReference => ({
    id: 'o1',
    imageDataUrl: 'data:image/png;base64,AAA',
    placements: [{ x: 0.05, y: 0.1, width: 0.35, height: 0.7 }],
    memo,
    placementMemos: [],
  });
  const textOnly = (memo: string): AiEditObjectReference => ({
    id: 'o1',
    imageDataUrl: null,
    placements: [{ x: 0.05, y: 0.1, width: 0.35, height: 0.7 }],
    memo,
    placementMemos: [],
  });

  it('参照画像あり＋壁面緑化 → material（家具の差し替え replace ではない）', () => {
    expect(detectAreaEditIntent(withImage('壁面緑化を追加'))).toBe('material');
  });
  it('参照画像あり＋タイル/塗装/羽目板/造作 → material', () => {
    expect(detectAreaEditIntent(withImage('タイルに変更'))).toBe('material');
    expect(detectAreaEditIntent(withImage('天井造作を追加'))).toBe('material');
    expect(detectAreaEditIntent(withImage('塗装したい'))).toBe('material');
    expect(detectAreaEditIntent(withImage('羽目板を貼る'))).toBe('material');
  });
  it('参照画像あり＋家具の差し替えは従来どおり replace', () => {
    expect(detectAreaEditIntent(withImage('このソファに差し替え'))).toBe('replace');
  });
  it('可動家具語の部分一致で material に誤爆しない（検証WF指摘・260717）', () => {
    // 畳→折り畳み、壁面→壁面収納、格子→格子戸、框→上がり框、造作→造作家具 は面仕上げではなく家具/建具。
    expect(detectAreaEditIntent(withImage('折り畳みテーブルに差し替え'))).toBe('replace');
    expect(detectAreaEditIntent(withImage('折り畳みチェアに変更'))).toBe('replace');
    expect(detectAreaEditIntent(withImage('壁面収納を差し替え'))).toBe('replace');
    expect(detectAreaEditIntent(withImage('造作家具を差し替え'))).toBe('replace');
    expect(detectAreaEditIntent(withImage('格子戸に変更'))).toBe('replace');
  });
  it('テキストのみの面仕上げ → finish（照明/削除ではない）', () => {
    expect(detectAreaEditIntent(textOnly('壁面緑化にして'))).toBe('finish');
    expect(detectAreaEditIntent(textOnly('レンガ調にして'))).toBe('finish');
  });
  it('material 意図では「面全体を隅々まで満たす／面の形・パースを変えない」指示が入る', () => {
    const guide = buildAiEditReferenceGuide({ hasStyle: false, objects: [withImage('壁面緑化を追加')] });
    expect(guide).toContain('隅から隅まで');
    expect(guide).toContain('面の一部を元の仕上げ');
    expect(guide).toContain('パース');
  });
});

describe('最終仕上げパスは「空いた場所に家具を足さない」を明示（①・260717）', () => {
  it('naturalize/harmonize プロンプトに新規家具の描き足し禁止が入る', () => {
    expect(buildNaturalizePrompt()).toContain('新しい家具・オブジェクト・小物を絶対に描き足さない');
    expect(buildHarmonizePrompt()).toContain('新しい家具・オブジェクト・小物を描き足さない');
  });
});

describe('isSurfacePlaneFinish＝面仕上げはクロップせず全画面生成（Path A・③④・260717）', () => {
  const o = (memo: string, img = false): AiEditObjectReference => ({
    id: 'o1',
    imageDataUrl: img ? 'data:image/png;base64,AAA' : null,
    placements: [{ x: 0.05, y: 0.1, width: 0.35, height: 0.7 }],
    memo,
    placementMemos: [],
  });
  it('壁面緑化/タイル/塗装/天井造作 は面仕上げ（true）', () => {
    expect(isSurfacePlaneFinish(o('壁面緑化を追加'))).toBe(true);
    expect(isSurfacePlaneFinish(o('タイルに変更'))).toBe(true);
    expect(isSurfacePlaneFinish(o('天井造作を追加'))).toBe(true);
    expect(isSurfacePlaneFinish(o('塗装したい'))).toBe(true);
  });
  it('家具の生地張り替え・差し替えは面仕上げでない（false＝従来どおりクロップで寄る）', () => {
    expect(isSurfacePlaneFinish(o('このソファに差し替え'))).toBe(false);
    expect(isSurfacePlaneFinish(o('この生地に張り替え'))).toBe(false);
    expect(isSurfacePlaneFinish(o('折り畳みテーブルに差し替え'))).toBe(false);
  });
  it('面仕上げプロンプトが「壁は塗り残さない・窓/ドアは保持」を両立させる（③＋開口保持・case B round3）', () => {
    const guide = buildAiEditReferenceGuide({ hasStyle: false, objects: [o('壁面緑化を追加', true)] });
    // ③ 壁の塗り残しゼロ・枠のきわまで一様に。
    expect(guide).toContain('塗り残し');
    expect(guide).toContain('枠のきわまで');
    // 窓・ドアそのものは AI 自身が保持する（＝決定論の復元がスキップ/フラグOFFでも窓が消えない・R3-B グレースフル劣化）。
    expect(guide).toContain('元の見た目のまま必ず残す');
    // R3-B 回帰ガード: 「システムが自動で復元する」という危険な前提（＝AIに窓を塗り潰させる免罪符）は入れない。
    expect(guide).not.toContain('システムが自動');
  });
  it('テキストのみ（参照画像なし）の面仕上げでも窓/ドア保持指示が入る（R4-1・参照画像の有無を問わない）', () => {
    // 「壁面緑化にして」= finish 意図・参照画像なし。旧実装は keep-windows 文言が material 画像ブランチだけにあり、
    // テキストのみ経路では窓が塗り潰されうる回帰があった。hasFinishChange 起因の共通ノートで両経路をカバーする。
    const textOnly = buildAiEditReferenceGuide({ hasStyle: false, objects: [o('壁面緑化にして')] });
    expect(textOnly).toContain('元の見た目のまま必ず残す');
    expect(textOnly).toContain('枠のきわまで');
    expect(textOnly).not.toContain('システムが自動');
  });
  it('面仕上げ文言に時間帯語が混じっても窓/ドア保持指示が入る（R5・intentがlightingへ倒れてもisSurfacePlaneFinishで拾う）', () => {
    // 「壁紙を夕焼け色にして」= RE_LIGHTING(夕焼)が先にヒットし intent=lighting に倒れるが、壁紙=面仕上げ。
    // hasFinishChange では拾えないため hasSurfaceFinish(=isSurfacePlaneFinish 由来) で窓・ドア保持ノートを出す。
    const guide = buildAiEditReferenceGuide({ hasStyle: false, objects: [o('壁紙を夕焼け色にして')] });
    expect(guide).toContain('元の見た目のまま必ず残す');
    // 純粋な採光/ビュー編集（窓の外を夜に）は面仕上げでないので保持ノートを出さない（窓のビュー変更を妨げない）。
    const viewEdit = buildAiEditReferenceGuide({ hasStyle: false, objects: [o('窓の外を夜にして')] });
    expect(viewEdit).not.toContain('面の仕上げ時の窓・ドア保持');
  });
  it('なじませプロンプトに異種仕上げ境界の白線消しが入る（②）', () => {
    expect(buildNaturalizePrompt()).toContain('異なる仕上げどうしが接する');
    expect(buildHarmonizePrompt()).toContain('異なる仕上げどうしが接する');
  });
});

describe('コーディネートのテキスト指示は画像添付が無くてもプロンプトに反映される（260702）', () => {
  it('hasStyle=false・objects=[] でも styleMemo が編集指示としてプロンプトに載る', () => {
    const guide = buildAiEditReferenceGuide({
      hasStyle: false,
      objects: [],
      styleMemo: '木の温もりを感じるナチュラルモダンなリビングにして',
    });
    expect(guide).toContain('ユーザーの編集指示');
    expect(guide).toContain('木の温もりを感じるナチュラルモダンなリビングにして');
  });

  it('エリア編集（objects あり）では全体指示ブロックを出さない（独立性）', () => {
    const guide = buildAiEditReferenceGuide({
      hasStyle: false,
      styleMemo: 'これは送られないはず',
      objects: [obj([{ x: 0.2, y: 0.2, width: 0.3, height: 0.3 }])],
    });
    expect(guide).not.toContain('ユーザーの編集指示（空間全体');
  });
});
