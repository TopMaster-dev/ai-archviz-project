import { describe, it, expect } from 'vitest';
import { classifySurface, formatPartCodeForDisplay } from './estimateExport.js';
import { surfaceFromMeshName } from './meshSurface.js';

/**
 * マテリアルボードの品番表示（260728 クライアント指摘: キャプションの文字が切れて読めない）。
 * 品番未入力時に内部の Cloudinary パスがそのまま出て溢れていた。
 */
describe('formatPartCodeForDisplay', () => {
  it('ユーザー入力の品番があればそれを使う', () => {
    expect(formatPartCodeForDisplay('KAGETOHIK-ADL-R', 'materials/x/y')).toBe('KAGETOHIK-ADL-R');
  });

  it('内部IDがパス形式なら末尾だけにして短くする', () => {
    // 実際に溢れていた値
    expect(formatPartCodeForDisplay(undefined, 'materials/generic/61ajziJ6ADL._AC_UF1000_1000_QL80_')).toBe(
      '61ajziJ6ADL._AC_UF1000_1000…',
    );
  });

  it('拡張子と末尾の区切り記号を落とす', () => {
    expect(formatPartCodeForDisplay(undefined, 'materials/wood/oak_01.jpg')).toBe('oak_01');
    expect(formatPartCodeForDisplay(undefined, 'materials/wood/oak__')).toBe('oak');
  });

  it('どちらも無ければ「品番未設定」', () => {
    expect(formatPartCodeForDisplay(undefined, undefined)).toBe('品番未設定');
    expect(formatPartCodeForDisplay('  ', '')).toBe('品番未設定');
  });

  it('長すぎる入力は必ず上限内に収まる（レイアウト保護）', () => {
    expect(formatPartCodeForDisplay('A'.repeat(200), undefined).length).toBeLessThanOrEqual(28);
    expect(formatPartCodeForDisplay(undefined, 'a/'.repeat(50) + 'B'.repeat(200)).length).toBeLessThanOrEqual(28);
  });
});

/**
 * 見積の 床/壁/天井/梁 区分は「3Dで実際に貼られた面」で決まること（260728 クライアント #3b）。
 * PDF/CSV のセクションとマテリアルボードのスワッチは同じ classifySurface を共有するため、
 * ここが崩れると両者の区分がズレる。判定順（ceiling を floor より先）も固定する。
 */
describe('classifySurface', () => {
  it('スケッチ由来の確定名を最優先で判定する', () => {
    expect(classifySurface('Sketch_Floor')).toBe('floor');
    expect(classifySurface('Sketch_Ceiling')).toBe('ceiling');
    expect(classifySurface('Sketch_Wall_2')).toBe('wall');
    expect(classifySurface('Sketch_Wall_2_0')).toBe('wall'); // 腰壁の下段
    expect(classifySurface('Sketch_Wall_2_1')).toBe('wall'); // 腰壁の上段
    expect(classifySurface('Sketch_UpperBand')).toBe('wall'); // スケルトン天井の上部壁
    expect(classifySurface('Beam_abc123')).toBe('beam');
  });

  it('取込み3Dモデルの任意メッシュ名を名前から判定する（従来は全部 wall だった）', () => {
    expect(classifySurface('FloorMesh')).toBe('floor');
    expect(classifySurface('room_floor_01')).toBe('floor');
    expect(classifySurface('Ceiling_Main')).toBe('ceiling');
    expect(classifySurface('Ceil_A')).toBe('ceiling'); // 略記も拾う
    expect(classifySurface('beam_center')).toBe('beam');
    expect(classifySurface('hari_02')).toBe('beam');
  });

  it('3Dビューのクリック判定と同じ規則・同じ順序であること（floor が先）', () => {
    // 見積の区分は「3Dで実際に貼られた面」でなければならない（#3b）。3D側（RoomViewer の
    // 取込モデルクリック判定）は floor を先に見るため、ここも同じ順序にする。両者が食い違うと
    // 「3Dでは床パレットを開いたのにPDFでは天井セクション」というズレが起きる。
    expect(classifySurface('floor_ceiling_trim')).toBe('floor');
    expect(surfaceFromMeshName('floor_ceiling_trim')).toBe('floor');
    // 判定は共有関数に委譲されている（実装が1本であることの確認）。
    for (const n of ['Ceil_A', 'ceiling_main', 'FloorMesh', 'beam_x', 'Object_001', '天井', '床', '梁']) {
      expect(classifySurface(n)).toBe(surfaceFromMeshName(n));
    }
  });

  it('日本語CADの漢字メッシュ名も判定する', () => {
    expect(classifySurface('天井')).toBe('ceiling');
    expect(classifySurface('床')).toBe('floor');
    expect(classifySurface('梁')).toBe('beam');
  });

  it('判定できない名前は壁として扱う（従来どおりの既定）', () => {
    expect(classifySurface('Object_001')).toBe('wall');
    expect(classifySurface('')).toBe('wall');
  });
});
