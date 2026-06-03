/** オブジェクトインデックスごとの色（UI・配置マスク・プロンプトで共通） */
export const AI_EDIT_OBJECT_PALETTE_RGB: { r: number; g: number; b: number }[] = [
  { r: 52, g: 211, b: 153 },
  { r: 96, g: 165, b: 250 },
  { r: 251, g: 191, b: 36 },
  { r: 244, g: 114, b: 182 },
  { r: 167, g: 139, b: 250 },
  { r: 45, g: 212, b: 191 },
];

export const AI_EDIT_OBJECT_PALETTE_UI: { border: string; fill: string }[] = AI_EDIT_OBJECT_PALETTE_RGB.map(
  ({ r, g, b }) => ({
    border: `rgb(${r} ${g} ${b})`,
    fill: `rgba(${r},${g},${b},0.14)`,
  })
);

export function aiEditObjectUiColors(index: number) {
  return AI_EDIT_OBJECT_PALETTE_UI[index % AI_EDIT_OBJECT_PALETTE_UI.length]!;
}

export function aiEditObjectRgb(index: number) {
  return AI_EDIT_OBJECT_PALETTE_RGB[index % AI_EDIT_OBJECT_PALETTE_RGB.length]!;
}
