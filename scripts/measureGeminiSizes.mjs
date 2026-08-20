/**
 * Gemini が 2K で実際に返す画像寸法を、比率ごとに実測する（260820）。
 *
 * 【なぜ必要か】
 * 「AIで写真編集」の版1は利用者の写真なので、寸法をこちらで決める必要がある。
 * この寸法が生成結果と一致していないと、
 *   1. モデルへの入力と要求出力の解像度が食い違い、モデルが構図を描き直しやすくなる
 *   2. 生成結果を版寸法へ cover で合わせる際に中央クロップが入り、編集ごとに蓄積する
 * が起きる。図面PJは版1が生成画像そのものなので、この問題が起きない。
 *
 * 生成サイズを「理論値から推測」したことが、これまでの不具合の原因だった
 * （手段2 の 2688 / normalizeAiEditBase の 2688 いずれも推測値）。
 * よって推測せず、実際に1枚ずつ生成して測る。
 *
 * 【使い方】
 *   GEMINI_API_KEY=xxxx node scripts/measureGeminiSizes.mjs
 *
 * 別のモデルで測るとき（案1でモデルを固定した後は必ず測り直すこと）:
 *   GEMINI_API_KEY=xxxx GEMINI_IMAGE_MODEL=gemini-3-pro-image node scripts/measureGeminiSizes.mjs
 *
 * 実行後、出力された表を utils/printExportSpec.ts の
 * MEASURED_GEMINI_2K_SIZES へ貼り付ける。**実測値以外は入れないこと。**
 *
 * 【費用】比率の数だけ画像を生成する（既定10枚）。1枚あたりのコストは通常の生成1回と同じ。
 */

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image-preview';
const IMAGE_SIZE = process.env.GEMINI_IMAGE_SIZE || '2K';

// utils/cropToAspect.ts の CROP_RATIOS と揃える（写真取込で選べる比率）。
const RATIOS = ['1:1', '4:5', '5:4', '3:4', '4:3', '2:3', '3:2', '16:9', '9:16', '21:9'];

if (!API_KEY) {
  console.error('GEMINI_API_KEY が未設定です。');
  console.error('例: GEMINI_API_KEY=xxxx node scripts/measureGeminiSizes.mjs');
  process.exit(1);
}

/** PNG / JPEG のヘッダから寸法を読む（画像ライブラリ不要）。 */
function readImageSize(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

async function measure(aspectRatio) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'A plain empty room interior, neutral walls.' }] }],
        generationConfig: {
          temperature: 0.1,
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio, imageSize: IMAGE_SIZE },
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const inline = parts.find((p) => p.inlineData?.data)?.inlineData;
  if (!inline) throw new Error('画像が返りませんでした');
  const size = readImageSize(Buffer.from(inline.data, 'base64'));
  if (!size) throw new Error('寸法を読めませんでした');
  return size;
}

const results = [];
console.log(`モデル: ${MODEL} / imageSize: ${IMAGE_SIZE}\n`);
for (const r of RATIOS) {
  try {
    const s = await measure(r);
    results.push({ ratio: r, ...s });
    console.log(`  ${r.padEnd(6)} → ${s.w}x${s.h}  (実比 ${(s.w / s.h).toFixed(5)})`);
  } catch (e) {
    console.log(`  ${r.padEnd(6)} → 失敗: ${e.message}`);
  }
}

console.log('\n--- utils/printExportSpec.ts の MEASURED_GEMINI_2K_SIZES へ貼り付け ---\n');
for (const r of results) {
  console.log(`  '${r.ratio}': { w: ${r.w}, h: ${r.h} },`);
}
console.log('');
