import { describe, it, expect } from 'vitest';
import { describeObjectPlacements, buildAiEditReferenceGuide } from './aiEditPrompt.js';
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
