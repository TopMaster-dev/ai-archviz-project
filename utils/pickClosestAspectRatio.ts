/** Gemini imageConfig で使える aspectRatio 値（公式一覧に準拠） */
const ASPECT_RATIOS: { key: string; ratio: number }[] = [
  { key: '1:1', ratio: 1 },
  { key: '2:3', ratio: 2 / 3 },
  { key: '3:2', ratio: 3 / 2 },
  { key: '3:4', ratio: 3 / 4 },
  { key: '4:3', ratio: 4 / 3 },
  { key: '4:5', ratio: 4 / 5 },
  { key: '5:4', ratio: 5 / 4 },
  { key: '9:16', ratio: 9 / 16 },
  { key: '16:9', ratio: 16 / 9 },
  { key: '21:9', ratio: 21 / 9 },
  { key: '1:4', ratio: 1 / 4 },
  { key: '4:1', ratio: 4 },
  { key: '1:8', ratio: 1 / 8 },
  { key: '8:1', ratio: 8 },
];

export function pickClosestAspectRatio(width: number, height: number): string {
  if (width <= 0 || height <= 0) return '16:9';
  const r = width / height;
  let best = '16:9';
  let bestScore = Infinity;
  for (const { key, ratio } of ASPECT_RATIOS) {
    const score = Math.abs(Math.log(r / ratio));
    if (score < bestScore) {
      bestScore = score;
      best = key;
    }
  }
  return best;
}
