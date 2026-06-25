// vite-plugins/lpGallery.ts が供給する仮想モジュールの型（260625）。
// public/assets/lp-gallery/ 内画像の配信URL配列。
declare module 'virtual:lp-gallery' {
  const urls: string[];
  export default urls;
}
