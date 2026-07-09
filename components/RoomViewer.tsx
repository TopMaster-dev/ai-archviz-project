import React, { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, PropsWithChildren } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { useTexture, OrbitControls, PerspectiveCamera, useGLTF, Center, Environment, Html } from '@react-three/drei';
import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import type { OrbitControls as OrbitControlsImpl } from 'three/examples/jsm/controls/OrbitControls.js';
import { ModelRoot } from './ModelRoot.js';
import { exoticNormalizeScale, type ModelFormat } from '../utils/modelFormat.js';
import { useStore } from 'zustand';
import { useProjectStore } from '../lib/store/projectStore.js';
import { useLoadingStore } from '../lib/store/loadingStore.js';
import { EffectComposer as ThreeEffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import {
  walkForward,
  walkRight,
  clampPitch,
  clampXZToPolygon,
} from '../utils/walkthrough.js';

/** ウォーク時の壁からの最小距離（m）。near 面が壁にめり込まないよう少し余裕を持たせる。 */
const WALK_WALL_MARGIN = 0.12;
/** 部屋ポリゴン（XZ・原点中心メートル）。ウォークの閉じ込めに使う。 */
type WalkPolygon = { x: number; z: number }[];
import { MaterialCategory, Product, FurnitureItem, Opening, CameraBlendRequest } from '../types.js';
import { OPENING_CENTER_OFFSET_M, OPENING_DEPTH_M, ParametricWindow, ParametricDoor } from './Openings.js';
import { useGesture } from '@use-gesture/react';
import {
  getRoomTransform,
  getWallRotationY,
  openingRatioToWallLocalX,
  wallLocalXToOpeningRatio,
  clampOpeningRatioWithCollisions,
  scaledToMm,
  slideFurnitureCenterMmWithWallContact,
  furniturePositionToMm,
  mmToFurniturePosition,
  getFurnitureFootprintMm,
  getEffectiveOpeningWidthMm,
  MM_PER_METER,
  clampFurnitureItemToRoom,
  computeWallToWallSpan,
  getWallBeamBandCornersMm,
  freeBeamWallMiterCornersMm,
  wallBeamMiterWidths,
  type WallBeamDims
} from '../utils/sketchTransform.js';
import { Point } from '../types.js';
import type { Beam } from '../lib/project/projectState.js';
import { effectiveTextureShortEdgeMeters, effectiveTextureTileMeters } from '../lib/materialPhysical.js';
import { hasInvisibleAncestor } from '../utils/raycastVisibility.js';
import { applyFurniturePatch, resolveMoveMembers, applyGroupRotation, computeGroupCentroidXZ, type Vec2XZ } from '../utils/furnitureGroupMove.js';
import { solidRectsForSegment } from '../utils/wallOpeningTiling.js';

// three.jsのジオメトリをパストレーサー(BVH)対応に拡張
if (!(THREE.BufferGeometry.prototype as any).computeBoundsTree) {
  (THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
  (THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
  // BVH レイキャスト。ただし「非表示 group 配下」のメッシュはスキップする（R3F のイベント用直接
  // レイキャストは親の visible を見ないため、カットアウェイ中の手前の壁がクリックを吸う問題を防ぐ）。
  (THREE.Mesh.prototype as any).raycast = function (
    this: THREE.Mesh,
    raycaster: THREE.Raycaster,
    intersects: THREE.Intersection[],
  ) {
    if (hasInvisibleAncestor(this)) return;
    (acceleratedRaycast as any).call(this, raycaster, intersects);
  };
}

/**
 * 梁バンドの四隅(mm)＋上端/下端Y(m)＋部屋中心(mm)から、押し出し角柱の BufferGeometry を生成。
 * 壁梁(getWallBeamBandCornersMm)・自由梁(freeBeamWallMiterCornersMm)のどちらの四隅でも共有する。
 * 面の表裏（巻き方向）はバンドの向きで変わるため、呼び出し側は DoubleSide で描く前提。
 */
function buildBeamBandPrism(
  corners: { c1: Point; c2: Point; c3: Point; c4: Point },
  centerMm: Point,
  topY: number,
  botY: number,
): THREE.BufferGeometry | null {
  const toXZ = (p: Point): [number, number] => [(p.x - centerMm.x) / MM_PER_METER, (p.y - centerMm.y) / MM_PER_METER];
  // 長辺が c1-c2 になるよう必要なら頂点ラベルを1つ回転（壁梁は c1-c2 が長辺、自由梁は c2-c3 が長辺で
  // 四隅の並び順が異なる・260701）。これで天面/底面・長辺側面の u が両梁種で「梁長さ方向」に揃い、
  // 非1:1テクスチャのアスペクト比が正しく貼られる（回転しないと自由梁で長さ/幅が入れ替わり歪む）。
  let { c1, c2, c3, c4 } = corners;
  if (Math.hypot(c2.x - c3.x, c2.y - c3.y) > Math.hypot(c1.x - c2.x, c1.y - c2.y)) {
    [c1, c2, c3, c4] = [c2, c3, c4, c1];
  }
  const [x1, z1] = toXZ(c1);
  const [x2, z2] = toXZ(c2);
  const [x3, z3] = toXZ(c3);
  const [x4, z4] = toXZ(c4);
  if (![x1, z1, x2, z2, x3, z3, x4, z4, topY, botY].every(Number.isFinite)) return null;
  const T1 = [x1, topY, z1], T2 = [x2, topY, z2], T3 = [x3, topY, z3], T4 = [x4, topY, z4];
  const B1 = [x1, botY, z1], B2 = [x2, botY, z2], B3 = [x3, botY, z3], B4 = [x4, botY, z4];
  const pos: number[] = [];
  // 各面に「実寸(m)の UV」を付与する（等方＝1 UV 単位 = 1m）。
  // 0..1 の UV だと長辺×短辺の面で UV が異方性になり、texture.rotation（90°等）でテクスチャが面のアスペクト比ぶん
  // 歪む（260702 クライアント報告の修正）。実寸UV（ShapeGeometry と同じ扱い）なら回転しても歪まず、
  // repeat は uvInMeters 経路で 1/タイル実寸 になり 1タイル=実寸・面積非依存でタイリングされる（u=a→b・v=a→d の実長）。
  const uv: number[] = [];
  const dist3 = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    const uLen = dist3(a, b); // u 軸＝a→b の実寸(m)
    const vLen = dist3(a, d); // v 軸＝a→d の実寸(m)
    uv.push(0, 0, uLen, 0, uLen, vLen, 0, 0, uLen, vLen, 0, vLen);
  };
  quad(T1, T2, T3, T4); // 天面
  quad(B4, B3, B2, B1); // 底面（室内から見上げる主要面）
  quad(B1, B2, T2, T1); // 側面 c1-c2（長辺）
  quad(B2, B3, T3, T2); // 端面 c2-c3
  quad(B3, B4, T4, T3); // 側面 c3-c4（長辺）
  quad(B4, B1, T1, T4); // 端面 c4-c1
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.userData.uvInMeters = true; // UV は実寸(m)＝ShapeGeometry と同じ扱い（applyRealSizeTextureRepeat で repeat=1/タイル）
  geo.computeVertexNormals();
  return geo;
}

/**
 * 梁1本の3D描画＋直接操作。2D(mm)座標 (cx,cy) を部屋と同じ変換で3Dワールド(m)へ写像し、
 * 天井（roomHeight）から dropMm 下げた箱として配置する。
 * 自由梁は選択後にクリックドラッグで水平移動、橙のハンドルで回転できる（壁梁は壁に固定）。
 * ドラッグ中はメッシュを直接更新し、離した時に一度だけストアへ反映（Undo履歴を汚さない）。
 */
const Beam3DMesh: React.FC<{
  beam: Beam;
  centerMm: Point;
  polygonMm?: Point[];
  roomHeight: number;
  isSelected: boolean;
  editable: boolean;
  onSelect: () => void;
  onPatch: (patch: Partial<Beam>) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  wallHiddenRef?: React.MutableRefObject<Record<number, boolean>>;
  selections?: Record<string, Product | null>;
  materialSettings?: any;
  captureStep?: any;
  onHoverNameChange?: (name: string | null) => void;
  /** 壁梁が乗っているエッジ index → 寸法(幅/高さ/下がり)。コーナー接合の可否判定に使う。 */
  beamDimsByWallIndex?: Map<number, WallBeamDims>;
}> = ({ beam, centerMm, polygonMm, roomHeight, isSelected, editable, onSelect, onPatch, onDragStart, onDragEnd, wallHiddenRef, selections, materialSettings, captureStep, onHoverNameChange, beamDimsByWallIndex }) => {
  const boxRef = useRef<THREE.Mesh>(null);
  const handleRef = useRef<THREE.Mesh>(null);
  // 角柱描画中か（=ライブ位置更新を抑止すべきか）を pointer ハンドラから参照するためのミラー。
  const usePrismRef = useRef(false);
  const { camera, gl } = useThree();
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const plane = useMemo(() => new THREE.Plane(), []);
  const ndc = useMemo(() => new THREE.Vector2(), []);
  const tmpHit = useMemo(() => new THREE.Vector3(), []);
  const dragRef = useRef<{ mode: 'move' | 'rotate'; startCx: number; startCy: number; startWx: number; startWz: number; planeY: number; cbx: number; cbz: number } | null>(null);
  const liveRef = useRef<{ cx: number; cy: number; angleDeg: number; lengthMm: number } | null>(null);
  const onPatchRef = useRef(onPatch); onPatchRef.current = onPatch;
  const onDragEndRef = useRef(onDragEnd); onDragEndRef.current = onDragEnd;
  const polygonMmRef = useRef(polygonMm); polygonMmRef.current = polygonMm;

  const isWallBeam = beam.wallIndex !== undefined;
  const n = polygonMm?.length ?? 0;

  let cx = beam.cx;
  let cy = beam.cy;
  let lengthMm = beam.lengthMm;
  let angleDeg = beam.angleDeg;
  if (isWallBeam && polygonMm && n >= 2) {
    const p1 = polygonMm[(beam.wallIndex as number) % n];
    const p2 = polygonMm[((beam.wallIndex as number) + 1) % n];
    if (p1 && p2) {
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
      cx = (p1.x + p2.x) / 2;
      cy = (p1.y + p2.y) / 2;
      lengthMm = len;
      angleDeg = (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI;
      let nx = -(p2.y - p1.y) / len;
      let ny = (p2.x - p1.x) / len;
      if (nx * (centerMm.x - cx) + ny * (centerMm.y - cy) < 0) { nx = -nx; ny = -ny; }
      cx += nx * (beam.widthMm / 2);
      cy += ny * (beam.widthMm / 2);
    }
  }
  // 非有限値（NaN/undefined）の梁寸法で BoxGeometry が NaN になり 3D 全体がクラッシュするのを防ぐ。
  // ※ Math.max(0.01, NaN) は NaN を返すため、明示的に Number.isFinite で防御する。
  const finiteOr = (v: number, d: number) => (Number.isFinite(v) ? v : d);
  const finitePos = (v: number, d: number) => (Number.isFinite(v) && v > 0 ? v : d);
  const sCx = finiteOr(cx, centerMm.x);
  const sCy = finiteOr(cy, centerMm.y);
  const bx = (sCx - centerMm.x) / MM_PER_METER;
  const bz = (sCy - centerMm.y) / MM_PER_METER;
  const lengthM = finitePos(lengthMm / MM_PER_METER, 1);
  const widthM = finitePos(beam.widthMm / MM_PER_METER, 0.15);
  const heightM = finitePos(beam.heightMm / MM_PER_METER, 0.3);
  const by = roomHeight - finiteOr(beam.dropMm / MM_PER_METER, 0.2) - heightM / 2;
  const angleRad = (finiteOr(angleDeg, 0) * Math.PI) / 180;
  const handleD = lengthM / 2 + 0.4;

  // 壁梁は所属壁がカメラ背面で非表示のとき同期して非表示。
  useFrame(() => {
    const m = boxRef.current;
    if (!m) return;
    const hidden = wallHiddenRef?.current;
    m.visible = !isWallBeam || !hidden ? true : !hidden[beam.wallIndex as number];
  });

  const intersectAtY = useCallback((clientX: number, clientY: number, y: number) => {
    const rect = gl.domElement.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, y, 0));
    return raycaster.ray.intersectPlane(plane, tmpHit) ? tmpHit.clone() : null;
  }, [camera, gl, ndc, plane, raycaster, tmpHit]);

  // ドラッグ中の global pointer 監視（選択中のみ）。メッシュを直接更新し、離したらストアへ一括反映。
  useEffect(() => {
    if (!editable || !isSelected) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      const live = liveRef.current;
      if (!d || !live) return;
      const p = intersectAtY(e.clientX, e.clientY, d.planeY);
      if (!p) return;
      if (d.mode === 'move') {
        // 自由梁は X/Y 制限なしで自由移動。さらに梁軸に沿って壁⇔壁へ長さを自動連動（2Dと同仕様・260612）。
        const nextCx = d.startCx + (p.x - d.startWx) * MM_PER_METER;
        const nextCy = d.startCy + (p.z - d.startWz) * MM_PER_METER;
        const poly = polygonMmRef.current;
        const span =
          poly && poly.length >= 2 ? computeWallToWallSpan(poly, true, nextCx, nextCy, live.angleDeg) : null;
        if (span) {
          live.cx = span.cx;
          live.cy = span.cy;
          live.lengthMm = span.lengthMm;
        } else {
          live.cx = nextCx;
          live.cy = nextCy;
        }
      } else {
        live.angleDeg = (Math.atan2(p.z - d.cbz, p.x - d.cbx) * 180) / Math.PI;
      }
      const lbx = (live.cx - centerMm.x) / MM_PER_METER;
      const lbz = (live.cy - centerMm.y) / MM_PER_METER;
      const lrad = (live.angleDeg * Math.PI) / 180;
      const liveLengthM = (Number.isFinite(live.lengthMm) ? live.lengthMm : beam.lengthMm) / MM_PER_METER;
      const liveHandleD = liveLengthM / 2 + 0.4;
      // 角柱（絶対座標）描画フレームでは位置を動かさない（箱へ切替わるまでの1フレームの飛びを防ぐ）。
      if (boxRef.current && !usePrismRef.current) {
        boxRef.current.position.x = lbx;
        boxRef.current.position.z = lbz;
        boxRef.current.rotation.y = -lrad;
        // 長さ変化はジオメトリ固定のため X スケールでライブ表現（離した時に正規化＋実ジオメトリへ反映）。
        boxRef.current.scale.x = lengthM > 0 ? liveLengthM / lengthM : 1;
      }
      if (handleRef.current) {
        handleRef.current.position.x = lbx + liveHandleD * Math.cos(lrad);
        handleRef.current.position.z = lbz + liveHandleD * Math.sin(lrad);
      }
    };
    const onUp = () => {
      if (!dragRef.current) return;
      const live = liveRef.current;
      dragRef.current = null;
      liveRef.current = null;
      // ライブスケールを正規化（コミット後の実ジオメトリと二重適用しないように）。
      if (boxRef.current) boxRef.current.scale.x = 1;
      setIsDragging(false); // コミット後は角柱（壁線に沿って切った端）へ戻す
      if (live) onPatchRef.current({ cx: live.cx, cy: live.cy, angleDeg: live.angleDeg, lengthMm: live.lengthMm });
      onDragEndRef.current?.();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [editable, isSelected, intersectAtY, centerMm, handleD]);

  // 「見えている」梁は外側ビュー（近接壁カットアウェイ中）でも、家具と同様に「選択・ホバー・移動・回転」可能。
  // 260619 クライアント要望: row 198（梁を外から選択）＋ row 143（自由梁の移動制限の解除＝外側ビューでも移動可）。
  // 自身が非表示（所属する近接壁がカットアウェイ中で visible=false）の壁梁は見えないので、従来どおり
  // クリック/ホバー/移動を素通りさせ、奥の壁を選択できるようにする（見えない梁を選択／前面で遮らない）。
  const isSelfHidden = () => boxRef.current?.visible === false;

  const startMove = (e: ThreeEvent<PointerEvent>) => {
    if (!editable || isSelfHidden()) return;
    e.stopPropagation();
    // 選択は外側ビュー（カットアウェイ中）でも可能＝家具と同様に最前面で選択する。
    if (!isSelected) { onSelect(); return; }
    // 壁梁は常に壁固定（row 155）。自由梁は室内・外側ビューのどちらでも移動可（row 143）。
    if (isWallBeam) return;
    const p = intersectAtY(e.clientX, e.clientY, by);
    if (!p) return;
    // 回転ギズモの操作範囲内で押下したら回転を優先（移動より優先・260703）。
    // リング帯（家具と同じ判定）に乗っていれば回転ドラッグへ切替える。
    {
      const ringR = Math.max(0.3, widthM);
      if (isPointerOnFurnitureRingXZ({ x: p.x, z: p.z }, { x: bx, z: bz }, ringR)) {
        startRotate(e);
        return;
      }
    }
    dragRef.current = { mode: 'move', startCx: beam.cx, startCy: beam.cy, startWx: p.x, startWz: p.z, planeY: by, cbx: bx, cbz: bz };
    liveRef.current = { cx: beam.cx, cy: beam.cy, angleDeg: beam.angleDeg, lengthMm: beam.lengthMm };
    setIsDragging(true); // ドラッグ中は箱＋スケールでライブ表現（角柱から切替）
    onDragStart?.();
  };
  const startRotate = (e: ThreeEvent<PointerEvent>) => {
    if (!editable || isWallBeam) return;
    e.stopPropagation();
    dragRef.current = { mode: 'rotate', startCx: beam.cx, startCy: beam.cy, startWx: 0, startWz: 0, planeY: by, cbx: bx, cbz: bz };
    liveRef.current = { cx: beam.cx, cy: beam.cy, angleDeg: beam.angleDeg, lengthMm: beam.lengthMm };
    setIsDragging(true); // 回転中も角度がライブで変わるため箱で表現
    onDragStart?.();
  };

  const [isDragging, setIsDragging] = useState(false);
  // 回転ギズモのハイライト（家具と同仕様・260703）。ウィンドウの pointermove で
  // リング帯の内外を判定する ringHoverDist と、リングメッシュ自身の onPointerOver
  // による ringMeshHover のいずれかで点灯する。自由梁のみ（壁梁は回転不可）。
  const [ringHoverDist, setRingHoverDist] = useState(false);
  const [ringMeshHover, setRingMeshHover] = useState(false);
  const ringHighlight = ringHoverDist || ringMeshHover;

  // リング帯上にポインタが乗っているかをウィンドウ全体の pointermove で追跡（家具と同仕様）。
  // ドラッグ中は判定しない。壁梁・非選択・非編集時はハイライトを消す。
  useEffect(() => {
    if (!isSelected || isWallBeam || !editable) {
      setRingHoverDist(false);
      return;
    }
    const onMove = (e: PointerEvent) => {
      if (dragRef.current) return;
      const p = intersectAtY(e.clientX, e.clientY, by);
      if (!p) {
        setRingHoverDist(false);
        return;
      }
      const ringR = Math.max(0.3, widthM);
      setRingHoverDist(isPointerOnFurnitureRingXZ({ x: p.x, z: p.z }, { x: bx, z: bz }, ringR));
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [isSelected, isWallBeam, editable, intersectAtY, by, bx, bz, widthM]);

  // 壁梁のコーナー接合（2b の 3D 版）。2D と同じ getWallBeamBandCornersMm でマイターした
  // 室内側バンドの四隅を、天井(by+h/2)から下端(by-h/2)まで押し出した角柱として描く。
  // 梁端が隣の壁／壁梁に沿って切られ、入隅の隙間・出角の重なり・斜め角での突き出しが解消する。
  const wallBeamPrism = useMemo(() => {
    if (!isWallBeam || beam.wallIndex === undefined || !polygonMm || polygonMm.length < 3) return null;
    // 隣接梁は「高さ・下がりが一致」する場合のみ接合（マイター）対象に含める。高さが異なる隣接梁は
    // 除外され、端は隣の壁線に接合して壁へ密着する（角の段差/隙間を防ぐ）。
    const widthForMiter = wallBeamMiterWidths(beamDimsByWallIndex ?? new Map(), beam.wallIndex, {
      widthMm: beam.widthMm,
      heightMm: beam.heightMm,
      dropMm: beam.dropMm,
    });
    const corners = getWallBeamBandCornersMm(polygonMm, widthForMiter, beam.wallIndex);
    if (!corners) return null;
    return buildBeamBandPrism(corners, centerMm, by + heightM / 2, by - heightM / 2);
  }, [isWallBeam, beam.wallIndex, beam.widthMm, beam.heightMm, beam.dropMm, polygonMm, beamDimsByWallIndex, by, heightM, centerMm]);
  useEffect(() => () => { wallBeamPrism?.dispose(); }, [wallBeamPrism]);

  // 自由梁の端を壁線に沿って切った角柱（2D と同じ freeBeamWallMiterCornersMm）。両端が壁面と
  // 面一になり、斜めの壁での突き出し/隙間が解消する。ドラッグ中はライブのスケール表現（箱）に
  // 切り替えるため、idle 時のみ角柱で描画する。
  const freeBeamPrism = useMemo(() => {
    if (isWallBeam || !polygonMm || polygonMm.length < 3) return null;
    const corners = freeBeamWallMiterCornersMm(polygonMm, true, beam.cx, beam.cy, beam.angleDeg, beam.widthMm);
    if (!corners) return null;
    return buildBeamBandPrism(corners, centerMm, by + heightM / 2, by - heightM / 2);
  }, [isWallBeam, polygonMm, beam.cx, beam.cy, beam.angleDeg, beam.widthMm, by, heightM, centerMm]);
  useEffect(() => () => { freeBeamPrism?.dispose(); }, [freeBeamPrism]);

  // 壁梁: 常に角柱。自由梁: idle 時のみ角柱（ドラッグ中は箱＋Xスケールでライブ表現）。
  const activePrism = isWallBeam ? wallBeamPrism : isDragging ? null : freeBeamPrism;
  const usePrism = !!activePrism;
  usePrismRef.current = usePrism;

  return (
    <group>
      <mesh
        ref={boxRef}
        name={`Beam_${beam.id}`}
        position={usePrism ? [0, 0, 0] : [bx, by, bz]}
        rotation={usePrism ? [0, 0, 0] : [0, -angleRad, 0]}
        geometry={usePrism ? activePrism : undefined}
        castShadow
        receiveShadow
        onPointerDown={startMove}
        onClick={(e) => { if (editable && !isSelfHidden()) e.stopPropagation(); }}
        onPointerOver={(e) => { if (!isSelfHidden()) { e.stopPropagation(); onHoverNameChange?.(`Beam_${beam.id}`); } }}
        onPointerOut={() => onHoverNameChange?.(null)}
      >
        {!usePrism && <boxGeometry args={[lengthM, heightM, widthM]} />}
        {selections && selections[`Beam_${beam.id}`] ? (
          <Suspense fallback={<meshStandardMaterial color={DEFAULT_SURFACE_COLOR} side={usePrism ? THREE.DoubleSide : THREE.FrontSide} />}>
            <DynamicMaterial product={selections[`Beam_${beam.id}`]} captureStep={captureStep} meshRef={boxRef} materialSettings={materialSettings} surfaceWidthM={lengthM} surfaceHeightM={heightM} doubleSided={usePrism} />
          </Suspense>
        ) : (
          // 2c: 未割当の梁は壁・天井と同じ既定色。選択/ホバーは OutlinePass で表示（2d）するため色は変えない。
          <meshStandardMaterial color={DEFAULT_SURFACE_COLOR} roughness={0.8} metalness={0.05} side={usePrism ? THREE.DoubleSide : THREE.FrontSide} />
        )}
      </mesh>
      {isSelected && !isWallBeam && editable && (
        // 家具と同様の回転リングを梁の中央に配置（260623・クライアント要望）。リングをドラッグで回転。
        <group position={[bx, by, bz]}>
          <FurnitureRotationRing3D
            radius={Math.max(0.3, widthM)}
            highlighted={ringHighlight}
            isDashed={isDragging}
            onRingPointerDown={startRotate}
            onRingPointerOver={(e) => {
              if (dragRef.current) return;
              const p = intersectAtY(e.clientX, e.clientY, by);
              const ringR = Math.max(0.3, widthM);
              setRingMeshHover(!!p && isPointerOnFurnitureRingXZ({ x: p.x, z: p.z }, { x: bx, z: bz }, ringR));
            }}
            onRingPointerOut={() => setRingMeshHover(false)}
          />
        </group>
      )}
    </group>
  );
};

function Beams3D({
  beams,
  centerMm,
  polygonMm,
  roomHeight,
  wallHiddenRef,
  selectedBeamId,
  onBeamSelect,
  onBeamPatch,
  editable,
  onDragStart,
  onDragEnd,
  selections,
  materialSettings,
  captureStep,
  onHoverNameChange,
}: {
  beams: Beam[];
  centerMm: Point | undefined;
  polygonMm?: Point[];
  roomHeight: number;
  wallHiddenRef?: React.MutableRefObject<Record<number, boolean>>;
  selectedBeamId?: string | null;
  onBeamSelect?: (id: string | null) => void;
  onBeamPatch?: (id: string, patch: Partial<Beam>) => void;
  editable?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  selections?: Record<string, Product | null>;
  materialSettings?: any;
  captureStep?: any;
  onHoverNameChange?: (name: string | null) => void;
}) {
  // 2b(3D): 壁梁のコーナー接合用に「エッジ index → 寸法(幅/高さ/下がり)」を集計。
  // beams が変わった時だけ Map を作り直す。毎レンダーで新 Map 参照を子へ渡すと、子側の角柱
  // useMemo（依存に含む）が毎回作り直され BufferGeometry を生成/破棄し続けるため。
  const beamDimsByWallIndex = useMemo(() => {
    const m = new Map<number, WallBeamDims>();
    for (const b of beams) {
      if (b.wallIndex !== undefined) m.set(b.wallIndex, { widthMm: b.widthMm, heightMm: b.heightMm, dropMm: b.dropMm });
    }
    return m;
  }, [beams]);
  if (!centerMm || beams.length === 0) return null;
  return (
    <group>
      {beams.map((b) => (
        <Beam3DMesh
          key={b.id}
          beam={b}
          centerMm={centerMm}
          polygonMm={polygonMm}
          roomHeight={roomHeight}
          isSelected={selectedBeamId === b.id}
          editable={!!editable}
          onSelect={() => onBeamSelect?.(b.id)}
          onPatch={(patch) => onBeamPatch?.(b.id, patch)}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          wallHiddenRef={wallHiddenRef}
          selections={selections}
          materialSettings={materialSettings}
          captureStep={captureStep}
          onHoverNameChange={onHoverNameChange}
          beamDimsByWallIndex={beamDimsByWallIndex}
        />
      ))}
    </group>
  );
}

interface RoomViewerProps {
  selections: Record<string, Product | null>;
  onMeshClick: (category: MaterialCategory, meshName: string, isMulti: boolean) => void;
  activeCategory: MaterialCategory | null;
  activeMeshes: string[];
  modelUrl?: string | null;
  cameraRef: React.MutableRefObject<THREE.PerspectiveCamera | null>;
  sketchPoints: { x: number, y: number }[];
  roomHeight: number; // m
  snapshotMode?: boolean; // Used ONLY to hide highlights & grid
  furnitureItems: FurnitureItem[];
  onFurnitureUpdate: React.Dispatch<React.SetStateAction<FurnitureItem[]>>;
  beams?: Beam[];
  /** スケルトン天井: 天井スラブを非表示にして梁などの上部構造を露出する。 */
  skeletonCeiling?: boolean;
  /** スケルトン天井時の上部壁バンドの高さ(mm)。既定1000。 */
  skeletonUpperWallMm?: number;
  /** 3Dでの梁の直接操作（移動/回転）をストアへ反映する。 */
  onBeamPatch?: (id: string, patch: Partial<Beam>) => void;
  /** 3Dで梁を選択/解除したことを App へ通知（右パネル表示・素材割当のため）（4a）。 */
  onBeamSelect3D?: (id: string | null) => void;
  activeFurnitureId: string | null;
  onFurnitureSelect: (id: string | null, additive?: boolean) => void;
  hideFurniture?: boolean; // New Prop for empty room capture
  maskMode?: boolean; // New Prop for mask generation (Black background, white furniture)
  materialSettings: Record<string, { roughness: number, metalness: number, textureScale?: number, baseboardEnabled?: boolean, baseboardHeight?: number, baseboardColor?: string, wainscotHeight?: number, doorColor?: string, doorFrameColor?: string, windowFrameColor?: string }>;
  wallDivisions: Record<number, number>;
  isRendering?: boolean;
  captureStep?: 'idle' | 'pt-base' | 'mask';
  openings: Opening[];
  setOpenings: React.Dispatch<React.SetStateAction<Opening[]>>;
  selectedOpeningId: string | null;
  onOpeningSelect: (id: string | null) => void;
  outsideBackgroundColor?: string;
  orbitControlsRef: React.MutableRefObject<OrbitControlsImpl | null>;
  cameraBlendRequest: CameraBlendRequest | null;
  onCameraBlendComplete?: () => void;
  cameraMode: 'orbit' | 'walk';
  cameraFov: number;
  eyeHeightMm: number;
  walkSessionKey: number;
  walkInitialYaw: number;
  walkInitialPitch: number;
  walkSpawnXZ: [number, number] | null;
  walkDigitalInputRef: React.MutableRefObject<{ forward: number; strafe: number; rotate: number; reset: boolean }>;
  cameraWalkStateRef: React.MutableRefObject<{ yaw: number; pitch: number }>;
}

interface DynamicMaterialProps {
  product: Product | null;
  captureStep?: 'idle' | 'pt-base' | 'mask';
  isFloor?: boolean;
  meshRef: React.RefObject<THREE.Mesh | null>;
  /** 壁など：ワールド寸法（m）を渡すと bbox ではなくここから repeat を計算する */
  surfaceWidthM?: number;
  surfaceHeightM?: number;
}

function getTextureImageSize(texture: THREE.Texture): { width: number; height: number } | null {
  const img = texture.image as HTMLImageElement | HTMLCanvasElement | undefined;
  if (img && img.width && img.height) {
    return { width: img.width, height: img.height };
  }
  return null;
}

function getSurfaceSizeFromMesh(mesh: THREE.Mesh): { widthM: number; heightM: number } | null {
  const geom = mesh.geometry;
  if (!geom) return null;
  geom.computeBoundingBox();
  const bbox = geom.boundingBox;
  if (!bbox) return null;
  const sx = Math.abs(bbox.max.x - bbox.min.x);
  const sy = Math.abs(bbox.max.y - bbox.min.y);
  const sz = Math.abs(bbox.max.z - bbox.min.z);
  const sorted = [sx, sy, sz].sort((a, b) => b - a);
  const widthM = sorted[0] ?? 0;
  const heightM = sorted[1] ?? 0;
  if (!(widthM > 0) || !(heightM > 0)) return null;
  return { widthM, heightM };
}

function applyRealSizeTextureRepeat(
  texture: THREE.Texture,
  shortEdgeMeters: number,
  surfaceWidthM?: number,
  surfaceHeightM?: number,
  tileMeters?: { widthM: number; heightM: number } | null,
  uvInMeters?: boolean,
): void {
  const surfaceKnown =
    surfaceWidthM != null &&
    surfaceHeightM != null &&
    Number.isFinite(surfaceWidthM) &&
    Number.isFinite(surfaceHeightM) &&
    surfaceWidthM > 0 &&
    surfaceHeightM > 0;

  // まず「1タイルの実寸(幅×高さ・m)」を決める。実寸メタ(tileMeters)があればそれを使い（画像px比・短辺正規化に非依存＝
  // K タイル等でも正しい）、無ければ短辺実寸＋画像ピクセル比から算出（アップロード素材のフォールバック）。
  let tileW: number;
  let tileH: number;
  if (tileMeters && tileMeters.widthM > 0 && tileMeters.heightM > 0) {
    tileW = tileMeters.widthM;
    tileH = tileMeters.heightM;
  } else {
    const safeShortEdgeM = Math.max(0.1, shortEdgeMeters);
    const imageSize = getTextureImageSize(texture);
    const imageWidth = imageSize?.width ?? 1;
    const imageHeight = imageSize?.height ?? 1;
    const isLandscape = imageWidth >= imageHeight;
    const longEdgeFactor = isLandscape ? imageWidth / imageHeight : imageHeight / imageWidth;
    tileW = isLandscape ? safeShortEdgeM * longEdgeFactor : safeShortEdgeM;
    tileH = isLandscape ? safeShortEdgeM : safeShortEdgeM * longEdgeFactor;
  }

  if (uvInMeters) {
    // ShapeGeometry 等は UV が「実寸(m)そのもの」（three.js の shape UV は頂点座標=m）。この場合 1タイル=1/repeat[m]
    // なので repeat=1/タイル実寸。**面サイズに依存しない**ため、床/壁/天井の面積を変えても1タイルの寸法は一定
    // （面積変化でブロックが伸縮するバグの修正・260701）。
    texture.repeat.set(1 / tileW, 1 / tileH);
  } else if (surfaceKnown) {
    // UV 0..1（梁プリズム/箱・カスタムモデル等）: 面の実寸 ÷ タイル実寸 が繰り返し回数。1タイル=タイル実寸で一定。
    texture.repeat.set((surfaceWidthM as number) / tileW, (surfaceHeightM as number) / tileH);
  } else {
    // 0..1 かつ面サイズ不明: アスペクト比のみ反映（長辺=1）。
    const long = Math.max(tileW, tileH);
    const short = Math.min(tileW, tileH);
    const lf = short > 0 ? long / short : 1;
    const landscape = tileW >= tileH;
    texture.repeat.set(landscape ? 1 / lf : 1, landscape ? 1 : 1 / lf);
  }
  texture.needsUpdate = true;
}

const updateMeshMaterial = (mesh: THREE.Mesh, prod: Product | null, materialSettings: any, captureStep?: string) => {
    if (captureStep === 'mask') {
        mesh.material = new THREE.MeshBasicMaterial({ color: 0x000000 });
        return;
    }
    if (!prod) {
        mesh.material = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.8 });
        return;
    }
    const settings = materialSettings[prod.id] || {};
    // 実寸投影: 素材の物理メタ（mm）から短辺実寸を決める（手動 textureScale が最優先）。
    const shortEdgeMeters = effectiveTextureShortEdgeMeters(prod.physical, settings.textureScale);
    const tileMeters = effectiveTextureTileMeters(prod.physical, settings.textureScale); // 実寸(幅×高さ)＝画像px比より優先
    const surface = getSurfaceSizeFromMesh(mesh);
    const uvInMeters = mesh.geometry?.type === 'ShapeGeometry'; // ShapeGeometry の UV は実寸(m) → repeat=1/タイルで面積非依存
    const rotationRad = THREE.MathUtils.degToRad(settings.textureRotation ?? 0);
    // ラップ/実寸リピート/回転をまとめて適用。画像未ロード時はサイズ不明で 1x1（正方形）になり非正方形が歪むため、
    // TextureLoader の onLoad でも再適用して実寸＋アスペクト比を確定させる（260701 修正）。
    const applyTx = (tx: THREE.Texture) => {
      tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
      tx.colorSpace = THREE.SRGBColorSpace;
      tx.center.set(0.5, 0.5);
      tx.rotation = rotationRad; // テクスチャの向き（度・260613 row 164）
      applyRealSizeTextureRepeat(tx, shortEdgeMeters, surface?.widthM, surface?.heightM, tileMeters, uvInMeters);
      tx.needsUpdate = true;
    };
    const texture = new THREE.TextureLoader().load(prod.textureUrl, applyTx);
    applyTx(texture); // 初期適用（ロード完了時に applyTx が実寸/アスペクトを再確定）

    mesh.material = new THREE.MeshStandardMaterial({
        map: texture,
        roughness: settings.roughness ?? prod.pbr.roughness,
        metalness: settings.metalness ?? prod.pbr.metalness,
        side: THREE.FrontSide
    });
};

interface TexturedMaterialProps {
  textureUrl: string;
  meshRef: React.RefObject<THREE.Mesh | null>;
  product: Product;
  materialSettings: any;
  surfaceWidthM?: number;
  surfaceHeightM?: number;
  /** 壁など片面ジオメトリで両面描画する（凹形状でも面が消えないように・260611 Sec3）。 */
  doubleSided?: boolean;
}

const TexturedMaterial: React.FC<TexturedMaterialProps> = ({
  textureUrl,
  meshRef,
  product,
  materialSettings,
  surfaceWidthM,
  surfaceHeightM,
  doubleSided,
}) => {
  const texture = useTexture(textureUrl);
  /** useTexture は URL 単位でキャッシュするため、腰壁の上下など同一 URL の面で repeat が競合する。インスタンスごとに clone する */
  const mapTexture = useMemo(() => {
    const t = texture.clone();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [texture]);

  useEffect(() => {
    return () => {
      mapTexture.dispose();
    };
  }, [mapTexture]);

  const settings = materialSettings[product.id] || {};

  const applyTextureRepeat = useCallback(() => {
    if (!mapTexture) return;
    const mesh = meshRef.current;
    if (!mesh) return;

    let w: number | undefined;
    let h: number | undefined;
    if (surfaceWidthM != null && surfaceHeightM != null && surfaceWidthM > 0 && surfaceHeightM > 0) {
      w = surfaceWidthM;
      h = surfaceHeightM;
    } else if (mesh.geometry.type === 'ShapeGeometry' || mesh.geometry.type === 'PlaneGeometry') {
      mesh.geometry.computeBoundingBox();
      const bbox = mesh.geometry.boundingBox;
      if (bbox) {
        w = bbox.max.x - bbox.min.x;
        h = bbox.max.y - bbox.min.y;
      }
    }

    // 実寸投影: 実寸メタ（幅×高さmm）があれば実寸どおりにタイリング（画像ピクセル比に依存しない・260701）。
    // 無い素材は短辺実寸＋画像ピクセル比へフォールバック（effectiveTextureShortEdgeMeters）。
    // UV が実寸(m)の面は repeat=1/タイル（面積を変えてもブロック寸法一定＋回転で歪まない・260701/260702）。
    // 対象: ShapeGeometry（床/壁/天井/上部壁）＋ 梁プリズム（userData.uvInMeters）。梁の箱(BoxGeometry, UV0..1)等は従来の 面/タイル。
    const uvInMeters = mesh.geometry.type === 'ShapeGeometry' || mesh.geometry.userData?.uvInMeters === true;
    applyRealSizeTextureRepeat(
      mapTexture,
      effectiveTextureShortEdgeMeters(product.physical, settings.textureScale),
      w,
      h,
      effectiveTextureTileMeters(product.physical, settings.textureScale),
      uvInMeters,
    );
    // テクスチャの向き（度）。中心回転にして任意角度で貼り付け（260613・row 164）。
    mapTexture.center.set(0.5, 0.5);
    mapTexture.rotation = THREE.MathUtils.degToRad(settings.textureRotation ?? 0);
    mapTexture.needsUpdate = true;
  }, [mapTexture, meshRef, product, settings.textureScale, settings.textureRotation, surfaceWidthM, surfaceHeightM]);

  useLayoutEffect(() => {
    applyTextureRepeat();
    if (meshRef.current) return;
    const id = requestAnimationFrame(() => applyTextureRepeat());
    return () => cancelAnimationFrame(id);
  }, [applyTextureRepeat, meshRef]);

  return (
    <meshStandardMaterial
      map={mapTexture}
      roughness={settings.roughness ?? product.pbr.roughness}
      metalness={settings.metalness ?? product.pbr.metalness}
      envMapIntensity={1.0}
      side={doubleSided ? THREE.DoubleSide : THREE.FrontSide}
      polygonOffset
      polygonOffsetFactor={1}
      polygonOffsetUnits={1}
    />
  );
};

// テクスチャ読み込み失敗（削除済みアップロードの 404 等）でも 3D 全体を巻き込まず、
// その面だけ既定マテリアルへフォールバックするための小さなエラーバウンダリ。
// useTexture は 404 で throw するが <Suspense> は throw を捕捉しないため、これが無いと
// 1枚の dead URL でルーム共有の CanvasErrorBoundary が発火し、ルーム全体が消えてしまう。
class MaterialErrorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: unknown) {
    // テクスチャ取得失敗（削除済みアップロードの 404 等）は既定マテリアルで描画を継続する。
    // 致命ではないが、404 以外の本当の不具合を握りつぶさないよう警告だけは残す（CanvasErrorBoundary と同様）。
    console.warn('[material] テクスチャ読み込みに失敗したため既定マテリアルで描画します', error);
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

const DynamicMaterial: React.FC<DynamicMaterialProps & { materialSettings: any; doubleSided?: boolean }> = ({
  product,
  captureStep,
  isFloor,
  meshRef,
  materialSettings,
  surfaceWidthM,
  surfaceHeightM,
  doubleSided,
}) => {
  const side = doubleSided ? THREE.DoubleSide : THREE.FrontSide;
  if (captureStep === 'mask') {
    return <meshBasicMaterial color={0x000000} side={side} />;
  }

  if (!product || !product.textureUrl) {
    return <meshStandardMaterial color={isFloor ? 0x8b5a2b : DEFAULT_SURFACE_COLOR} roughness={0.8} side={side} />;
  }

  // 既定マテリアル（読み込み中の Suspense フォールバック＝失敗時のフォールバックを共通化）。
  const fallbackMaterial = (
    <meshStandardMaterial color={isFloor ? 0x8b5a2b : DEFAULT_SURFACE_COLOR} roughness={0.8} side={side} />
  );

  return (
    // key=textureUrl: 新しい有効なテクスチャに差し替えたら hasError をリセットして再試行する。
    <MaterialErrorBoundary key={product.textureUrl} fallback={fallbackMaterial}>
      <Suspense fallback={fallbackMaterial}>
        <TexturedMaterial
          textureUrl={product.textureUrl}
          meshRef={meshRef}
          product={product}
          materialSettings={materialSettings}
          surfaceWidthM={surfaceWidthM}
          surfaceHeightM={surfaceHeightM}
          doubleSided={doubleSided}
        />
      </Suspense>
    </MaterialErrorBoundary>
  );
};

// 既定（未割当）のサーフェス色。壁・天井・梁で共有し、梁の初期色を壁/天井と揃える（260611 2c）。
const DEFAULT_SURFACE_COLOR = 0xcccccc;
const OUTLINE_SELECTED_COLOR = '#ff8800';
const OUTLINE_HOVER_COLOR = '#38bdf8';
const FURNITURE_NAME_PREFIX = 'Furniture_';
const OPENING_NAME_PREFIX = 'Opening_';
const POST_DRAG_GUARD_MS = 120;

// Black Structural Edges - リアルな表現のため完全に無効化
const StructuralEdges = ({ snapshotMode = false }: { snapshotMode?: boolean }) => {
  return null; // 黒い線を完全に消す
};

const SceneOutlineEffects: React.FC<{
  selectedNames: string[];
  hoveredName: string | null;
  editingActive: boolean;
  enabled: boolean;
}> = ({ selectedNames, hoveredName, editingActive, enabled }) => {
  const { scene, camera, gl, size, clock } = useThree();
  const composerRef = useRef<ThreeEffectComposer | null>(null);
  const selectedPassRef = useRef<OutlinePass | null>(null);
  const hoverPassRef = useRef<OutlinePass | null>(null);

  const resolveSelectedObjects = useCallback((): THREE.Object3D[] => {
    if (!enabled || selectedNames.length === 0) return [];
    const nameSet = new Set(selectedNames);
    const objs: THREE.Object3D[] = [];
    scene.traverse((obj) => {
      if (nameSet.has(obj.name)) objs.push(obj);
    });
    return objs;
  }, [enabled, scene, selectedNames]);

  const resolveHoveredObjects = useCallback((): THREE.Object3D[] => {
    if (!enabled || !hoveredName) return [];
    const objs: THREE.Object3D[] = [];
    scene.traverse((obj) => {
      if (obj.name === hoveredName) objs.push(obj);
    });
    return objs;
  }, [enabled, hoveredName, scene]);

  useEffect(() => {
    const composer = new ThreeEffectComposer(gl);
    composerRef.current = composer;

    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    const selectedPass = new OutlinePass(new THREE.Vector2(size.width, size.height), scene, camera);
    selectedPass.visibleEdgeColor.set(OUTLINE_SELECTED_COLOR);
    selectedPass.hiddenEdgeColor.set(OUTLINE_SELECTED_COLOR);
    selectedPass.edgeStrength = 6.8;
    selectedPass.edgeThickness = 3.0;
    selectedPass.pulsePeriod = 0;
    selectedPassRef.current = selectedPass;
    composer.addPass(selectedPass);

    const hoverPass = new OutlinePass(new THREE.Vector2(size.width, size.height), scene, camera);
    hoverPass.visibleEdgeColor.set(OUTLINE_HOVER_COLOR);
    hoverPass.hiddenEdgeColor.set(OUTLINE_HOVER_COLOR);
    hoverPass.edgeStrength = 4.5;
    hoverPass.edgeThickness = 2.1;
    hoverPass.pulsePeriod = 0;
    hoverPassRef.current = hoverPass;
    composer.addPass(hoverPass);
    composer.addPass(new OutputPass());

    return () => {
      composerRef.current = null;
      selectedPassRef.current = null;
      hoverPassRef.current = null;
      composer.dispose();
    };
  }, [camera, gl, scene, size.height, size.width]);

  useEffect(() => {
    composerRef.current?.setSize(size.width, size.height);
    selectedPassRef.current?.setSize(size.width, size.height);
    hoverPassRef.current?.setSize(size.width, size.height);
  }, [size.width, size.height]);

  useEffect(() => {
    const selectedPass = selectedPassRef.current;
    const hoverPass = hoverPassRef.current;
    if (!selectedPass || !hoverPass) return;

    const applyResolvedObjects = () => {
      selectedPass.selectedObjects = enabled ? resolveSelectedObjects() : [];
      hoverPass.selectedObjects = enabled ? resolveHoveredObjects() : [];
    };

    // Commit後に解決し、追加直後のscene反映ズレを吸収する
    applyResolvedObjects();
    const raf = requestAnimationFrame(applyResolvedObjects);
    return () => cancelAnimationFrame(raf);
  }, [enabled, resolveSelectedObjects, resolveHoveredObjects]);

  useFrame(() => {
    const composer = composerRef.current;
    const selectedPass = selectedPassRef.current;
    if (!composer || !selectedPass) return;
    if (!enabled) {
      gl.render(scene, camera);
      return;
    }
    const pulse = 0.85 + 0.15 * (0.5 + 0.5 * Math.sin((clock.elapsedTime / 1.2) * Math.PI * 2));
    selectedPass.edgeStrength = editingActive ? 8.5 * pulse : 6.8;
    composer.render();
  }, 1);

  return null;
};

interface CanvasErrorBoundaryProps {
  children?: React.ReactNode;
}

interface CanvasErrorBoundaryState {
  hasError: boolean;
}

class CanvasErrorBoundary extends React.Component<CanvasErrorBoundaryProps, CanvasErrorBoundaryState> {
  // Explicitly declare state property for TypeScript compatibility
  public state: CanvasErrorBoundaryState = { hasError: false };
  // Explicitly declare props to satisfy TS if it's missing from base type inference
  public props: CanvasErrorBoundaryProps;

  constructor(props: CanvasErrorBoundaryProps) {
    super(props);
    this.props = props;
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: any) {
    console.error("Canvas Render Error:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <group>
          <mesh>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial color="red" wireframe />
          </mesh>
        </group>
      );
    }
    return this.props.children;
  }
}

// 読み込み中、またはエラー時に表示される仮のワイヤーフレームボックス
const FurnitureFallback = ({ modelUrl }: { modelUrl?: string }) => {
    useEffect(() => {
        if (modelUrl) {
            console.warn(
                '[RoomViewer] 家具モデル読み込み中（長く止まる場合は URL / ネットワーク / CORS を確認）:',
                modelUrl
            );
        }
    }, [modelUrl]);
    return (
        <mesh position={[0, 0.5, 0]}>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial color="#00ff00" wireframe />
        </mesh>
    );
};

// 読み込んだモデルのルートにクローン＆座標補正＆クレイ（白粘土）マテリアルを適用して描画する共通部分。
// 形式（glTF/FBX/OBJ）に依存せず Object3D を受け取る。
const ClayModel = ({
    object,
    format,
    maskMode,
    isSelected,
    captureStep,
    alignTop
}: {
    object: THREE.Object3D;
    /** 読み込み形式。FBX/OBJ は単位が一定でないため描画前にサイズ正規化する。 */
    format?: ModelFormat | null;
    maskMode?: boolean;
    isSelected?: boolean;
    captureStep?: 'idle' | 'pt-base' | 'mask';
    /** true のとき、モデルの「最上端」をグループ原点に合わせる（天井から吊り下げる天井オブジェクト用）。 */
    alignTop?: boolean;
}) => {
    // クローンと座標補正は「最初の1回」だけ行う（ここで計算を確定させる）
    const clonedScene = useMemo(() => {
        const clone = object.clone();
        // FBX/OBJ は単位がまちまち（FBX は cm 慣習で約100倍になりがち）。常識的な家具サイズへ正規化する。
        // glTF はカタログが 1単位=1m 前提で作られているため正規化しない（既存挙動を維持）。
        if (format === 'fbx' || format === 'obj') {
            const preBox = new THREE.Box3().setFromObject(clone);
            const sz = preBox.getSize(new THREE.Vector3());
            const s = exoticNormalizeScale(Math.max(sz.x, sz.y, sz.z));
            if (s !== 1) clone.scale.multiplyScalar(s);
        }
        const box = new THREE.Box3().setFromObject(clone);
        const center = box.getCenter(new THREE.Vector3());
        clone.position.x = -center.x;
        // 通常は最下端を原点（床置き）。天井オブジェクトは最上端を原点に合わせて天井から吊り下げる。
        clone.position.y = alignTop ? -box.max.y : -box.min.y;
        clone.position.z = -center.z;
        return clone;
    }, [object, alignTop, format]);

    // maskMode が変わった時は「マテリアル（色）」だけを変える（座標は絶対にいじらない）
    useEffect(() => {
        clonedScene.traverse((child: any) => {
            if (child.isMesh) {
                child.castShadow = !maskMode && captureStep !== 'mask';
                child.receiveShadow = !maskMode && captureStep !== 'mask';

                if (captureStep === 'mask') {
                    // 自動マスク生成モード：選択中の家具は白、それ以外は黒
                    child.material = new THREE.MeshBasicMaterial({
                        color: isSelected ? 0xffffff : 0x000000
                    });
                } else {
                    child.material = maskMode
                        ? new THREE.MeshBasicMaterial({ color: 0xffffff })
                        : new THREE.MeshStandardMaterial({
                            color: 0xe0e0e0, // 暗いグレー(0x888888)から明るい白に変更し、光を拾わせる
                            roughness: 0.9,
                            metalness: 0.0,
                            map: null,
                            normalMap: null
                        });
                }
            }
        });
    }, [clonedScene, maskMode, captureStep, isSelected]);

    return <primitive object={clonedScene} />;
};

// 実際の3Dモデル（glTF/FBX/OBJ）を読み込み、クレイ（白粘土）マテリアルを適用するコア部分。
// 読み込みは ModelRoot が形式ごとに分岐（glTF=useGLTF / FBX・OBJ=useLoader）。
const GLTFCore = ({
    modelUrl,
    maskMode,
    isSelected,
    snapshotMode: _snapshotMode,
    captureStep,
    alignTop
}: {
    modelUrl: string;
    maskMode?: boolean;
    isSelected?: boolean;
    snapshotMode?: boolean;
    captureStep?: 'idle' | 'pt-base' | 'mask';
    /** true のとき、モデルの「最上端」をグループ原点に合わせる（天井から吊り下げる天井オブジェクト用）。 */
    alignTop?: boolean;
}) => {
    return (
        <ModelRoot url={modelUrl}>
            {(object, format) => (
                <ClayModel
                    object={object}
                    format={format}
                    maskMode={maskMode}
                    isSelected={isSelected}
                    captureStep={captureStep}
                    alignTop={alignTop}
                />
            )}
        </ModelRoot>
    );
};

/** 足跡に合わせた半径（m）。弧＋不可視ヒット用チューブ */
function getFurnitureRingRadiusM(item: FurnitureItem): number {
    const { width, depth } = getFurnitureFootprintMm(item);
    const w = width / MM_PER_METER;
    const d = depth / MM_PER_METER;
    const raw = Math.hypot(w, d) / 2 + 0.08;
    return Math.max(0.22, Math.min(1.15, raw));
}

function arcTubeGeometryXZ(radius: number, a0: number, a1: number, y: number, tubeRadius: number): THREE.TubeGeometry {
    const ec = new THREE.EllipseCurve(0, 0, radius, radius, a0, a1, false, 0);
    const pts = ec.getPoints(40).map((p) => new THREE.Vector3(p.x, y, p.y));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
    return new THREE.TubeGeometry(curve, 40, tubeRadius, 6, false);
}

const FURNITURE_RING_COLOR = 0x2563eb;
const FURNITURE_RING_COLOR_HI = 0x60a5fd;
const RING_ARC_Y = 0.05;
const RING_VIS_TUBE_R = 0.016;
/** 可視チューブの約 2.5 倍。レイで弧を拾いやすくする */
const RING_HIT_TUBE_R = 0.04;
/** リング円周からの許容（m）。梁の回転リング用（260703 で梁は広めに維持）。 */
const RING_RADIAL_TOLERANCE_M = 0.065;
/** 家具の回転リングは判定が敏感すぎて移動しづらいとの報告（260703）→ 家具のみ狭める。 */
const FURNITURE_RING_RADIAL_TOLERANCE_M = 0.03;
/** 移動開始判定：足跡矩形を各辺方向に拡張（m） */
const MOVE_FOOTPRINT_MARGIN_M = 0.05;
/** 2D の FURNITURE_ROTATION_SNAP_RAD と同じ（10°） */
const FURNITURE_ROTATION_SNAP_RAD = (10 * Math.PI) / 180;

/** ワールド XZ 上の点が家具足跡（ローカル幅・奥行き、Y 回転）内か。marginM で半辺ごと拡張 */
function isPointInFurnitureFootprintXZ(
    px: number,
    pz: number,
    cx: number,
    cz: number,
    yaw: number,
    widthM: number,
    depthM: number,
    marginM = 0
): boolean {
    const dx = px - cx;
    const dz = pz - cz;
    const c = Math.cos(-yaw);
    const s = Math.sin(-yaw);
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    const hw = widthM / 2 + marginM;
    const hd = depthM / 2 + marginM;
    return Math.abs(lx) <= hw && Math.abs(lz) <= hd;
}

function arcLineGeometryXZFlat(radius: number, a0: number, a1: number, y: number): THREE.BufferGeometry {
    const ec = new THREE.EllipseCurve(0, 0, radius, radius, a0, a1, false, 0);
    const pts = ec.getPoints(72).map((p) => new THREE.Vector3(p.x, y, p.y));
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    return g;
}

/** チューブ弧と同一 EllipseCurve の終端位置（XZ）と接線（XZ、正規化）。円錐を弧の終点に合わせる */
function ringArcEndPositionAndTangent(
    radius: number,
    a0: number,
    a1: number
): { px: number; pz: number; quat: THREE.Quaternion } {
    const ec = new THREE.EllipseCurve(0, 0, radius, radius, a0, a1, false, 0);
    const pt = ec.getPointAt(1);
    const tang2 = ec.getTangentAt(1);
    const tang = new THREE.Vector3(tang2.x, 0, tang2.y).normalize();
    const q = new THREE.Quaternion();
    q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tang);
    return { px: pt.x, pz: pt.y, quat: q };
}

/** 床面点の中心からの方位が、左右の可視弧のいずれかの角度範囲内か（EllipseCurve と a = atan2(dz,dx)） */
function isOnRingArcAngles(theta: number): boolean {
    const t = ((theta % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    if (t <= Math.PI / 4 || t >= (7 * Math.PI) / 4) return true;
    if (t >= (3 * Math.PI) / 4 && t <= (5 * Math.PI) / 4) return true;
    return false;
}

/** 青い太チューブ弧＋矢印。回転ドラッグ中は破線 Line。ワールド水平（親で位置のみ） */
const FurnitureRotationRing3D: React.FC<{
    radius: number;
    highlighted: boolean;
    isDashed: boolean;
    onRingPointerDown: (e: ThreeEvent<PointerEvent>) => void;
    onRingPointerOver: (e: ThreeEvent<PointerEvent>) => void;
    onRingPointerOut: () => void;
}> = ({ radius, highlighted, isDashed, onRingPointerDown, onRingPointerOver, onRingPointerOut }) => {
    const color = highlighted ? FURNITURE_RING_COLOR_HI : FURNITURE_RING_COLOR;

    const visMat = useMemo(
        () =>
            new THREE.MeshBasicMaterial({
                color: FURNITURE_RING_COLOR,
                depthTest: false,
                depthWrite: false,
                polygonOffset: true,
                polygonOffsetFactor: -1,
                polygonOffsetUnits: -4
            }),
        []
    );
    const hitMat = useMemo(
        () =>
            new THREE.MeshBasicMaterial({
                transparent: true,
                opacity: 0,
                depthWrite: false,
                side: THREE.DoubleSide
            }),
        []
    );

    const dashedMat = useMemo(
        () =>
            new THREE.LineDashedMaterial({
                color: FURNITURE_RING_COLOR,
                dashSize: 0.09,
                gapSize: 0.07,
                depthTest: false,
                depthWrite: false
            }),
        []
    );

    const { tubeVis0, tubeVis1, tubeHit0, tubeHit1, coneRight, coneLeft, lineD0, lineD1 } = useMemo(() => {
        const coneRight = ringArcEndPositionAndTangent(radius, (7 * Math.PI) / 4, Math.PI / 4);
        const coneLeft = ringArcEndPositionAndTangent(radius, (3 * Math.PI) / 4, (5 * Math.PI) / 4);
        return {
            tubeVis0: arcTubeGeometryXZ(radius, (7 * Math.PI) / 4, Math.PI / 4, RING_ARC_Y, RING_VIS_TUBE_R),
            tubeVis1: arcTubeGeometryXZ(radius, (3 * Math.PI) / 4, (5 * Math.PI) / 4, RING_ARC_Y, RING_VIS_TUBE_R),
            tubeHit0: arcTubeGeometryXZ(radius, (7 * Math.PI) / 4, Math.PI / 4, RING_ARC_Y, RING_HIT_TUBE_R),
            tubeHit1: arcTubeGeometryXZ(radius, (3 * Math.PI) / 4, (5 * Math.PI) / 4, RING_ARC_Y, RING_HIT_TUBE_R),
            coneRight,
            coneLeft,
            lineD0: arcLineGeometryXZFlat(radius, (7 * Math.PI) / 4, Math.PI / 4, RING_ARC_Y),
            lineD1: arcLineGeometryXZFlat(radius, (3 * Math.PI) / 4, (5 * Math.PI) / 4, RING_ARC_Y)
        };
    }, [radius]);

    const lineObj0 = useMemo(() => {
        const l = new THREE.Line(lineD0, dashedMat);
        l.computeLineDistances();
        l.renderOrder = 10;
        return l;
    }, [lineD0, dashedMat]);

    const lineObj1 = useMemo(() => {
        const l = new THREE.Line(lineD1, dashedMat);
        l.computeLineDistances();
        l.renderOrder = 10;
        return l;
    }, [lineD1, dashedMat]);

    useEffect(() => {
        visMat.color.setHex(color);
        dashedMat.color.setHex(color);
    }, [color, visMat, dashedMat]);

    const hitHandlers = {
        onPointerDown: onRingPointerDown,
        onPointerOver: (ev: ThreeEvent<PointerEvent>) => onRingPointerOver(ev),
        onPointerOut: onRingPointerOut
    };

    return (
        <group renderOrder={10}>
            {isDashed ? (
                <>
                    <primitive object={lineObj0} />
                    <group scale={[1, 1, -1]}>
                        <primitive object={lineObj1} />
                    </group>
                    <mesh geometry={tubeHit0} material={hitMat} renderOrder={10} {...hitHandlers} />
                    <group scale={[1, 1, -1]}>
                        <mesh geometry={tubeHit1} material={hitMat} renderOrder={10} {...hitHandlers} />
                    </group>
                </>
            ) : (
                <>
                    <mesh geometry={tubeVis0} material={visMat} renderOrder={10} />
                    <mesh geometry={tubeHit0} material={hitMat} renderOrder={10} {...hitHandlers} />
                    <group scale={[1, 1, -1]}>
                        <mesh geometry={tubeVis1} material={visMat} renderOrder={10} />
                        <mesh geometry={tubeHit1} material={hitMat} renderOrder={10} {...hitHandlers} />
                    </group>
                </>
            )}
            <mesh
                position={[coneRight.px, RING_ARC_Y, coneRight.pz]}
                quaternion={coneRight.quat}
                renderOrder={11}
                {...hitHandlers}
            >
                <coneGeometry args={[0.042, 0.095, 10]} />
                <meshBasicMaterial color={color} depthTest={false} depthWrite={false} />
            </mesh>
            <mesh
                position={[coneLeft.px, RING_ARC_Y, coneLeft.pz]}
                quaternion={coneLeft.quat}
                renderOrder={11}
                {...hitHandlers}
            >
                <coneGeometry args={[0.042, 0.095, 10]} />
                <meshBasicMaterial color={color} depthTest={false} depthWrite={false} />
            </mesh>
        </group>
    );
};

/** 床面点がリング弧（左右のセクタ）の近傍か */
function isPointerOnFurnitureRingXZ(
    p: { x: number; z: number },
    wx: { x: number; z: number },
    ringR: number,
    toleranceM: number = RING_RADIAL_TOLERANCE_M
): boolean {
    const dx = p.x - wx.x;
    const dz = p.z - wx.z;
    const dist = Math.hypot(dx, dz);
    if (Math.abs(dist - ringR) > toleranceM) return false;
    const theta = Math.atan2(dz, dx);
    return isOnRingArcAngles(theta);
}

/**
 * グループ回転ギズモ（260703 クライアント要望）。複数選択/グループの重心に1つだけ回転リングを表示し、
 * ドラッグで全メンバーを重心まわりに一括回転する（各メンバーの位置と yaw を applyGroupRotation で更新）。
 * ドラッグ中の可変コンテキスト（重心・メンバー・半径・コールバック）は ref で保持し、増分回転の再購読を防ぐ。
 * 増分は「開始角からの累積スナップ差分」を1回ずつ流すので、prev に対する回転合成が正しく積み上がる。
 */
const GroupRotationGizmo3D: React.FC<{
    centroidXZ: Vec2XZ;
    planeY: number;
    radius: number;
    memberIds: Set<string>;
    onGroupRotate: (memberIds: Set<string>, centroidXZ: Vec2XZ, dTheta: number) => void;
    onDragStart?: () => void;
    onDragEnd?: () => void;
    onPostDragGuard?: () => void;
}> = ({ centroidXZ, planeY, radius, memberIds, onGroupRotate, onDragStart, onDragEnd, onPostDragGuard }) => {
    const { camera, gl } = useThree();
    const plane = useMemo(() => new THREE.Plane(), []);
    const raycaster = useMemo(() => new THREE.Raycaster(), []);
    const ndc = useMemo(() => new THREE.Vector2(), []);
    const tmpHit = useMemo(() => new THREE.Vector3(), []);
    const draggingRef = useRef(false);
    const startAngleRef = useRef(0);
    const lastSnappedRef = useRef(0);
    // Undo履歴対策（260703 検証 M1）: 最初の増分は記録し(＝ドラッグ前状態を past に積む)、以降は temporal を
    // pause して1ドラッグ=1 Undo にする。resume はドラッグ終了・アンマウントの両方で確実に行う（paused 取り残し防止）。
    const pausedRef = useRef(false);
    const [isDragging, setIsDragging] = useState(false);
    const [ringHoverDist, setRingHoverDist] = useState(false);
    const [ringMeshHover, setRingMeshHover] = useState(false);
    const ringHighlight = ringHoverDist || ringMeshHover;

    // ドラッグ中に変化しうる（＝毎レンダ更新される）値は ref 経由で読み、ドラッグ効果を再購読させない。
    const ctxRef = useRef({ centroidXZ, memberIds, radius, planeY, onGroupRotate });
    ctxRef.current = { centroidXZ, memberIds, radius, planeY, onGroupRotate };

    const intersect = useCallback(
        (clientX: number, clientY: number) => {
            const rect = gl.domElement.getBoundingClientRect();
            ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
            ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(ndc, camera);
            plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, ctxRef.current.planeY, 0));
            return raycaster.ray.intersectPlane(plane, tmpHit) ? tmpHit.clone() : null;
        },
        [camera, gl, ndc, plane, raycaster, tmpHit]
    );

    // 重心基準の方位（3D 単体回転 atan2(dx,dz) と同系＝applyGroupRotation の dTheta 系に一致）。
    const angleAt = (p: THREE.Vector3) => Math.atan2(p.x - ctxRef.current.centroidXZ.x, p.z - ctxRef.current.centroidXZ.z);

    const startRotate = (e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        const p = intersect(e.clientX, e.clientY);
        if (!p) return;
        startAngleRef.current = angleAt(p);
        lastSnappedRef.current = 0;
        draggingRef.current = true;
        setIsDragging(true);
        onDragStart?.();
    };

    // ホバー帯判定（ドラッグ外）。
    useEffect(() => {
        const onMove = (e: PointerEvent) => {
            if (draggingRef.current) return;
            const p = intersect(e.clientX, e.clientY);
            const c = ctxRef.current;
            setRingHoverDist(
                !!p && isPointerOnFurnitureRingXZ({ x: p.x, z: p.z }, c.centroidXZ, c.radius, FURNITURE_RING_RADIAL_TOLERANCE_M)
            );
        };
        window.addEventListener('pointermove', onMove);
        return () => window.removeEventListener('pointermove', onMove);
    }, [intersect]);

    // 回転ドラッグ（累積スナップ差分を増分で流す）。
    useEffect(() => {
        const onMove = (e: PointerEvent) => {
            if (!draggingRef.current) return;
            const p = intersect(e.clientX, e.clientY);
            if (!p) return;
            const delta = angleAt(p) - startAngleRef.current;
            const snapped = Math.round(delta / FURNITURE_ROTATION_SNAP_RAD) * FURNITURE_ROTATION_SNAP_RAD;
            const inc = snapped - lastSnappedRef.current;
            if (inc !== 0) {
                lastSnappedRef.current = snapped;
                const c = ctxRef.current;
                c.onGroupRotate(c.memberIds, c.centroidXZ, inc);
                // 最初の増分（ドラッグ前→現在）を記録した直後に pause。以降の増分は履歴に積まない。
                if (!pausedRef.current) {
                    useProjectStore.temporal.getState().pause();
                    pausedRef.current = true;
                }
            }
        };
        const onUp = () => {
            if (!draggingRef.current) return;
            draggingRef.current = false;
            setIsDragging(false);
            if (pausedRef.current) {
                useProjectStore.temporal.getState().resume();
                pausedRef.current = false;
            }
            onPostDragGuard?.();
            onDragEnd?.();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
    }, [intersect, onDragEnd, onPostDragGuard]);

    const handleRingOver = (e: ThreeEvent<PointerEvent>) => {
        if (draggingRef.current) return;
        const p = intersect(e.clientX, e.clientY);
        const c = ctxRef.current;
        setRingMeshHover(
            !!p && isPointerOnFurnitureRingXZ({ x: p.x, z: p.z }, c.centroidXZ, c.radius, FURNITURE_RING_RADIAL_TOLERANCE_M)
        );
    };

    // アンマウント時（ドラッグ中に選択解除等で消えた場合）に paused を取り残さない安全策。
    useEffect(() => () => {
        if (pausedRef.current) {
            useProjectStore.temporal.getState().resume();
            pausedRef.current = false;
        }
    }, []);

    return (
        <group position={[centroidXZ.x, planeY, centroidXZ.z]}>
            <FurnitureRotationRing3D
                radius={radius}
                highlighted={ringHighlight}
                isDashed={isDragging}
                onRingPointerDown={startRotate}
                onRingPointerOver={handleRingOver}
                onRingPointerOut={() => setRingMeshHover(false)}
            />
        </group>
    );
};

/** 家具グループの世界座標にリングを追従（移動ドラッグ中も位置一致） */
const FurnitureRingAnchor: React.FC<{
    furnitureGroupRef: React.RefObject<THREE.Group | null>;
    children: React.ReactNode;
}> = ({ furnitureGroupRef, children }) => {
    const anchorRef = useRef<THREE.Group>(null);
    useFrame(() => {
        const g = furnitureGroupRef.current;
        const a = anchorRef.current;
        if (g && a) {
            g.getWorldPosition(a.position);
        }
    });
    return (
        <group ref={anchorRef} rotation={[0, 0, 0]}>
            {children}
        </group>
    );
};

/** 操作系：未選択時はクリックで選択のみ。選択後は床面距離で移動／回転を分岐（青リング・床ポリゴン内にクランプ） */
const GLTFFurniture: React.FC<{
    item: FurnitureItem;
    isSelected: boolean;
    onSelect?: (additive?: boolean) => void;
    isDraggingRef: React.MutableRefObject<boolean>;
    snapshotMode: boolean;
    maskMode?: boolean;
    captureStep?: 'idle' | 'pt-base' | 'mask';
    sketchFloorDrag?: boolean;
    centerMm?: Point;
    polygonMm?: Point[];
    onFurniturePatch?: (
        id: string,
        position: [number, number, number],
        rotation?: [number, number, number]
    ) => void;
    onFurnitureDragStart?: () => void;
    onFurnitureDragEnd?: () => void;
    onHoverNameChange?: (name: string | null) => void;
    onPostDragGuard?: () => void;
    /** グループ回転ギズモ表示中は個別リングを抑止（移動はそのまま可能・260703）。 */
    suppressRing?: boolean;
    /** 全家具メッシュのレジストリ（グループ移動で非ドラッグメンバーもリアルタイム追従させる用・260703）。 */
    meshRegistry?: React.MutableRefObject<Map<string, THREE.Group>>;
}> = ({
    item,
    isSelected,
    onSelect,
    isDraggingRef,
    snapshotMode,
    maskMode,
    captureStep,
    sketchFloorDrag,
    centerMm,
    polygonMm,
    onFurniturePatch,
    onFurnitureDragStart,
    onFurnitureDragEnd,
    onHoverNameChange,
    onPostDragGuard,
    suppressRing,
    meshRegistry
}) => {
    const [isHovered, setIsHovered] = useState(false);
    const groupRef = useRef<THREE.Group>(null);
    const draggingRef = useRef(false);
    const dragKindRef = useRef<'move' | 'rotate' | null>(null);
    // 移動ドラッグ中に一緒に動かすメンバー集合（ドラッグ確定前からメッシュを直接動かしリアルタイム追従させる）。
    const moveMembersRef = useRef<Set<string> | null>(null);
    const lastWorldRef = useRef(new THREE.Vector3());
    /** 回転ドラッグ開始時（累積 lastAngle ではスナップ時に逆回転しやすい） */
    const rotateDragStartYawRef = useRef(0);
    const rotateDragStartAngleRef = useRef(0);
    const { camera, gl } = useThree();
    const plane = useMemo(() => new THREE.Plane(), []);
    const raycaster = useMemo(() => new THREE.Raycaster(), []);
    const ndc = useMemo(() => new THREE.Vector2(), []);
    const tmpHit = useMemo(() => new THREE.Vector3(), []);
    const tmpPos = useMemo(() => new THREE.Vector3(), []);

    const ringRadiusM = useMemo(() => getFurnitureRingRadiusM(item), [item]);

    // group の position/rotation/scale を memo 化して参照を安定させる（260703 検証 M1）。
    // 未 memo だと毎レンダ新規 Vector3/Euler になり、R3F は「変化」と見なして item 値へ再適用する。
    // その結果、グループ移動でメッシュを直接動かしている非ドラッグメンバーが、ドラッグ中の再レンダ
    // （他要素の hover 等）で store 位置へ戻ってしまう。参照が安定なら再適用されず、直接移動が保たれる。
    const posVec = useMemo(() => new THREE.Vector3(...item.position), [item.position]);
    const rotEuler = useMemo(() => new THREE.Euler(...item.rotation), [item.rotation]);
    const scaleVec = useMemo(() => new THREE.Vector3(...item.scale), [item.scale]);

    // メッシュレジストリへ自身の group を登録（グループ移動で他メンバーのメッシュを直接動かすため）。
    useEffect(() => {
        if (!meshRegistry) return;
        const reg = meshRegistry;
        const g = groupRef.current;
        if (g) reg.current.set(item.id, g);
        return () => {
            reg.current.delete(item.id);
        };
    }, [item.id, meshRegistry]);

    const showTc =
        isSelected &&
        sketchFloorDrag &&
        !!centerMm &&
        !!polygonMm &&
        polygonMm.length >= 3 &&
        !snapshotMode &&
        !maskMode &&
        captureStep !== 'mask';
    // 個別の回転リング表示。グループ回転ギズモ表示中(suppressRing)は隠す（移動=onBodyPointerDown は showTc のまま維持）。
    const showRing = showTc && !suppressRing;

    const [pointerBusy, setPointerBusy] = useState(false);
    const [ringHoverDist, setRingHoverDist] = useState(false);
    const [ringMeshHover, setRingMeshHover] = useState(false);
    const [isRotateDragging, setIsRotateDragging] = useState(false);

    const ringHighlight = ringHoverDist || ringMeshHover;

    useEffect(() => {
        const g = groupRef.current;
        if (!g || draggingRef.current) return;
        g.position.set(item.position[0], item.position[1], item.position[2]);
        g.rotation.set(item.rotation[0], item.rotation[1], item.rotation[2]);
        g.scale.set(item.scale[0], item.scale[1], item.scale[2]);
    }, [item.position, item.rotation, item.scale]);

    const commitTransform = useCallback(() => {
        const g = groupRef.current;
        if (!g || !centerMm || !polygonMm || polygonMm.length < 3 || !onFurniturePatch) return;
        const draft: FurnitureItem = {
            ...item,
            position: [g.position.x, g.position.y, g.position.z],
            rotation: [g.rotation.x, g.rotation.y, g.rotation.z]
        };
        const clamped = clampFurnitureItemToRoom(draft, centerMm, polygonMm);
        // 移動時は rotation を渡さない（undefined）。回転値を常に渡すと下流の groupMove 判定(!rotation)が
        // 常に false になり、グループ/複数選択が一緒に動かない（260703 クライアント報告の原因）。回転ドラッグ時のみ渡す。
        onFurniturePatch(
          clamped.id,
          clamped.position,
          dragKindRef.current === 'rotate' ? clamped.rotation : undefined
        );
        g.position.set(clamped.position[0], clamped.position[1], clamped.position[2]);
        g.rotation.set(clamped.rotation[0], clamped.rotation[1], clamped.rotation[2]);
    }, [centerMm, polygonMm, item, onFurniturePatch]);

    const intersectFloor = useCallback(
        (clientX: number, clientY: number) => {
            const g = groupRef.current;
            if (!g) return null;
            const rect = gl.domElement.getBoundingClientRect();
            ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
            ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
            raycaster.setFromCamera(ndc, camera);
            const y = g.getWorldPosition(tmpPos).y;
            plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, y, 0));
            const out = raycaster.ray.intersectPlane(plane, tmpHit);
            return out ? tmpHit.clone() : null;
        },
        [camera, gl, ndc, plane, raycaster, tmpHit, tmpPos]
    );

    useEffect(() => {
        if (!showRing || !isSelected || snapshotMode || maskMode) {
            setRingHoverDist(false);
            return;
        }
        const onMove = (e: PointerEvent) => {
            if (draggingRef.current) return;
            const g = groupRef.current;
            if (!g) return;
            const p = intersectFloor(e.clientX, e.clientY);
            if (!p) {
                setRingHoverDist(false);
                return;
            }
            g.updateMatrixWorld(true);
            const wx = new THREE.Vector3();
            g.getWorldPosition(wx);
            const ringR = ringRadiusM;
            const onRingArc = isPointerOnFurnitureRingXZ(p, wx, ringR, FURNITURE_RING_RADIAL_TOLERANCE_M);
            setRingHoverDist(onRingArc);
        };
        window.addEventListener('pointermove', onMove);
        return () => window.removeEventListener('pointermove', onMove);
    }, [showRing, isSelected, snapshotMode, maskMode, intersectFloor, item, ringRadiusM]);

    const endDrag = useCallback(() => {
        if (!draggingRef.current) return;
        commitTransform();
        draggingRef.current = false;
        dragKindRef.current = null;
        moveMembersRef.current = null;
        setPointerBusy(false);
        setIsRotateDragging(false);
        setRingMeshHover(false);
        onPostDragGuard?.();
        onFurnitureDragEnd?.();
    }, [commitTransform, onFurnitureDragEnd, onPostDragGuard]);

    useEffect(() => {
        const onMove = (e: PointerEvent) => {
            if (!draggingRef.current || !groupRef.current) return;
            const g = groupRef.current;
            const p = intersectFloor(e.clientX, e.clientY);
            if (!p) return;
            if (dragKindRef.current === 'move') {
                const dx = p.x - lastWorldRef.current.x;
                const dz = p.z - lastWorldRef.current.z;
                const prevX = g.position.x;
                const prevZ = g.position.z;
                if (centerMm && polygonMm && polygonMm.length >= 3) {
                    const prevCenterMm = furniturePositionToMm(
                        [g.position.x, g.position.y, g.position.z],
                        centerMm
                    );
                    const proposedMm = {
                        x: prevCenterMm.x + dx * MM_PER_METER,
                        y: prevCenterMm.y + dz * MM_PER_METER
                    };
                    const { width, depth } = getFurnitureFootprintMm(item);
                    const nextMm = slideFurnitureCenterMmWithWallContact(
                        prevCenterMm,
                        proposedMm,
                        g.rotation.y,
                        width,
                        depth,
                        polygonMm
                    );
                    const np = mmToFurniturePosition(nextMm, g.position.y, centerMm);
                    g.position.x = np[0];
                    g.position.z = np[2];
                } else {
                    g.position.x += dx;
                    g.position.z += dz;
                }
                lastWorldRef.current.copy(p);
                // グループ/複数選択のメンバーを、ドラッグ対象と同じフレーム差分で直接動かしリアルタイム追従。
                // 確定(commit)時の applyFurniturePatch は「対象の総差分」で全員動かすため、ここの積算＝総差分に一致し飛びが無い。
                if (moveMembersRef.current && meshRegistry) {
                    const ddx = g.position.x - prevX;
                    const ddz = g.position.z - prevZ;
                    if (ddx !== 0 || ddz !== 0) {
                        for (const mid of moveMembersRef.current) {
                            const mg = meshRegistry.current.get(mid);
                            if (mg) {
                                mg.position.x += ddx;
                                mg.position.z += ddz;
                            }
                        }
                    }
                }
            } else if (dragKindRef.current === 'rotate') {
                g.updateMatrixWorld(true);
                const wx = new THREE.Vector3();
                g.getWorldPosition(wx);
                const ang = Math.atan2(p.x - wx.x, p.z - wx.z);
                let delta = ang - rotateDragStartAngleRef.current;
                while (delta > Math.PI) delta -= Math.PI * 2;
                while (delta < -Math.PI) delta += Math.PI * 2;
                let newY = rotateDragStartYawRef.current + delta;
                newY =
                    Math.round(newY / FURNITURE_ROTATION_SNAP_RAD) * FURNITURE_ROTATION_SNAP_RAD;
                g.rotation.y = newY;
            }
        };
        const onUp = () => endDrag();
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
    }, [endDrag, intersectFloor, centerMm, polygonMm, item]);

    useEffect(() => {
        if (snapshotMode || maskMode || captureStep === 'mask') {
            document.body.style.cursor = 'auto';
            return;
        }
        if (pointerBusy) {
            document.body.style.cursor = 'grabbing';
        } else if (ringHighlight && showTc && isSelected) {
            document.body.style.cursor = 'grab';
        } else if (isHovered && isSelected && showTc) {
            document.body.style.cursor = 'grab';
        } else if (isHovered && !isSelected) {
            document.body.style.cursor = 'pointer';
        } else if (isHovered) {
            document.body.style.cursor = 'pointer';
        } else {
            document.body.style.cursor = 'auto';
        }
        return () => {
            document.body.style.cursor = 'auto';
        };
    }, [
        isHovered,
        isSelected,
        showTc,
        snapshotMode,
        maskMode,
        captureStep,
        pointerBusy,
        ringHighlight
    ]);

    const onBodyPointerDown = (e: ThreeEvent<PointerEvent>) => {
        if (captureStep === 'mask' || maskMode || snapshotMode) return;
        e.stopPropagation();
        // Shift: 複数選択トグル（移動は開始しない）。260703 クライアント要望で Ctrl/Cmd は除外し Shift 専用に。
        const additive = e.nativeEvent.shiftKey;
        if (additive) {
            onSelect?.(true);
            return;
        }
        if (!isSelected) {
            onSelect?.(false);
            return;
        }
        if (!showTc) return;
        const g = groupRef.current;
        if (!g) return;
        g.updateMatrixWorld(true);
        const wx = new THREE.Vector3();
        g.getWorldPosition(wx);
        const floorY = wx.y;
        let p = intersectFloor(e.clientX, e.clientY);
        if (!p && e.point) {
            p = tmpHit.set(e.point.x, floorY, e.point.z);
        }
        if (!p) return;
        const ringR = ringRadiusM;
        // グループ回転ギズモ表示中(suppressRing→showRing=false)は、個別リングでの単体回転を起こさない
        // （隠れた個別リング帯を掴んで片方だけ回る不具合の修正・260703 クライアント報告）。回転はグループギズモが担う。
        const onRingArc = showRing && isPointerOnFurnitureRingXZ(p, wx, ringR, FURNITURE_RING_RADIAL_TOLERANCE_M);
        const { width, depth } = getFurnitureFootprintMm(item);
        const wM = width / MM_PER_METER;
        const dM = depth / MM_PER_METER;
        const yaw = g.rotation.y;
        const inFootprint = isPointInFurnitureFootprintXZ(
            p.x,
            p.z,
            wx.x,
            wx.z,
            yaw,
            wM,
            dM,
            MOVE_FOOTPRINT_MARGIN_M
        );
        const meshHit =
            (e.intersections?.length ?? 0) > 0 ||
            (e.object != null && e.object instanceof THREE.Mesh);

        if (onRingArc) {
            rotateDragStartYawRef.current = g.rotation.y;
            rotateDragStartAngleRef.current = Math.atan2(p.x - wx.x, p.z - wx.z);
            draggingRef.current = true;
            dragKindRef.current = 'rotate';
            setIsRotateDragging(true);
        } else if (inFootprint || meshHit) {
            lastWorldRef.current.copy(p);
            draggingRef.current = true;
            dragKindRef.current = 'move';
            // 一緒に動かすメンバー（所属グループ ∪ 複数選択）を控える。ドラッグ中に各メッシュを直接動かして
            // リアルタイム追従させる（従来はドラッグ確定=pointerupまで動かず「1テンポ遅れ」だった・260703 報告）。
            const st = useProjectStore.getState();
            const mm = resolveMoveMembers(item.id, st.scene.groups, st.selectedIds);
            mm.delete(item.id);
            moveMembersRef.current = mm.size > 0 ? mm : null;
        } else {
            return;
        }
        setPointerBusy(true);
        onFurnitureDragStart?.();
        try {
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        } catch {
            /* ignore */
        }
    };

    const onRingPointerDown = (e: ThreeEvent<PointerEvent>) => {
        if (captureStep === 'mask' || maskMode || snapshotMode || !showRing) return;
        e.stopPropagation();
        const g = groupRef.current;
        const p = intersectFloor(e.clientX, e.clientY);
        if (!g || !p) return;
        g.updateMatrixWorld(true);
        const wx = new THREE.Vector3();
        g.getWorldPosition(wx);
        const ringR = ringRadiusM;
        if (!isPointerOnFurnitureRingXZ(p, wx, ringR, FURNITURE_RING_RADIAL_TOLERANCE_M)) return;
        rotateDragStartYawRef.current = g.rotation.y;
        rotateDragStartAngleRef.current = Math.atan2(p.x - wx.x, p.z - wx.z);
        draggingRef.current = true;
        dragKindRef.current = 'rotate';
        setIsRotateDragging(true);
        setPointerBusy(true);
        onFurnitureDragStart?.();
        try {
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        } catch {
            /* ignore */
        }
    };

    const handleRingMeshPointerOver = useCallback(
        (e: ThreeEvent<PointerEvent>) => {
            if (draggingRef.current) return;
            const g = groupRef.current;
            if (!g) return;
            const p = intersectFloor(e.clientX, e.clientY);
            if (!p) {
                setRingMeshHover(false);
                return;
            }
            g.updateMatrixWorld(true);
            const wx = new THREE.Vector3();
            g.getWorldPosition(wx);
            const ringR2 = ringRadiusM;
            const onRingArc = isPointerOnFurnitureRingXZ(p, wx, ringR2, FURNITURE_RING_RADIAL_TOLERANCE_M);
            setRingMeshHover(onRingArc);
        },
        [intersectFloor, item, ringRadiusM]
    );

    return (
        <>
            <group
                ref={groupRef}
                name={`${FURNITURE_NAME_PREFIX}${item.id}`}
                visible={true}
                position={posVec}
                rotation={rotEuler}
                scale={scaleVec}
            >
                <group
                    onPointerDown={onBodyPointerDown}
                    onPointerOver={(ev) => {
                        ev.stopPropagation();
                        setIsHovered(true);
                        onHoverNameChange?.(`${FURNITURE_NAME_PREFIX}${item.id}`);
                    }}
                    onPointerOut={() => {
                        setIsHovered(false);
                        onHoverNameChange?.(null);
                    }}
                    onPointerUp={(ev) => {
                        ev.stopPropagation();
                    }}
                    onClick={(ev) => {
                        ev.stopPropagation();
                    }}
                >
                    <CanvasErrorBoundary>
                        <Suspense fallback={<FurnitureFallback modelUrl={item.modelUrl} />}>
                            <GLTFCore
                                modelUrl={item.modelUrl}
                                maskMode={maskMode}
                                isSelected={isSelected}
                                captureStep={captureStep}
                                alignTop={item.ceilingMount}
                            />
                        </Suspense>
                    </CanvasErrorBoundary>
                </group>
                {isHovered && !snapshotMode && !maskMode && captureStep !== 'mask' && (
                    <Html position={[0, 1.5, 0]} center style={{ pointerEvents: 'none' }}>
                        <div className="bg-black/80 text-white text-[10px] px-3 py-1.5 rounded-lg whitespace-nowrap border border-white/20 shadow-xl font-bold text-center leading-tight animate-in fade-in zoom-in duration-200">
                            {!isSelected
                                ? 'クリックで選択'
                                : sketchFloorDrag
                                  ? 'ドラッグで移動 / 青い弧で回転（2Dでも可）'
                                  : '2Dで移動・回転'}
                        </div>
                    </Html>
                )}
            </group>
            {showRing && (
                <FurnitureRingAnchor furnitureGroupRef={groupRef}>
                    <FurnitureRotationRing3D
                        radius={ringRadiusM}
                        highlighted={ringHighlight}
                        isDashed={isRotateDragging}
                        onRingPointerDown={onRingPointerDown}
                        onRingPointerOver={handleRingMeshPointerOver}
                        onRingPointerOut={() => setRingMeshHover(false)}
                    />
                </FurnitureRingAnchor>
            )}
        </>
    );
};


// 取り込んだカスタムモデル（BIM/部屋）を読み込み、メッシュ選択・素材適用を行う。
// 読み込みは ModelRoot が形式（glTF/FBX/OBJ）ごとに分岐する。
const CustomBIMModel = ({ url, ...rest }: any) => {
  return <ModelRoot url={url}>{(scene) => <CustomBIMScene scene={scene} {...rest} />}</ModelRoot>;
};

const CustomBIMScene = ({
  scene,
  selections,
  onMeshClick,
  materialSettings,
  isDraggingRef,
  captureStep,
  onHoverNameChange
}: any) => {
  useEffect(() => {
    scene.traverse((child: THREE.Object3D) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        updateMeshMaterial(mesh, selections[mesh.name] || null, materialSettings, captureStep);
        // Shadows ENABLED
        mesh.castShadow = !captureStep || captureStep !== 'mask';
        mesh.receiveShadow = !captureStep || captureStep !== 'mask';
      }
    });
  }, [scene, selections, materialSettings, captureStep]); 

  return (
    <group>
      <primitive 
        object={scene} 
        onClick={(e: any) => {
          e.stopPropagation();
          if (isDraggingRef.current) return;
          const meshName = e.object.name;
          const lowerName = meshName.toLowerCase();
          let category: MaterialCategory = 'Wall';
          if (lowerName.includes('floor')) category = 'Floor';
          else if (lowerName.includes('ceiling')) category = 'Ceiling';
          
          // Multi-selection: Shift のみ（260703 クライアント要望で Ctrl/Cmd は除外）。
          onMeshClick(category, meshName, e.shiftKey);
        }}
        onPointerOver={(e: any) => {
          e.stopPropagation();
          onHoverNameChange?.(e.object?.name ?? null);
        }}
        onPointerOut={(e: any) => {
          e.stopPropagation();
          onHoverNameChange?.(null);
        }}
      />
    </group>
  );
};

const DraggableOpening = ({
  op,
  isSelected,
  onSelect,
  onUpdate,
  onDragStart,
  onDragEnd,
  posX,
  posY,
  wallLength,
  captureStep,
  isDraggingRef,
  openings,
  isAxisFlipped,
  isLocalPlusZIndoor,
  doorColor,
  doorFrameColor,
  windowFrameColor,
  onHoverNameChange,
  snapshotMode = false,
  maskMode = false
}: any) => {
  const groupRef = useRef<THREE.Group>(null);
  const isSelectedRef = useRef(isSelected);
  const dragArmedRef = useRef(false);
  const pointerDraggingRef = useRef(false);
  const [isHovered, setIsHovered] = useState(false);
  const [pointerDragging, setPointerDragging] = useState(false);
  const { camera, gl } = useThree();
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const ndc = useMemo(() => new THREE.Vector2(), []);
  const wallPlane = useMemo(() => new THREE.Plane(), []);
  const wallQuat = useMemo(() => new THREE.Quaternion(), []);
  const wallPlanePoint = useMemo(() => new THREE.Vector3(), []);
  const wallNormal = useMemo(() => new THREE.Vector3(0, 0, 1), []);
  const hitPoint = useMemo(() => new THREE.Vector3(), []);
  const localPoint = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    isSelectedRef.current = isSelected;
  }, [isSelected]);

  useEffect(() => {
    pointerDraggingRef.current = pointerDragging;
  }, [pointerDragging]);

  const finalizeOpeningDrag = useCallback(() => {
    dragArmedRef.current = false;
    if (!pointerDraggingRef.current) return;
    pointerDraggingRef.current = false;
    setPointerDragging(false);
    if (onDragEnd) onDragEnd();
  }, [onDragEnd]);

  const handleBind = useGesture({
    onDrag: ({ event, active, first, last }) => {
      if (captureStep === 'mask' || snapshotMode || maskMode) return;
      if (first && !dragArmedRef.current) return;
      if (!dragArmedRef.current) return;
      event.stopPropagation();
      if (first) {
        if (!pointerDraggingRef.current) {
          pointerDraggingRef.current = true;
          setPointerDragging(true);
          if (onDragStart) onDragStart();
        }
      }
      if (last) {
        finalizeOpeningDrag();
      }

      if (active && groupRef.current) {
        const parent = groupRef.current.parent;
        if (!parent) return;
        const pe = event as PointerEvent;
        if (pe.clientX == null || pe.clientY == null) return;
        const rect = gl.domElement.getBoundingClientRect();
        ndc.x = ((pe.clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((pe.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndc, camera);
        parent.getWorldQuaternion(wallQuat);
        wallNormal.set(0, 0, 1).applyQuaternion(wallQuat);
        parent.getWorldPosition(wallPlanePoint);
        wallPlane.setFromNormalAndCoplanarPoint(wallNormal, wallPlanePoint);
        if (raycaster.ray.intersectPlane(wallPlane, hitPoint)) {
          localPoint.copy(hitPoint);
          parent.worldToLocal(localPoint);
          const nextRatioRaw = wallLocalXToOpeningRatio(localPoint.x, wallLength, isAxisFlipped);
          const others = openings
            .filter((o: Opening) => o.wallIndex === op.wallIndex && o.id !== op.id)
            .map((other: Opening) => ({ ...other, width: getEffectiveOpeningWidthMm(other) }));
          const wallLengthMm = wallLength * MM_PER_METER;
          const clamped = clampOpeningRatioWithCollisions(
            nextRatioRaw,
            wallLengthMm,
            getEffectiveOpeningWidthMm(op),
            op.ratioPosition,
            others
          );
          onUpdate(clamped);
        }
      }
    },
    onPointerDown: ({ event }) => {
      if (captureStep === 'mask' || snapshotMode || maskMode) return;
      event.stopPropagation();
      // 1回目クリックは選択のみ。選択済みのときだけ次のドラッグを許可する。
      dragArmedRef.current = isSelectedRef.current;
      // 選択済み開口を掴んだ時点で視点操作を先にロックし、ドラッグ中の競合を防ぐ。
      if (dragArmedRef.current && !pointerDraggingRef.current) {
        pointerDraggingRef.current = true;
        setPointerDragging(true);
        if (onDragStart) onDragStart();
      }
      onSelect();
    }
  });

  useEffect(() => {
    const onPointerEnd = () => finalizeOpeningDrag();
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
    return () => {
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
    };
  }, [finalizeOpeningDrag]);

  const wM = op.width / 1000;
  const hM = op.height / 1000;
  const openingEffectiveWidthM = getEffectiveOpeningWidthMm(op) / 1000;
  const openingBodyDepthM = op.type.startsWith('door') ? OPENING_DEPTH_M + 0.02 : OPENING_DEPTH_M;
  // ハイライトは建具厚みに同期し、わずかな余裕のみ持たせる
  const openingHighlightDepthM = openingBodyDepthM + 0.002;
  const signedOpeningOffsetZ = isLocalPlusZIndoor ? -OPENING_CENTER_OFFSET_M : OPENING_CENTER_OFFSET_M;

  useEffect(() => {
    if (snapshotMode || maskMode || captureStep === 'mask') {
      document.body.style.cursor = 'auto';
      return () => {
        document.body.style.cursor = 'auto';
      };
    }
    if (pointerDragging) {
      document.body.style.cursor = 'grabbing';
    } else if (isHovered && isSelected) {
      document.body.style.cursor = 'grab';
    } else if (isHovered && !isSelected) {
      document.body.style.cursor = 'pointer';
    } else {
      document.body.style.cursor = 'auto';
    }
    return () => {
      document.body.style.cursor = 'auto';
    };
  }, [isHovered, isSelected, pointerDragging, snapshotMode, maskMode, captureStep]);

  const bindProps = handleBind() as any;

  return (
    <group ref={groupRef} name={`${OPENING_NAME_PREFIX}${op.id}`} position={[posX, posY, signedOpeningOffsetZ]}>
      {captureStep === 'mask' ? (
        <mesh>
          <boxGeometry args={[openingEffectiveWidthM, hM, openingHighlightDepthM]} />
          <meshBasicMaterial color="white" />
        </mesh>
      ) : (
        <>
          <group>
            {op.type.startsWith('door') ? (
              <ParametricDoor
                width={op.width}
                height={op.height}
                type={op.type as any}
                doorColor={doorColor}
                frameColor={doorFrameColor}
                swingFlipX={op.swingFlipX}
                swingFlipY={op.swingFlipY}
                open={op.swingOpen}
                isLocalPlusZIndoor={isLocalPlusZIndoor}
                isAxisFlipped={isAxisFlipped}
              />
            ) : (
              <ParametricWindow
                width={op.width}
                height={op.height}
                type={op.type as any}
                frameColor={windowFrameColor}
                sashColor={windowFrameColor}
              />
            )}
          </group>
          {/* 前面ヒット：選択・壁沿いドラッグ（ギズモなし） */}
          <mesh
            visible={false}
            position={[0, hM / 2, 0.18]}
            {...bindProps}
            onPointerOver={(e: ThreeEvent<PointerEvent>) => {
              e.stopPropagation();
              setIsHovered(true);
              onHoverNameChange?.(`${OPENING_NAME_PREFIX}${op.id}`);
            }}
            onPointerOut={() => {
              setIsHovered(false);
              onHoverNameChange?.(null);
            }}
          >
            <boxGeometry args={[openingEffectiveWidthM, hM, 0.04]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
          {isHovered && !snapshotMode && !maskMode && captureStep !== 'mask' && (
            <Html position={[0, hM + 0.15, 0.2]} center style={{ pointerEvents: 'none' }}>
              <div className="bg-black/80 text-white text-[10px] px-3 py-1.5 rounded-lg whitespace-nowrap border border-white/20 shadow-xl font-bold text-center leading-tight animate-in fade-in zoom-in duration-200">
                {!isSelected ? 'クリックで選択' : 'ドラッグで壁に沿って移動'}
              </div>
            </Html>
          )}
        </>
      )}
    </group>
  );
};

type SketchRoomMaterialSettings = Record<
  string,
  {
    roughness: number;
    metalness: number;
    textureScale?: number;
    baseboardEnabled?: boolean;
    baseboardHeight?: number;
    baseboardColor?: string;
    wainscotHeight?: number;
    doorColor?: string;
    doorFrameColor?: string;
    windowFrameColor?: string;
  }
>;

/** 腰壁分割で極小穴になると earcut が破綻しやすい — これ未満の高さの穴は作らない */
const MIN_WALL_HOLE_HEIGHT_M = 0.008;
const HOLE_INSET_EPS_M = 1e-4;

/** SketchRoom の openingsInSegment と WallSegment のクリップで共通の交差判定 */
const getOpeningBottomM = (op: Opening) => (op.type.startsWith('door') ? 0 : op.bottomOffset / 1000);

const openingIntersectsVerticalSegment = (op: Opening, segmentMinY: number, segmentMaxY: number) => {
  const openingMinY = getOpeningBottomM(op);
  const openingMaxY = openingMinY + op.height / 1000;
  return openingMaxY > segmentMinY && openingMinY < segmentMaxY;
};

const WallSegment: React.FC<{
  subWallName: string;
  lengthM: number;
  actualWallH: number;
  actualWallY: number;
  yOffset: number;
  isBottom: boolean;
  bbEnabled: boolean;
  bbHeightM: number;
  bbColor: string;
  segmentMinY: number;
  segmentMaxY: number;
  openingsInSegment: Opening[];
  wallOpenings: Opening[];
  isCCW: boolean;
  prod: Product | null;
  materialSettings: SketchRoomMaterialSettings;
  captureStep?: 'idle' | 'pt-base' | 'mask';
  shadowEnabled: boolean;
  activeMeshes: string[];
  snapshotMode: boolean;
  maskMode?: boolean;
  hideOpeningsForCamera: boolean;
  onMeshClick: RoomViewerProps['onMeshClick'];
  setOpenings: React.Dispatch<React.SetStateAction<Opening[]>>;
  selectedOpeningId: string | null;
  onOpeningSelect: (id: string | null) => void;
  openings: Opening[];
  isDraggingRef: React.MutableRefObject<boolean>;
  isLocalPlusZIndoor: boolean;
  doorColor: string;
  doorFrameColor: string;
  windowFrameColor: string;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onHoverNameChange?: (name: string | null) => void;
}> = ({
  subWallName,
  lengthM,
  actualWallH,
  actualWallY,
  yOffset,
  isBottom,
  bbEnabled,
  bbHeightM,
  bbColor,
  segmentMinY,
  segmentMaxY,
  openingsInSegment,
  wallOpenings,
  isCCW,
  prod,
  materialSettings,
  captureStep,
  shadowEnabled,
  activeMeshes,
  snapshotMode,
  maskMode = false,
  hideOpeningsForCamera,
  onMeshClick,
  setOpenings,
  selectedOpeningId,
  onOpeningSelect,
  openings,
  isDraggingRef,
  isLocalPlusZIndoor,
  doorColor,
  doorFrameColor,
  windowFrameColor,
  onDragStart,
  onDragEnd,
  onHoverNameChange,
}) => {
  const meshRef = useRef<THREE.Mesh>(null);

  // 壁セグメントを「開口を差し引いた実体矩形（タイル）群」として構築する（260703）。
  // 旧: 1枚の外周矩形＋穴（holes）方式は、開口がセグメント全高をまたぐと壁が左右2本の柱へ分断され、
  //     単一 THREE.Shape では非連結領域を表現できず境界に極薄の帯を残していた（腰壁分割線の継ぎ目/穴あけ破綻）。
  // 新: solidRectsForSegment でセグメント矩形−開口の実体矩形を求め、THREE.ShapeGeometry(配列) で描く。
  //     分断された柱も欠けず、穴が外周に接する退化ポリゴンも生じない。UVは頂点座標(m)＝実寸タイリングを維持。
  // openingsInSegment / wallOpenings は親の map で毎レンダー新しい配列として作られる（内容は同じでも参照が毎回変わる）。
  // これを useMemo 依存にそのまま入れると、巾木カラー変更のように「開口が変わらない再レンダー」でも壁/巾木ジオメトリを
  // 毎回作り直して重くなる。スポイトの連続 onChange で毎フレーム再構築され画面が固まる不具合の原因（260709）。
  // 内容ベースのキー（JSON 文字列）で依存を安定化し、開口が実際に変わったときだけ作り直す。
  const openingsKey = JSON.stringify(openingsInSegment);
  const wallOpeningsKey = JSON.stringify(wallOpenings);
  const wallShapes = useMemo(() => {
    // 開口をセグメントのローカル座標（中心原点・m）へ変換し、セグメント範囲へ縦クリップする。
    const localOpenings = openingsInSegment.map((op: Opening) => {
      const openingBottom = getOpeningBottomM(op);
      const openingTop = openingBottom + op.height / 1000;
      const clippedBottom = Math.max(openingBottom, segmentMinY);
      const clippedTop = Math.min(openingTop, segmentMaxY);
      const holeX = openingRatioToWallLocalX(op.ratioPosition, lengthM, isCCW);
      const holeW = getEffectiveOpeningWidthMm(op) / 1000;
      return {
        xL: holeX - holeW / 2,
        xR: holeX + holeW / 2,
        yB: clippedBottom - actualWallY,
        yT: clippedTop - actualWallY,
      };
    });
    return solidRectsForSegment(lengthM / 2, actualWallH / 2, localOpenings).map((r) => {
      const s = new THREE.Shape();
      s.moveTo(r.xL, r.yB);
      s.lineTo(r.xR, r.yB);
      s.lineTo(r.xR, r.yT);
      s.lineTo(r.xL, r.yT);
      s.lineTo(r.xL, r.yB);
      return s;
    });
    // openingsInSegment は openingsKey（内容キー）で安定化して依存に入れている（参照ではなく内容で判定）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lengthM, actualWallH, actualWallY, segmentMinY, segmentMaxY, openingsKey, isCCW]);

  // 巾木ジオメトリ（開口ぶんの穴あき ShapeGeometry）。以前は render 内で毎レンダー new していたため、巾木カラーを
  // 変えるたびにジオメトリを作り直して重かった（スポイトの連続変更で画面が固まる主因・260709）。形状に関わる依存だけで
  // useMemo 化し、色(bbColor)変更では作り直さない（色はマテリアルにのみ反映＝安価）。開口は wallOpeningsKey で内容安定化。
  const baseboardGeometry = useMemo(() => {
    if (!bbEnabled) return null;
    const baseboardShape = new THREE.Shape();
    baseboardShape.moveTo(-lengthM / 2, -bbHeightM / 2);
    baseboardShape.lineTo(lengthM / 2, -bbHeightM / 2);
    baseboardShape.lineTo(lengthM / 2, bbHeightM / 2);
    baseboardShape.lineTo(-lengthM / 2, bbHeightM / 2);
    baseboardShape.lineTo(-lengthM / 2, -bbHeightM / 2);

    const baseboardMinY = yOffset;
    const baseboardMaxY = yOffset + bbHeightM;
    const bbHalfH = bbHeightM / 2;
    const bbMinYL = -bbHalfH + HOLE_INSET_EPS_M;
    const bbMaxYL = bbHalfH - HOLE_INSET_EPS_M;
    const bbTopNoInsetYL = bbHalfH;
    const bbMinXL = -lengthM / 2 + HOLE_INSET_EPS_M;
    const bbMaxXL = lengthM / 2 - HOLE_INSET_EPS_M;

    [...wallOpenings]
      .sort((a: Opening, b: Opening) => a.ratioPosition - b.ratioPosition)
      .forEach((op: Opening) => {
        const openingMinY = getOpeningBottomM(op);
        const openingMaxY = openingMinY + op.height / 1000;
        const clippedBottom = Math.max(openingMinY, baseboardMinY);
        const clippedTop = Math.min(openingMaxY, baseboardMaxY);
        if (clippedBottom >= clippedTop) return;
        const clippedHeight = clippedTop - clippedBottom;
        if (clippedHeight <= MIN_WALL_HOLE_HEIGHT_M) return;

        const holeX = openingRatioToWallLocalX(op.ratioPosition, lengthM, isCCW);
        const holeW = getEffectiveOpeningWidthMm(op) / 1000;
        let hy = (clippedBottom + clippedTop) / 2 - (yOffset + bbHeightM / 2);
        let hh = clippedHeight / 2;
        let hx = holeX;
        let hw = holeW / 2;

        let yBot = hy - hh;
        let yTop = hy + hh;
        yBot = Math.max(yBot, bbMinYL);
        // 壁との共有境界（baseboardMaxY）に接する穴だけは上端EPSを外し、境界スリバーを防ぐ
        const touchesBaseboardTop = Math.abs(clippedTop - baseboardMaxY) <= HOLE_INSET_EPS_M;
        yTop = Math.min(yTop, touchesBaseboardTop ? bbTopNoInsetYL : bbMaxYL);
        if (yTop <= yBot) return;
        hy = (yTop + yBot) / 2;
        hh = (yTop - yBot) / 2;
        if (hh * 2 <= MIN_WALL_HOLE_HEIGHT_M) return;

        let xL = hx - hw;
        let xR = hx + hw;
        xL = Math.max(xL, bbMinXL);
        xR = Math.min(xR, bbMaxXL);
        if (xR <= xL) return;
        hx = (xL + xR) / 2;
        hw = (xR - xL) / 2;

        const holePath = new THREE.Path();
        holePath.moveTo(hx - hw, hy - hh);
        holePath.lineTo(hx - hw, hy + hh);
        holePath.lineTo(hx + hw, hy + hh);
        holePath.lineTo(hx + hw, hy - hh);
        holePath.lineTo(hx - hw, hy - hh);
        baseboardShape.holes.push(holePath);
      });

    return new THREE.ShapeGeometry(baseboardShape);
    // 開口は wallOpeningsKey（内容キー）で安定化。bbColor は意図的に依存に含めない（色でジオメトリを作り直さない）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bbEnabled, lengthM, bbHeightM, yOffset, wallOpeningsKey, isCCW]);

  // 形状が変わって新しいジオメトリになった/アンマウント時は、古いジオメトリを破棄（GPUメモリのリーク防止・260709）。
  useEffect(() => {
    return () => {
      baseboardGeometry?.dispose();
    };
  }, [baseboardGeometry]);

  return (
    <>
      <mesh
        name={subWallName}
        ref={meshRef}
        position={[0, actualWallY, 0]}
        onClick={(e) => {
          e.stopPropagation();
          if (!isDraggingRef.current) onMeshClick('Wall', subWallName, e.shiftKey);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          onHoverNameChange?.(subWallName);
        }}
        onPointerOut={() => onHoverNameChange?.(null)}
        castShadow={shadowEnabled}
        receiveShadow={shadowEnabled}
      >
        <shapeGeometry args={[wallShapes]} />
        {/* 壁は片面ジオメトリ。凹形状でも面が裏返って消えないよう両面描画する（260611 Sec3） */}
        <Suspense fallback={<meshStandardMaterial color="#cccccc" side={THREE.DoubleSide} />}>
          <DynamicMaterial
            product={prod}
            captureStep={captureStep}
            meshRef={meshRef}
            materialSettings={materialSettings}
            surfaceWidthM={lengthM}
            surfaceHeightM={actualWallH}
            doubleSided
          />
        </Suspense>
      </mesh>

      {/* 建具メッシュ（枠・ガラス・ドア板）は壁分割やバンド（巾木/腰壁）に関係なく、開口ごとに1回だけ描く。
          以前はセグメント交差で絞っていたため、巾木が高く開口が巾木域に入ると建具が消えていた（260623修正）。
          posY は絶対値なので最下段(isBottom)からまとめて描けば位置は正しく、分割壁でも重複しない。 */}
      {isBottom && wallOpenings
          .filter((op: Opening) => !hideOpeningsForCamera)
          .map((op: Opening) => {
            const isSelected = selectedOpeningId === op.id;
            const posX = openingRatioToWallLocalX(op.ratioPosition, lengthM, isCCW);
            const posY = getOpeningBottomM(op);

            return (
              <DraggableOpening
                key={op.id}
                op={op}
                isSelected={isSelected}
                onSelect={() => onOpeningSelect(op.id)}
                onUpdate={(newRatio: number) => {
                  setOpenings((prev: Opening[]) => prev.map((o) => (o.id === op.id ? { ...o, ratioPosition: newRatio } : o)));
                }}
                onDragStart={() => onDragStart && onDragStart()}
                onDragEnd={() => onDragEnd && onDragEnd()}
                posX={posX}
                posY={posY}
                wallLength={lengthM}
                captureStep={captureStep}
                isDraggingRef={isDraggingRef}
                openings={openings}
                isAxisFlipped={isCCW}
                isLocalPlusZIndoor={isLocalPlusZIndoor}
                doorColor={doorColor}
                doorFrameColor={doorFrameColor}
                windowFrameColor={windowFrameColor}
                onHoverNameChange={onHoverNameChange}
                snapshotMode={snapshotMode}
                maskMode={maskMode}
              />
            );
          })}

      {bbEnabled && baseboardGeometry && (
        <mesh
          position={[0, yOffset + bbHeightM / 2, 0]}
          onClick={(e) => {
            e.stopPropagation();
            if (!isDraggingRef.current) onMeshClick('Wall', subWallName, e.shiftKey);
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            onHoverNameChange?.(subWallName);
          }}
          onPointerOut={() => onHoverNameChange?.(null)}
          castShadow={shadowEnabled}
          receiveShadow={shadowEnabled}
        >
          {/* ジオメトリは useMemo 済み（形状が変わったときだけ再構築）。色はマテリアルにだけ反映＝カラー変更は安価。 */}
          <primitive object={baseboardGeometry} attach="geometry" />
          <meshStandardMaterial color={bbColor} side={THREE.DoubleSide} roughness={0.7} />
        </mesh>
      )}
    </>
  );
};

// 4b: スケルトン天井の上部壁バンド（壁グループ内で1枚=薄い箱）。自前の ref を持ち
// DynamicMaterial(meshRef 必須) に渡す。実寸テクスチャは surfaceWidthM/Height で投影。
const UpperBandSegment: React.FC<{
  length: number;
  bandM: number;
  yTop: number;
  openings: Opening[];
  isCCW: boolean;
  selections: any;
  materialSettings: any;
  captureStep: any;
  shadowEnabled: boolean;
  isDraggingRef: React.MutableRefObject<boolean>;
  onMeshClick: (category: any, name: string, isMulti: boolean) => void;
  onHoverNameChange?: (name: string | null) => void;
}> = ({ length, bandM, yTop, openings, isCCW, selections, materialSettings, captureStep, shadowEnabled, isDraggingRef, onMeshClick, onHoverNameChange }) => {
  const ref = useRef<THREE.Mesh>(null);
  // 上部壁バンドも窓・ドアの開口を差し引く（巾木/壁と同じ処理）。これがないと開口の上部が箱で覆われる（260623）。
  // openings は親から毎レンダー新しい配列（.filter 済み）で渡るため、参照依存だとカラー変更等の再レンダーでも
  // バンドジオメトリを作り直して重い（スポイト連続変更で固まる一因・260709）。内容キーで安定化する。
  const openingsKey = JSON.stringify(openings);
  const bandGeometry = useMemo(() => {
    const shape = new THREE.Shape();
    shape.moveTo(-length / 2, -bandM / 2);
    shape.lineTo(length / 2, -bandM / 2);
    shape.lineTo(length / 2, bandM / 2);
    shape.lineTo(-length / 2, bandM / 2);
    shape.lineTo(-length / 2, -bandM / 2);

    // スケルトン天井の上部壁は、天井ラインから「上」へ伸ばす（260623・クライアント要望。天井面も併せて上へ）。
    const bandMinY = yTop;
    const bandMaxY = yTop + bandM;
    const bandCenterY = yTop + bandM / 2;
    const halfH = bandM / 2;
    const minYL = -halfH + HOLE_INSET_EPS_M;
    const maxYL = halfH - HOLE_INSET_EPS_M;
    const bottomNoInsetYL = -halfH; // 壁との共有境界（bandMinY）に接する穴はスリバー防止でEPSを外す
    const minXL = -length / 2 + HOLE_INSET_EPS_M;
    const maxXL = length / 2 - HOLE_INSET_EPS_M;

    [...openings]
      .sort((a, b) => a.ratioPosition - b.ratioPosition)
      .forEach((op) => {
        const openingMinY = getOpeningBottomM(op);
        const openingMaxY = openingMinY + op.height / 1000;
        const clippedBottom = Math.max(openingMinY, bandMinY);
        const clippedTop = Math.min(openingMaxY, bandMaxY);
        if (clippedBottom >= clippedTop) return;
        if (clippedTop - clippedBottom <= MIN_WALL_HOLE_HEIGHT_M) return;

        const holeX = openingRatioToWallLocalX(op.ratioPosition, length, isCCW);
        const holeW = getEffectiveOpeningWidthMm(op) / 1000;
        let hy = (clippedBottom + clippedTop) / 2 - bandCenterY;
        let hh = (clippedTop - clippedBottom) / 2;
        let yBot = hy - hh;
        let yTopL = hy + hh;
        const touchesBandBottom = Math.abs(clippedBottom - bandMinY) <= HOLE_INSET_EPS_M;
        yBot = Math.max(yBot, touchesBandBottom ? bottomNoInsetYL : minYL);
        yTopL = Math.min(yTopL, maxYL);
        if (yTopL <= yBot) return;
        hy = (yTopL + yBot) / 2;
        hh = (yTopL - yBot) / 2;
        if (hh * 2 <= MIN_WALL_HOLE_HEIGHT_M) return;

        let xL = holeX - holeW / 2;
        let xR = holeX + holeW / 2;
        xL = Math.max(xL, minXL);
        xR = Math.min(xR, maxXL);
        if (xR <= xL) return;
        const hx = (xL + xR) / 2;
        const hw = (xR - xL) / 2;

        const holePath = new THREE.Path();
        holePath.moveTo(hx - hw, hy - hh);
        holePath.lineTo(hx - hw, hy + hh);
        holePath.lineTo(hx + hw, hy + hh);
        holePath.lineTo(hx + hw, hy - hh);
        holePath.lineTo(hx - hw, hy - hh);
        shape.holes.push(holePath);
      });
    return new THREE.ShapeGeometry(shape);
    // openings は openingsKey（内容キー）で安定化して依存に入れている（毎レンダーの新規配列では作り直さない・260709）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [length, bandM, yTop, openingsKey, isCCW]);

  // 形状が変わって新しいジオメトリになった/アンマウント時は、古いジオメトリを破棄（GPUメモリのリーク防止・260709）。
  useEffect(() => {
    return () => {
      bandGeometry?.dispose();
    };
  }, [bandGeometry]);

  return (
    <mesh
      ref={ref}
      name="Sketch_UpperBand"
      position={[0, yTop + bandM / 2, 0]}
      onClick={(e) => { e.stopPropagation(); if (!isDraggingRef.current) onMeshClick('Wall', 'Sketch_UpperBand', e.shiftKey); }}
      onPointerOver={(e) => { e.stopPropagation(); onHoverNameChange?.('Sketch_UpperBand'); }}
      onPointerOut={() => onHoverNameChange?.(null)}
      receiveShadow={shadowEnabled}
    >
      <primitive object={bandGeometry} attach="geometry" />
      <Suspense fallback={<meshStandardMaterial color="#cccccc" side={THREE.DoubleSide} />}>
        <DynamicMaterial product={selections['Sketch_UpperBand']} captureStep={captureStep} meshRef={ref} materialSettings={materialSettings} surfaceWidthM={length} surfaceHeightM={bandM} doubleSided />
      </Suspense>
    </mesh>
  );
};

const SketchRoom = ({ 
  points, 
  selections, 
  onMeshClick, 
  height, 
  activeMeshes, 
  snapshotMode, 
  maskMode = false,
  materialSettings, 
  isDraggingRef, 
  wallDivisions, 
  captureStep, 
  openings,
  setOpenings,
  selectedOpeningId,
  onOpeningSelect,
  onDragStart,
  onDragEnd,
  onHoverNameChange,
  skeletonCeiling = false,
  skeletonUpperWallMm = 1000,
  wallHiddenRef
}: any) => {
  const { camera } = useThree();
  const [cameraSyncTick, setCameraSyncTick] = useState(0);
  const prevCameraPosRef = useRef(new THREE.Vector3());
  const openingsHiddenByWallRef = useRef<Record<number, boolean>>({});

  useFrame(({ camera: frameCamera }) => {
    // 視点移動と同期して開口表示判定を更新
    if (prevCameraPosRef.current.distanceToSquared(frameCamera.position) > 1e-6) {
      prevCameraPosRef.current.copy(frameCamera.position);
      setCameraSyncTick(t => (t + 1) % 100000);
    }
  });

  const { mPoints, isCCW } = useMemo(() => getRoomTransform(points as any), [points]);

  useEffect(() => {
    // 壁構成が変わったら開口表示の履歴（ヒステリシス状態）をリセット
    openingsHiddenByWallRef.current = {};
  }, [mPoints.length]);

  const { shape, ceilingShape } = useMemo(() => {
    const s = new THREE.Shape();
    const c = new THREE.Shape(); 
    if (mPoints.length > 0) {
        s.moveTo(mPoints[0].x, -mPoints[0].z);
        c.moveTo(mPoints[0].x, mPoints[0].z);
        for (let i = 1; i < mPoints.length; i++) {
            s.lineTo(mPoints[i].x, -mPoints[i].z);
            c.lineTo(mPoints[i].x, mPoints[i].z);
        }
        s.lineTo(mPoints[0].x, -mPoints[0].z);
        c.lineTo(mPoints[0].x, mPoints[0].z);
    }
    return { shape: s, ceilingShape: c };
  }, [mPoints]);

  const floorRef = useRef<THREE.Mesh>(null);
  const ceilingRef = useRef<THREE.Mesh>(null);

  const shadowEnabled = !captureStep || captureStep !== 'mask';

  return (
    <group>
      <mesh 
        ref={floorRef}
        name="Sketch_Floor"
        rotation={[-Math.PI / 2, 0, 0]} 
        position={[0, 0, 0]} 
        onClick={(e) => { e.stopPropagation(); if (!isDraggingRef.current) onMeshClick('Floor', 'Sketch_Floor', e.shiftKey); }}
        onPointerOver={(e) => {
          e.stopPropagation();
          onHoverNameChange?.('Sketch_Floor');
        }}
        onPointerOut={() => onHoverNameChange?.(null)}
        receiveShadow={shadowEnabled}
      >
        <shapeGeometry args={[shape]} />
        <Suspense fallback={<meshStandardMaterial color="#8b5a2b" />}>
           <DynamicMaterial product={selections['Sketch_Floor']} captureStep={captureStep} isFloor meshRef={floorRef} materialSettings={materialSettings} />
        </Suspense>
        <StructuralEdges snapshotMode={snapshotMode} />
      </mesh>

      {/* 天井スラブ。スケルトン天井でも天井（上面）は表示する（4b: 天井アリ）。
          スケルトン時は上部壁ぶん上へ移動し、天井面も併せて上に伸びる（260623・クライアント要望）。 */}
      <mesh
        ref={ceilingRef}
        name="Sketch_Ceiling"
        position={[0, skeletonCeiling && skeletonUpperWallMm > 0 ? height + skeletonUpperWallMm / 1000 : height, 0]}
        rotation={[Math.PI / 2, 0, 0]}
        scale={[1, 1, 1]}
        onClick={(e) => { e.stopPropagation(); if (!isDraggingRef.current) onMeshClick('Ceiling', 'Sketch_Ceiling', e.shiftKey); }}
        onPointerOver={(e) => {
          e.stopPropagation();
          onHoverNameChange?.('Sketch_Ceiling');
        }}
        onPointerOut={() => onHoverNameChange?.(null)}
        receiveShadow={shadowEnabled}
      >
        <shapeGeometry args={[ceilingShape]} />
        <Suspense fallback={<meshStandardMaterial color="#cccccc" />}>
           <DynamicMaterial product={selections['Sketch_Ceiling']} captureStep={captureStep} meshRef={ceilingRef} materialSettings={materialSettings} />
        </Suspense>
        <StructuralEdges snapshotMode={snapshotMode} />
      </mesh>

      {mPoints.map((p: any, i: number) => {
        const wallName = `Sketch_Wall_${i}`;
        const next = mPoints[(i + 1) % mPoints.length];
        const dx = next.x - p.x;
        const dz = next.z - p.z;
        const length = Math.sqrt(dx * dx + dz * dz);
        const rotationY = getWallRotationY(p, next, isCCW);
        const cameraTick = cameraSyncTick;

        // 壁法線（内向き）とカメラ位置の関係で開口表示を制御
        const wallCenter = new THREE.Vector3((p.x + next.x) / 2, height / 2, (p.z + next.z) / 2);
        const roomCenter = new THREE.Vector3(0, height / 2, 0);
        const toCenter = new THREE.Vector3().subVectors(roomCenter, wallCenter).normalize();
        const toCamera = new THREE.Vector3().subVectors(camera.position, wallCenter).normalize();
        const wallLocalPlusZ = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotationY).normalize();
        const isLocalPlusZIndoor = wallLocalPlusZ.dot(toCenter) >= 0;
        const wallNormal = wallLocalPlusZ.clone();
        if (!isLocalPlusZIndoor) wallNormal.multiplyScalar(-1);
        // ヒステリシスで境界付近の表示チラつきを抑える
        const openingHideThreshold = -0.02;
        const openingShowThreshold = 0.02;
        const openingFacingDot = wallNormal.dot(toCamera);
        const wasHidden = openingsHiddenByWallRef.current[i] ?? false;
        let isHidden = wasHidden;
        if (openingFacingDot <= openingHideThreshold) {
          isHidden = true;
        } else if (openingFacingDot >= openingShowThreshold) {
          isHidden = false;
        }
        openingsHiddenByWallRef.current[i] = isHidden;
        // 共有ref へも反映（梁の壁連動非表示用）。
        if (wallHiddenRef) wallHiddenRef.current[i] = isHidden;
        const hideOpeningsForCamera = isHidden && cameraTick >= 0;
        // 外側から見たときの近接壁カットアウェイ。AIレンダリングのスナップショットにも適用し、
        // 壁の外側から実行しても手前の外壁が写り込まず室内が生成されるようにする（インタラクティブ表示と一致）。
        // マスク描画（captureStep==='mask' / maskMode）時のみ、形状を欠かさないよう維持する。
        const cutAwayWall = isHidden && !maskMode && captureStep !== 'mask';

        const divs = wallDivisions[i] || 1;
        const bottomProd = selections[`${wallName}_0`];
        const bottomProdId = bottomProd ? bottomProd.id : 'default_no_tex';
        // 腰壁高さは天井高さ−1mm(height*1000-1)を上限にクランプ（保存値が天井超過でも上段が高さ0に潰れて
        // 天井を貫かないよう防御・260703）。下限 1mm。
        const wainscotHeight = Math.min(height * 1000 - 1, Math.max(1, materialSettings[bottomProdId]?.wainscotHeight ?? 900));

        return (
          <group key={i} visible={!cutAwayWall} position={[(p.x + next.x) / 2, 0, (p.z + next.z) / 2]} rotation={[0, rotationY, 0]}>
            {Array.from({ length: divs }).map((_, j) => {
                const subWallName = divs === 1 ? wallName : `${wallName}_${j}`;
                const segHeightMm = divs === 1 ? (height * 1000) : (j === 0 ? wainscotHeight : Math.max(0.1, (height * 1000) - wainscotHeight));
                const segHeight = segHeightMm / 1000;
                const yOffset = divs === 1 ? 0 : (j === 0 ? 0 : wainscotHeight / 1000);

                const prod = selections[subWallName];
                const matSettings = materialSettings[prod ? prod.id : 'default_no_tex'] || {};

                const isBottom = j === 0;
                const bbEnabled = isBottom && (matSettings.baseboardEnabled ?? false);
                // 巾木の高さはセグメント高さ−1mmを上限にクランプ（保存値が天井/腰壁を超えても、巾木上の壁が
                // 高さ0以下に潰れない防御・260703）。＝床〜天井（腰壁時は床〜腰壁）の範囲に収める。
                const bbHeightM = Math.min(Math.max(0, (matSettings.baseboardHeight ?? 60) / 1000), Math.max(0, segHeight - 0.001));
                const bbColor = matSettings.baseboardColor ?? '#ffffff';
                const openingStyle = materialSettings.__openings__ ?? {};
                const doorColor = openingStyle.doorColor ?? '#ffffff'; // 既定を白に（巾木の既定色に合わせる・260709）
                const doorFrameColor = openingStyle.doorFrameColor ?? '#444';
                const windowFrameColor = openingStyle.windowFrameColor ?? '#333';

                const actualWallH = bbEnabled ? segHeight - bbHeightM : segHeight;
                const actualWallY = yOffset + (bbEnabled ? bbHeightM + actualWallH / 2 : segHeight / 2);

                const wallOpenings = openings.filter((op: Opening) => op.wallIndex === i);

                const segmentMinY = yOffset + (bbEnabled ? bbHeightM : 0);
                const segmentMaxY = segmentMinY + actualWallH;
                const openingsInSegment = wallOpenings
                  .filter((op: Opening) => openingIntersectsVerticalSegment(op, segmentMinY, segmentMaxY))
                  .sort((a: Opening, b: Opening) => a.ratioPosition - b.ratioPosition);

                return (
                  <WallSegment
                    key={`${i}-${j}`}
                    subWallName={subWallName}
                    lengthM={length}
                    actualWallH={actualWallH}
                    actualWallY={actualWallY}
                    yOffset={yOffset}
                    isBottom={isBottom}
                    bbEnabled={bbEnabled}
                    bbHeightM={bbHeightM}
                    bbColor={bbColor}
                    segmentMinY={segmentMinY}
                    segmentMaxY={segmentMaxY}
                    openingsInSegment={openingsInSegment}
                    wallOpenings={wallOpenings}
                    isCCW={isCCW}
                    prod={prod}
                    materialSettings={materialSettings}
                    captureStep={captureStep}
                    shadowEnabled={shadowEnabled}
                    activeMeshes={activeMeshes}
                    snapshotMode={snapshotMode}
                    maskMode={maskMode}
                    hideOpeningsForCamera={hideOpeningsForCamera}
                    onMeshClick={onMeshClick}
                    setOpenings={setOpenings}
                    selectedOpeningId={selectedOpeningId}
                    onOpeningSelect={onOpeningSelect}
                    openings={openings}
                    isDraggingRef={isDraggingRef}
                    isLocalPlusZIndoor={isLocalPlusZIndoor}
                    doorColor={doorColor}
                    doorFrameColor={doorFrameColor}
                    windowFrameColor={windowFrameColor}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                    onHoverNameChange={onHoverNameChange}
                  />
                );
            })}
            {/* 4b: スケルトン天井の上部壁バンド（既定1000mm・数値調整可・テクスチャ可）。 */}
            {skeletonCeiling && skeletonUpperWallMm > 0 && (
              <UpperBandSegment
                length={length}
                bandM={skeletonUpperWallMm / 1000}
                yTop={height}
                openings={openings.filter((op: Opening) => op.wallIndex === i)}
                isCCW={isCCW}
                selections={selections}
                materialSettings={materialSettings}
                captureStep={captureStep}
                shadowEnabled={shadowEnabled}
                isDraggingRef={isDraggingRef}
                onMeshClick={onMeshClick}
                onHoverNameChange={onHoverNameChange}
              />
            )}
          </group>
        );
      })}
    </group>
  );
};

const CAMERA_BLEND_MS = 450;
const MAX_ORBIT_TARGET_DISTANCE_FROM_CAMERA = 5000;
const CONTINUOUS_ZOOM_SPEED = 0.0022;
const CONTINUOUS_ZOOM_MAX_DELTA = 180;

const WALK_SPEED = 2.3;
const WALK_SPEED_SLOW = 1.0;
const LOOK_SENS = 0.0022;
const PITCH_LIMIT = Math.PI / 3;

const LOOK_DRAG_THRESHOLD_PX = 8;

const WalkthroughController: React.FC<{
  eyeHeightM: number;
  walkBounds: WalkPolygon | null;
  walkSessionKey: number;
  walkInitialYaw: number;
  walkInitialPitch: number;
  walkSpawnXZ: [number, number] | null;
  digitalInputRef: React.MutableRefObject<{ forward: number; strafe: number; rotate: number; reset: boolean }>;
  cameraWalkStateRef: React.MutableRefObject<{ yaw: number; pitch: number }>;
  isDraggingRef: React.MutableRefObject<boolean>;
  disabled: boolean;
}> = ({
  eyeHeightM,
  walkBounds,
  walkSessionKey,
  walkInitialYaw,
  walkInitialPitch,
  walkSpawnXZ,
  digitalInputRef,
  cameraWalkStateRef,
  isDraggingRef,
  disabled,
}) => {
  const { camera, gl } = useThree();
  const yaw = useRef(0);
  const pitch = useRef(0);
  const keys = useRef(new Set<string>());
  const lookDrag = useRef(false);
  const lookPointerDown = useRef(false);
  const lookAccumulated = useRef(0);
  const lastPointer = useRef({ x: 0, y: 0 });

  useLayoutEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const x = walkSpawnXZ ? walkSpawnXZ[0] : 0;
    const z = walkSpawnXZ ? walkSpawnXZ[1] : 0;
    cam.position.set(x, eyeHeightM, z);
    yaw.current = walkInitialYaw;
    pitch.current = walkInitialPitch;
  }, [walkSessionKey, walkInitialYaw, walkInitialPitch, walkSpawnXZ, camera]);

  useEffect(() => {
    if (disabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      keys.current.add(k);
      if (e.key === 'Shift') keys.current.add('shift');
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      keys.current.delete(k);
      if (e.key === 'Shift') keys.current.delete('shift');
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [disabled]);

  useEffect(() => {
    if (disabled) return;
    const el = gl.domElement;
    const resetLookPointerState = () => {
      lookPointerDown.current = false;
      lookDrag.current = false;
      lookAccumulated.current = 0;
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (isDraggingRef.current) return;
      lookPointerDown.current = true;
      lookAccumulated.current = 0;
      lookDrag.current = false;
      lastPointer.current = { x: e.clientX, y: e.clientY };
    };
    const onPointerMove = (e: PointerEvent) => {
      if (isDraggingRef.current) {
        resetLookPointerState();
        return;
      }
      if (!lookPointerDown.current) return;
      const dx = e.clientX - lastPointer.current.x;
      const dy = e.clientY - lastPointer.current.y;
      lookAccumulated.current += Math.abs(dx) + Math.abs(dy);
      lastPointer.current = { x: e.clientX, y: e.clientY };
      if (!lookDrag.current) {
        if (lookAccumulated.current < LOOK_DRAG_THRESHOLD_PX) return;
        lookDrag.current = true;
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
      if (!lookDrag.current) return;
      e.preventDefault();
      yaw.current -= dx * LOOK_SENS;
      pitch.current = clampPitch(pitch.current - dy * LOOK_SENS, PITCH_LIMIT);
    };
    const endLook = (e: PointerEvent) => {
      if (e.type === 'pointerup' && e.button !== 0) return;
      resetLookPointerState();
      try {
        if (e.pointerId !== undefined) el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', endLook);
    el.addEventListener('pointercancel', endLook);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', endLook);
      el.removeEventListener('pointercancel', endLook);
    };
  }, [disabled, gl]);

  useFrame((_, delta) => {
    if (disabled) return;
    const cam = camera as THREE.PerspectiveCamera;
    const shift = keys.current.has('shift');
    const speed = shift ? WALK_SPEED_SLOW : WALK_SPEED;

    let f = 0;
    let s = 0;
    if (keys.current.has('w')) f += 1;
    if (keys.current.has('s')) f -= 1;
    if (keys.current.has('a')) s -= 1;
    if (keys.current.has('d')) s += 1;
    if (keys.current.has('arrowup')) f += 1;
    if (keys.current.has('arrowdown')) f -= 1;
    if (keys.current.has('arrowleft')) s -= 1;
    if (keys.current.has('arrowright')) s += 1;

    f += digitalInputRef.current.forward;
    s += digitalInputRef.current.strafe;

    if (keys.current.has('q')) yaw.current += 1.3 * delta;
    if (keys.current.has('e')) yaw.current -= 1.3 * delta;
    // 移動操作パネルの左右旋回ボタン（Q/E と同じ・260630 クライアント要望）。
    yaw.current += (digitalInputRef.current.rotate || 0) * 1.3 * delta;
    // 移動操作パネルの「視点を正面に戻す」ボタン（マウスホイールクリック相当）: 上下の傾きを水平へ（向き=yaw は維持）。
    if (digitalInputRef.current.reset) {
      pitch.current = 0;
      digitalInputRef.current.reset = false;
    }

    const fwd = walkForward(yaw.current);
    const right = walkRight(yaw.current);
    const move = new THREE.Vector3().addScaledVector(fwd, f).addScaledVector(right, s);
    if (move.lengthSq() > 1e-8) {
      move.normalize().multiplyScalar(speed * delta);
      cam.position.add(move);
    }

    cam.position.y = eyeHeightM;

    if (walkBounds) {
      // 外接矩形ではなく部屋ポリゴンに沿って閉じ込める（非矩形の部屋で1枚の壁だけ通り抜ける不具合の修正・260624）。
      const [cx, cz] = clampXZToPolygon(cam.position.x, cam.position.z, walkBounds, WALK_WALL_MARGIN);
      cam.position.x = cx;
      cam.position.z = cz;
    }

    cameraWalkStateRef.current.yaw = yaw.current;
    cameraWalkStateRef.current.pitch = pitch.current;

    cam.rotation.order = 'YXZ';
    cam.rotation.y = yaw.current;
    cam.rotation.x = pitch.current;
    cam.rotation.z = 0;
  });

  return null;
};

const CameraBlendController: React.FC<{
  orbitControlsRef: React.MutableRefObject<OrbitControlsImpl | null>;
  request: CameraBlendRequest | null;
  onBlendStart: () => void;
  onBlendEnd: () => void;
  onComplete: () => void;
}> = ({ orbitControlsRef, request, onBlendStart, onBlendEnd, onComplete }) => {
  const { camera } = useThree();
  const animRef = useRef<{
    start: number;
    fromPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    fromFov: number;
    toPos: THREE.Vector3;
    toTarget: THREE.Vector3;
    toFov: number;
  } | null>(null);

  useEffect(() => {
    if (!request) {
      animRef.current = null;
      return;
    }
    const cam = camera as THREE.PerspectiveCamera;
    let raf = 0;
    let cancelled = false;
    const tryStart = () => {
      if (cancelled) return;
      const ctrl = orbitControlsRef.current;
      if (!ctrl) {
        raf = requestAnimationFrame(tryStart);
        return;
      }
      onBlendStart();
      animRef.current = {
        start: performance.now(),
        fromPos: cam.position.clone(),
        fromTarget: ctrl.target.clone(),
        fromFov: cam.fov,
        toPos: new THREE.Vector3(...request.position),
        toTarget: new THREE.Vector3(...request.target),
        toFov: request.fov,
      };
    };
    tryStart();
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [request, camera, orbitControlsRef, onBlendStart]);

  useFrame(() => {
    const anim = animRef.current;
    if (!anim) return;
    const ctrl = orbitControlsRef.current;
    const cam = camera as THREE.PerspectiveCamera;
    if (!ctrl) return;
    const t = Math.min(1, (performance.now() - anim.start) / CAMERA_BLEND_MS);
    const e = t * t * (3 - 2 * t);
    cam.position.lerpVectors(anim.fromPos, anim.toPos, e);
    ctrl.target.lerpVectors(anim.fromTarget, anim.toTarget, e);
    cam.fov = THREE.MathUtils.lerp(anim.fromFov, anim.toFov, e);
    cam.updateProjectionMatrix();
    ctrl.update();
    if (t >= 1) {
      cam.position.copy(anim.toPos);
      ctrl.target.copy(anim.toTarget);
      cam.fov = anim.toFov;
      cam.updateProjectionMatrix();
      ctrl.update();
      animRef.current = null;
      onBlendEnd();
      onComplete();
    }
  });

  return null;
};

const OrbitContinuousZoomController: React.FC<{
  orbitControlsRef: React.MutableRefObject<OrbitControlsImpl | null>;
  enabled: boolean;
}> = ({ orbitControlsRef, enabled }) => {
  const { camera, gl } = useThree();
  const forward = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    if (!enabled) return;
    const el = gl.domElement;
    const onWheel = (e: WheelEvent) => {
      const ctrl = orbitControlsRef.current;
      if (!ctrl) return;
      const signedDelta = THREE.MathUtils.clamp(
        e.deltaY,
        -CONTINUOUS_ZOOM_MAX_DELTA,
        CONTINUOUS_ZOOM_MAX_DELTA
      );
      const amount = -signedDelta * CONTINUOUS_ZOOM_SPEED;
      if (Math.abs(amount) < 1e-6) return;
      e.preventDefault();
      camera.getWorldDirection(forward);
      if (forward.lengthSq() < 1e-10) return;
      forward.normalize().multiplyScalar(amount);
      camera.position.add(forward);
      ctrl.target.add(forward);
      ctrl.update();
    };
    // OrbitControls より先に捕捉して、ホイールズームを常時前後移動へ統一する
    el.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => {
      el.removeEventListener('wheel', onWheel, true);
    };
  }, [camera, enabled, forward, gl, orbitControlsRef]);

  return null;
};

const OrbitTargetGuard: React.FC<{
  orbitControlsRef: React.MutableRefObject<OrbitControlsImpl | null>;
  enabled: boolean;
}> = ({ orbitControlsRef, enabled }) => {
  const { camera } = useThree();
  const lastValidTargetRef = useRef(new THREE.Vector3(0, 0, 0));

  useFrame(() => {
    if (!enabled) return;
    const ctrl = orbitControlsRef.current;
    if (!ctrl) return;
    const target = ctrl.target;
    const isFiniteTarget =
      Number.isFinite(target.x) && Number.isFinite(target.y) && Number.isFinite(target.z);
    const dist = camera.position.distanceTo(target);
    const tooFar = !Number.isFinite(dist) || dist > MAX_ORBIT_TARGET_DISTANCE_FROM_CAMERA;

    if (isFiniteTarget && !tooFar) {
      lastValidTargetRef.current.copy(target);
      return;
    }

    if (!isFiniteTarget) {
      target.copy(lastValidTargetRef.current);
    } else if (tooFar) {
      target.copy(lastValidTargetRef.current);
    }

    const hasFiniteRestored =
      Number.isFinite(target.x) && Number.isFinite(target.y) && Number.isFinite(target.z);
    if (!hasFiniteRestored) {
      const fallbackDir = new THREE.Vector3();
      camera.getWorldDirection(fallbackDir);
      if (fallbackDir.lengthSq() < 1e-8) fallbackDir.set(0, 0, -1);
      target.copy(camera.position).addScaledVector(fallbackDir.normalize(), 2.5);
      lastValidTargetRef.current.copy(target);
    }

    ctrl.update();
  });

  return null;
};

export const RoomViewer: React.FC<RoomViewerProps> = ({ 
  selections, 
  onMeshClick, 
  activeCategory, 
  activeMeshes, 
  cameraRef, 
  modelUrl, 
  sketchPoints, 
  roomHeight, 
  snapshotMode = false, 
  furnitureItems,
  onFurnitureUpdate,
  activeFurnitureId,
  onFurnitureSelect,
  beams = [],
  skeletonCeiling = false,
  skeletonUpperWallMm = 1000,
  onBeamPatch,
  onBeamSelect3D,
  hideFurniture = false,
  maskMode = false,
  materialSettings,
  wallDivisions,
  isRendering,
  captureStep,
  openings,
  setOpenings,
  selectedOpeningId,
  onOpeningSelect,
  outsideBackgroundColor = '#0a0a0a',
  orbitControlsRef,
  cameraBlendRequest,
  onCameraBlendComplete,
  cameraMode,
  cameraFov,
  eyeHeightMm,
  walkSessionKey,
  walkInitialYaw,
  walkInitialPitch,
  walkSpawnXZ,
  walkDigitalInputRef,
  cameraWalkStateRef,
}) => {
  // ドラッグ中かどうかを判定するステートを追加
  const [isDragging, setIsDragging] = useState(false);
  const [hoveredName, setHoveredName] = useState<string | null>(null);
  const isDraggingRef = useRef(false);
  const dragUnlockTimerRef = useRef<number | null>(null);
  const postDragSuppressUntilRef = useRef(0);
  // 壁ごとの「カメラ背面で非表示」状態を SketchRoom が書き込み、Beams3D が読む共有ref（梁の壁連動非表示用）。
  const wallHiddenRef = useRef<Record<number, boolean>>({});
  // 3Dでの梁選択（直接操作のため）。
  const [selectedBeam3DId, setSelectedBeam3DId] = useState<string | null>(null);
  
  useEffect(() => {
    isDraggingRef.current = isDragging;
  }, [isDragging]);

  useEffect(() => {
    return () => {
      if (dragUnlockTimerRef.current != null) {
        window.clearTimeout(dragUnlockTimerRef.current);
        dragUnlockTimerRef.current = null;
      }
    };
  }, []);

  const beginDragInteraction = useCallback(() => {
    if (dragUnlockTimerRef.current != null) {
      window.clearTimeout(dragUnlockTimerRef.current);
      dragUnlockTimerRef.current = null;
    }
    isDraggingRef.current = true;
    setIsDragging(true);
  }, []);

  const markPostDragGuard = useCallback(() => {
    postDragSuppressUntilRef.current = performance.now() + POST_DRAG_GUARD_MS;
  }, []);

  const endDragInteraction = useCallback(() => {
    markPostDragGuard();
    if (dragUnlockTimerRef.current != null) {
      window.clearTimeout(dragUnlockTimerRef.current);
    }
    dragUnlockTimerRef.current = window.setTimeout(() => {
      isDraggingRef.current = false;
      setIsDragging(false);
      dragUnlockTimerRef.current = null;
    }, POST_DRAG_GUARD_MS);
  }, [markPostDragGuard]);

  const isInteractionSuppressed = useCallback(() => {
    if (isDraggingRef.current) return true;
    return performance.now() < postDragSuppressUntilRef.current;
  }, []);

  const safeHoverNameChange = useCallback(
    (name: string | null) => {
      if (isInteractionSuppressed()) return;
      setHoveredName(name);
    },
    [isInteractionSuppressed]
  );

  const safeMeshClick = useCallback(
    (category: MaterialCategory, meshName: string, isMulti: boolean) => {
      if (isInteractionSuppressed()) return;
      setSelectedBeam3DId(null); // 壁・床・天井を選択したら梁の選択を解除
      onBeamSelect3D?.(null);
      onMeshClick(category, meshName, isMulti);
    },
    [isInteractionSuppressed, onMeshClick, onBeamSelect3D]
  );

  // 建具を選択したら梁の選択を解除する。
  const selectOpeningClearBeam = useCallback(
    (id: string | null) => {
      if (id) { setSelectedBeam3DId(null); onBeamSelect3D?.(null); }
      onOpeningSelect(id);
    },
    [onOpeningSelect, onBeamSelect3D]
  );

  // 梁を選択したら他の選択（家具・建具）を解除する。
  const selectBeamClearOthers = useCallback(
    (id: string | null) => {
      setSelectedBeam3DId(id);
      onBeamSelect3D?.(id);
      if (id) {
        onFurnitureSelect(null);
        onOpeningSelect(null);
      }
    },
    [onFurnitureSelect, onOpeningSelect, onBeamSelect3D]
  );

  const sketchFloorPolygon = useMemo(() => {
    if (modelUrl || sketchPoints.length < 3) return null;
    const { centerMm } = getRoomTransform(sketchPoints);
    const polygonMm = sketchPoints.map((p) => ({ x: scaledToMm(p.x), y: scaledToMm(p.y) }));
    return { centerMm, polygonMm };
  }, [modelUrl, sketchPoints]);

  const walkBounds = useMemo((): WalkPolygon | null => {
    if (modelUrl || sketchPoints.length < 3) return null;
    const { mPoints } = getRoomTransform(sketchPoints as Point[]);
    // 外接矩形ではなく実際の壁ポリゴンを返し、非矩形の部屋でも壁に沿って閉じ込める（260624）。
    return mPoints.length >= 3 ? mPoints : null;
  }, [modelUrl, sketchPoints]);

  const eyeHeightM = eyeHeightMm / 1000;

  const [cameraBlending, setCameraBlending] = useState(false);
  const handleBlendStart = useCallback(() => setCameraBlending(true), []);
  const handleBlendEnd = useCallback(() => setCameraBlending(false), []);

  const controlsGloballyLocked =
    snapshotMode || maskMode || !!isRendering || captureStep === 'mask';

  // 複数選択(store.selectedIds)を 3D アウトラインへ反映するため購読（260623・Cフェーズ2b）。
  const selectedIds = useStore(useProjectStore, (s) => s.selectedIds);

  const selectedNames = useMemo(() => {
    const names = [...activeMeshes];
    if (activeFurnitureId) names.push(`${FURNITURE_NAME_PREFIX}${activeFurnitureId}`);
    // 複数選択（selectedIds）も全てアウトライン。activeFurnitureId と重複しても OutlinePass 側で Set 化される。
    for (const id of selectedIds) names.push(`${FURNITURE_NAME_PREFIX}${id}`);
    if (selectedOpeningId) names.push(`${OPENING_NAME_PREFIX}${selectedOpeningId}`);
    // 2d: 選択中の梁も他オブジェクトと同じ OutlinePass で強調する。
    if (selectedBeam3DId) names.push(`Beam_${selectedBeam3DId}`);
    return names;
  }, [activeMeshes, activeFurnitureId, selectedIds, selectedOpeningId, selectedBeam3DId]);

  // 全家具メッシュのレジストリ（id→THREE.Group）。グループ移動で非ドラッグメンバーもドラッグ中に直接動かす（260703）。
  const furnitureMeshRegistry = useRef<Map<string, THREE.Group>>(new Map());

  // グループ回転ギズモ（260703 クライアント要望「グループを一括回転」）: 複数選択/グループ(2件以上)の重心・
  // 半径・平面Y を算出。members<2 のときは null（＝個別リングのまま）。重心は剛体回転で不変なのでドラッグ中も安定。
  const groups = useStore(useProjectStore, (s) => s.scene.groups);
  const groupSelection = useMemo(() => {
    const seed = activeFurnitureId ?? selectedIds[0] ?? null;
    if (!seed) return null;
    const members = resolveMoveMembers(seed, groups, selectedIds);
    if (members.size < 2) return null;
    const centroid = computeGroupCentroidXZ(furnitureItems, members);
    if (!centroid) return null;
    let sy = 0;
    let n = 0;
    let maxR = 0;
    for (const f of furnitureItems) {
      if (!members.has(f.id)) continue;
      sy += f.position[1];
      n++;
      const r = Math.hypot(f.position[0] - centroid.x, f.position[2] - centroid.z) + getFurnitureRingRadiusM(f);
      if (r > maxR) maxR = r;
    }
    return { members, centroid, planeY: n ? sy / n : 0, radius: Math.max(0.5, maxR) };
  }, [activeFurnitureId, selectedIds, groups, furnitureItems]);

  return (
    <div className="w-full h-full bg-[#0a0a0a] relative">
      <Canvas 
        shadows
        dpr={[1, 2]} 
        gl={{ 
          antialias: true, 
          preserveDrawingBuffer: true, 
          alpha: false,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 0.85
        }}
        onCreated={({ gl }) => {
          // AIレンダリングのスナップショットが、隠しサムネイル生成用キャンバス等ではなく
          // このメイン3Dルームキャンバスを確実に選べるよう目印を付ける（useAiRenderer 参照）。
          gl.domElement.dataset.ariseRoom = '1';
          // 2D→3D のローディング・オーバーレイを解除（3Dキャンバス生成後、数フレーム描画してから隠す・260630）。
          requestAnimationFrame(() => requestAnimationFrame(() => useLoadingStore.getState().hide('view')));
        }}
        onPointerMissed={(e) => {
            if (isInteractionSuppressed()) return;
            if (e.type === 'click') {
                onFurnitureSelect(null);
                setSelectedBeam3DId(null); // 何もない所をクリックで梁の選択も解除
                onBeamSelect3D?.(null);
            }
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <color attach="background" args={[captureStep === 'mask' ? '#000000' : (maskMode ? '#000000' : outsideBackgroundColor)]} />
        {!maskMode && captureStep !== 'mask' && (
          <mesh position={[0, 8, 0]}>
            <sphereGeometry args={[250, 24, 24]} />
            <meshBasicMaterial color={outsideBackgroundColor} side={THREE.BackSide} />
          </mesh>
        )}

        <PerspectiveCamera makeDefault position={[12, 10, 12]} fov={cameraFov} ref={cameraRef} />
        
        {cameraMode === 'orbit' && (
          <>
            <OrbitControls 
                ref={orbitControlsRef}
                makeDefault 
                enableDamping={!snapshotMode && !maskMode && captureStep !== 'mask'} 
                enabled={
                  !controlsGloballyLocked &&
                  !isDragging &&
                  !cameraBlending
                }
                enablePan={true}
                screenSpacePanning={true}
                dollyToCursor={false}
                minDistance={0.8}
                maxDistance={5000}
            />
            <OrbitTargetGuard
              orbitControlsRef={orbitControlsRef}
              enabled={
                !controlsGloballyLocked &&
                !isDragging &&
                !cameraBlending
              }
            />
            <OrbitContinuousZoomController
              orbitControlsRef={orbitControlsRef}
              enabled={
                !controlsGloballyLocked &&
                !isDragging &&
                !cameraBlending
              }
            />

            <CameraBlendController
              orbitControlsRef={orbitControlsRef}
              request={cameraBlendRequest}
              onBlendStart={handleBlendStart}
              onBlendEnd={handleBlendEnd}
              onComplete={() => onCameraBlendComplete?.()}
            />
          </>
        )}

        {cameraMode === 'walk' && (
          <WalkthroughController
            eyeHeightM={eyeHeightM}
            walkBounds={walkBounds}
            walkSessionKey={walkSessionKey}
            walkInitialYaw={walkInitialYaw}
            walkInitialPitch={walkInitialPitch}
            walkSpawnXZ={walkSpawnXZ}
            digitalInputRef={walkDigitalInputRef}
            cameraWalkStateRef={cameraWalkStateRef}
            isDraggingRef={isDraggingRef}
            disabled={controlsGloballyLocked}
          />
        )}
        {!snapshotMode && !maskMode && captureStep !== 'mask' && <gridHelper args={[40, 40, 0x222222, 0x111111]} position={[0, -0.02, 0]} />}

        <Suspense fallback={null}>
            <CanvasErrorBoundary>
                <group>
                    {/* マスクモード時は照明とエフェクトを完全に消す */}
                    {!maskMode && captureStep !== 'mask' && (
                        <>
                            {/* 影を作らず、空間全体を均一に照らすフラットライティング */}
                            <ambientLight intensity={0.2} />
                            <hemisphereLight color="#ffffff" groundColor="#111111" intensity={0.4} />
                            
                            {/* 立体感を出すための補助光（影は落とさない） */}
                            <directionalLight position={[5, 5, 5]} intensity={0.5} castShadow={false} />
                            <directionalLight position={[-5, 5, -5]} intensity={0.3} castShadow={false} />

                            {/* AIに「素材の質感（ツヤ・金属感）」を伝えるためのHDRI反射情報だけは残す */}
                            <Environment files="https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/sculpture_exhibition_1k.hdr" environmentIntensity={0.5} />
                        </>
                    )}

                    {/* --- 以下、元のモデル描画部分 --- */}
                    {modelUrl ? (
                        <CustomBIMModel
                          url={modelUrl}
                          selections={selections}
                          onMeshClick={safeMeshClick}
                          materialSettings={materialSettings}
                          isDraggingRef={isDraggingRef}
                          captureStep={captureStep}
                          onHoverNameChange={safeHoverNameChange}
                        />
                    ) : sketchPoints.length >= 3 ? (
                        <SketchRoom 
                          points={sketchPoints} 
                          selections={selections} 
                          onMeshClick={safeMeshClick} 
                          height={roomHeight} 
                          activeMeshes={activeMeshes} 
                          snapshotMode={snapshotMode} 
                          maskMode={maskMode}
                          materialSettings={materialSettings} 
                          isDraggingRef={isDraggingRef} 
                          wallDivisions={wallDivisions} 
                          captureStep={captureStep} 
                          openings={openings}
                          setOpenings={setOpenings}
                          selectedOpeningId={selectedOpeningId}
                          onOpeningSelect={selectOpeningClearBeam}
                          onDragStart={beginDragInteraction}
                          onDragEnd={endDragInteraction}
                          onHoverNameChange={safeHoverNameChange}
                          skeletonCeiling={skeletonCeiling}
                          skeletonUpperWallMm={skeletonUpperWallMm}
                          wallHiddenRef={wallHiddenRef}
                        />
                    ) : null}

                    {hideFurniture ? null : furnitureItems.map((item) => (
                        <GLTFFurniture
                            key={item.id} item={item} isSelected={activeFurnitureId === item.id}
                            onSelect={(additive) => { setSelectedBeam3DId(null); onBeamSelect3D?.(null); onFurnitureSelect(item.id, additive); }}
                            isDraggingRef={isDraggingRef}
                            snapshotMode={snapshotMode || false}
                            maskMode={maskMode}
                            captureStep={captureStep}
                            sketchFloorDrag={!!sketchFloorPolygon}
                            centerMm={sketchFloorPolygon?.centerMm}
                            polygonMm={sketchFloorPolygon?.polygonMm}
                            onFurniturePatch={(id, position, rotation) => {
                              // 一緒に動かす集合は「所属グループのメンバー ∪ 複数選択」から求める（選択のタイミングに依存せず
                              // グループが確実に一緒に動く・260703 クライアント報告対応）。移動はグループ全員、回転は対象のみ。
                              const state = useProjectStore.getState();
                              const moveMembers = resolveMoveMembers(id, state.scene.groups, state.selectedIds);
                              onFurnitureUpdate((prev) => applyFurniturePatch(prev, id, position, rotation, moveMembers));
                            }}
                            onFurnitureDragStart={beginDragInteraction}
                            onFurnitureDragEnd={endDragInteraction}
                            onPostDragGuard={markPostDragGuard}
                            onHoverNameChange={safeHoverNameChange}
                            suppressRing={!!groupSelection}
                            meshRegistry={furnitureMeshRegistry}
                        />
                    ))}
                    {/* グループ回転ギズモ（複数選択/グループの重心に1つ・全員を重心まわりに一括回転・260703） */}
                    {!hideFurniture && groupSelection && sketchFloorPolygon && !snapshotMode && !maskMode && captureStep !== 'mask' && (
                      <GroupRotationGizmo3D
                        centroidXZ={groupSelection.centroid}
                        planeY={groupSelection.planeY}
                        radius={groupSelection.radius}
                        memberIds={groupSelection.members}
                        onGroupRotate={(members, centroid, dTheta) => {
                          // 剛体回転（2D グループ回転と同様に壁クランプしない）。クランプすると回転が非剛体化して
                          // 重心がずれ、増分回転の基準角と食い違って「歩く」ため（260703 検証 w1）。はみ出しは移動で戻せる。
                          onFurnitureUpdate((prev) => applyGroupRotation(prev, members, centroid, dTheta));
                        }}
                        onDragStart={beginDragInteraction}
                        onDragEnd={endDragInteraction}
                        onPostDragGuard={markPostDragGuard}
                      />
                    )}
                    <Beams3D
                      beams={beams}
                      centerMm={sketchFloorPolygon?.centerMm}
                      polygonMm={sketchFloorPolygon?.polygonMm}
                      // スケルトン天井時は天井（＋上部壁ぶん）へ上がるので、梁も同じ高さへ引き上げる
                      // （260701・クライアント要望「梁も上（天井）にあげる」）。梁Yは roomHeight から算出されるため props で調整。
                      roomHeight={skeletonCeiling && skeletonUpperWallMm > 0 ? roomHeight + skeletonUpperWallMm / 1000 : roomHeight}
                      wallHiddenRef={wallHiddenRef}
                      selectedBeamId={selectedBeam3DId}
                      onBeamSelect={selectBeamClearOthers}
                      onBeamPatch={onBeamPatch}
                      editable={!snapshotMode && !maskMode && captureStep !== 'mask'}
                      onDragStart={beginDragInteraction}
                      onDragEnd={endDragInteraction}
                      selections={selections}
                      materialSettings={materialSettings}
                      captureStep={captureStep}
                      onHoverNameChange={safeHoverNameChange}
                    />
                </group>
            </CanvasErrorBoundary>
        </Suspense>
        <SceneOutlineEffects
          selectedNames={selectedNames}
          hoveredName={hoveredName}
          editingActive={isDragging}
          enabled={!snapshotMode && !maskMode && captureStep !== 'mask'}
        />
      </Canvas>
    </div>
  );
};