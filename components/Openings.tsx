import React from 'react';
import * as THREE from 'three';
import { DOOR_FRAME_THICKNESS_MM, resolveDoorSwing3D } from '../utils/sketchTransform.js';

interface OpeningProps {
  width: number;
  height: number;
  depth?: number;
}

interface WindowProps extends OpeningProps {
  type?: 'window_fix' | 'window_sliding' | 'window_casement';
  frameColor?: string;
  sashColor?: string;
  glassColor?: string;
}

export const OPENING_OUTSET_MM = 20;
export const OPENING_INNER_REVEAL_MM = 10;
export const OPENING_DEPTH_MM = 150;
export const OPENING_DEPTH_M = OPENING_DEPTH_MM / 1000;
// 開口中心を壁ローカル+Zへずらし、室内側の見え量を一定に保つ（現在は10mm）
export const OPENING_CENTER_OFFSET_M = OPENING_DEPTH_M / 2 - OPENING_INNER_REVEAL_MM / 1000;

export const ParametricWindow: React.FC<WindowProps> = ({
  width,
  height,
  depth = OPENING_DEPTH_M,
  type = 'window_fix',
  frameColor = '#333',
  sashColor = '#444',
  glassColor = '#88ccff',
}) => {
  const frameThickness = 0.04;
  const w = width / 1000;
  const h = height / 1000;
  const d = depth;

  const isSliding = type === 'window_sliding';
  const isCasement = type === 'window_casement';

  return (
    <group>
      {/* Outer Frame */}
      <mesh position={[0, frameThickness / 2, 0]}>
        <boxGeometry args={[w, frameThickness, d]} />
        <meshStandardMaterial color={frameColor} side={THREE.FrontSide} />
      </mesh>
      <mesh position={[0, h - frameThickness / 2, 0]}>
        <boxGeometry args={[w, frameThickness, d]} />
        <meshStandardMaterial color={frameColor} side={THREE.FrontSide} />
      </mesh>
      <mesh position={[-w / 2 + frameThickness / 2, h / 2, 0]}>
        <boxGeometry args={[frameThickness, h, d]} />
        <meshStandardMaterial color={frameColor} side={THREE.FrontSide} />
      </mesh>
      <mesh position={[w / 2 - frameThickness / 2, h / 2, 0]}>
        <boxGeometry args={[frameThickness, h, d]} />
        <meshStandardMaterial color={frameColor} side={THREE.FrontSide} />
      </mesh>

      {isSliding ? (
        <>
          {/* Left/Back Sash */}
          <group position={[-w / 4 + frameThickness / 4, h / 2, -0.02]}>
             <mesh position={[w / 4 - frameThickness / 2, 0, 0]}>
                <boxGeometry args={[frameThickness, h - frameThickness * 2, 0.03]} />
                <meshStandardMaterial color={sashColor} side={THREE.FrontSide} />
             </mesh>
             <mesh>
                <boxGeometry args={[w / 2 - frameThickness * 1.5, h - frameThickness * 2, 0.01]} />
                <meshPhysicalMaterial color={glassColor} transparent opacity={0.3} roughness={0} metalness={0.1} transmission={0.9} thickness={0.01} side={THREE.DoubleSide} />
             </mesh>
          </group>
          {/* Right/Front Sash */}
          <group position={[w / 4 - frameThickness / 4, h / 2, 0.02]}>
             <mesh position={[-w / 4 + frameThickness / 2, 0, 0]}>
                <boxGeometry args={[frameThickness, h - frameThickness * 2, 0.03]} />
                <meshStandardMaterial color={sashColor} side={THREE.FrontSide} />
             </mesh>
             <mesh>
                <boxGeometry args={[w / 2 - frameThickness * 1.5, h - frameThickness * 2, 0.01]} />
                <meshPhysicalMaterial color={glassColor} transparent opacity={0.3} roughness={0} metalness={0.1} transmission={0.9} thickness={0.01} side={THREE.DoubleSide} />
             </mesh>
          </group>
        </>
      ) : isCasement ? (
        <group position={[0, h / 2, 0.02]} rotation={[0, 0.2, 0]}>
          <mesh>
            <boxGeometry args={[w - frameThickness * 2, h - frameThickness * 2, 0.03]} />
            <meshStandardMaterial color={sashColor} side={THREE.FrontSide} />
          </mesh>
          <mesh position={[0, 0, 0.011]}>
            <boxGeometry args={[w - frameThickness * 4, h - frameThickness * 4, 0.01]} />
            <meshPhysicalMaterial 
              color={glassColor} 
              transparent 
              opacity={0.3} 
              roughness={0} 
              metalness={0.1} 
              transmission={0.9} 
              thickness={0.01} 
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
        </group>
      ) : (
        /* Fix Glass */
        <mesh position={[0, h / 2, 0.005]}>
          <boxGeometry args={[w - frameThickness * 2, h - frameThickness * 2, 0.01]} />
          <meshPhysicalMaterial 
            color={glassColor} 
            transparent 
            opacity={0.3} 
            roughness={0} 
            metalness={0.1} 
            transmission={0.9} 
            thickness={0.01} 
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      )}
    </group>
  );
};

interface DoorProps extends OpeningProps {
  type?: 'door_single' | 'door_sliding';
  doorColor?: string;
  frameColor?: string;
  handleColor?: string;
  /** 吊り元の左右（2D平面図の swingFlipX と連動・260611 Sec1） */
  swingFlipX?: boolean;
  /** 開く内外（2D平面図の swingFlipY と連動） */
  swingFlipY?: boolean;
  /** 壁ローカル +Z が室内側か（3D側で算出して渡す） */
  isLocalPlusZIndoor?: boolean;
  /** 壁ローカルXの反転（isCCW） */
  isAxisFlipped?: boolean;
}

export const ParametricDoor: React.FC<DoorProps> = ({
  width,
  height,
  depth = OPENING_DEPTH_M,
  type = 'door_single',
  doorColor = '#8b4513',
  frameColor = '#444',
  handleColor = '#ffd700',
  swingFlipX,
  swingFlipY,
  isLocalPlusZIndoor = true,
  isAxisFlipped = false,
}) => {
  const w = width / 1000;
  const h = height / 1000;
  const d = depth;
  const frameThickness = DOOR_FRAME_THICKNESS_MM / 1000;
  // 下枠はフラット見えを維持しつつ、奥行きと位置基準を3方枠へ一致させる
  const thresholdHeight = 0.005;
  const thresholdDepth = d + 0.02;
  const thresholdWidth = w + frameThickness * 2;

  const isSliding = type === 'door_sliding';

  return (
    <group>
      {/* Frame */}
      <mesh position={[0, h - frameThickness / 2, 0]}>
        <boxGeometry args={[w + frameThickness * 2, frameThickness, d + 0.02]} />
        <meshStandardMaterial color={frameColor} side={THREE.FrontSide} />
      </mesh>
      <mesh position={[-w / 2 - frameThickness / 2, h / 2, 0]}>
        <boxGeometry args={[frameThickness, h, d + 0.02]} />
        <meshStandardMaterial color={frameColor} side={THREE.FrontSide} />
      </mesh>
      <mesh position={[w / 2 + frameThickness / 2, h / 2, 0]}>
        <boxGeometry args={[frameThickness, h, d + 0.02]} />
        <meshStandardMaterial color={frameColor} side={THREE.FrontSide} />
      </mesh>
      {/* Threshold: share the same center-Z baseline as three-side frame */}
      <mesh position={[0, thresholdHeight / 2, 0]}>
        <boxGeometry args={[thresholdWidth, thresholdHeight, thresholdDepth]} />
        <meshStandardMaterial
          color={frameColor}
          side={THREE.FrontSide}
          polygonOffset
          polygonOffsetFactor={-0.5}
          polygonOffsetUnits={-1}
        />
      </mesh>

      {isSliding ? (
        <group position={[0, h / 2, 0.03]}>
          <mesh position={[-w / 4, 0, 0]}>
            <boxGeometry args={[w / 2, h, 0.04]} />
            <meshStandardMaterial color={doorColor} roughness={0.8} side={THREE.FrontSide} />
          </mesh>
          <mesh position={[w / 4, 0, -0.04]}>
            <boxGeometry args={[w / 2, h, 0.04]} />
            <meshStandardMaterial color={doorColor} roughness={0.8} side={THREE.FrontSide} />
          </mesh>
        </group>
      ) : (() => {
        // 開き戸: 吊り元と開き方向を2D平面図と連動させる（260611 Sec1）。
        const { hingeXSign, openZSign } = resolveDoorSwing3D(swingFlipX, swingFlipY, isLocalPlusZIndoor, isAxisFlipped);
        const OPEN_ANGLE = Math.PI / 2.6; // 約69°: 開き方向が分かる程度に開く
        const beta = openZSign * hingeXSign * OPEN_ANGLE;
        const hingeX = hingeXSign * (w / 2);
        const handleX = -hingeXSign * (w - 0.1); // 自由端側
        return (
          <group position={[hingeX, 0, 0]} rotation={[0, beta, 0]}>
            {/* Door Leaf: 吊り元(ローカル原点)から反対側へ w 伸びる */}
            <mesh position={[-hingeXSign * (w / 2), h / 2, 0]}>
              <boxGeometry args={[w, h, 0.04]} />
              <meshStandardMaterial color={doorColor} roughness={0.8} side={THREE.DoubleSide} />
            </mesh>
            {/* Handle: 自由端側 */}
            <mesh position={[handleX, h / 2, 0.03]}>
              <sphereGeometry args={[0.02, 16, 16]} />
              <meshStandardMaterial color={handleColor} metalness={0.8} roughness={0.2} side={THREE.FrontSide} />
            </mesh>
          </group>
        );
      })()}
    </group>
  );
};
