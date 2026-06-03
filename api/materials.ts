import { v2 as cloudinary } from 'cloudinary';
import { deriveMaterialPhysical } from '../lib/materialPhysical.js';

// Cloudinary Configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
        console.error("Server Error: Cloudinary credentials missing.");
        return res.status(500).json({ error: "Server Configuration Error" });
    }

    // Search for all images under 'materials' folder recursively
    const searchResult = await cloudinary.search
      .expression('resource_type:image AND folder:materials/*')
      .sort_by('public_id', 'asc')
      .max_results(500)
      .execute();
    
    const resources = searchResult.resources || [];

    // Helper: Generate consistent pseudo-random number from string
    const hashCode = (str: string) => {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash = hash & hash;
      }
      return Math.abs(hash);
    };

    // Helper: Capitalize first letter
    const capitalize = (str: string) => {
        if (!str) return "";
        return str.charAt(0).toUpperCase() + str.slice(1);
    };

    // Helper: Map raw category folder names to MaterialCategory type
    const mapCategory = (raw: string) => {
        const r = (raw || '').toLowerCase();
        if (r.includes('floor') || r.includes('flooring') || r.includes('yuka') || r.includes('tile')) return 'Floor';
        if (r.includes('wall') || r.includes('wallpaper') || r.includes('cloth') || r.includes('cross')) return 'Wall';
        if (r.includes('ceil') || r.includes('ceiling') || r.includes('tenjo')) return 'Ceiling';
        if (r.includes('window') || r.includes('glass') || r.includes('sash')) return 'Window';
        if (r.includes('furn') || r.includes('furniture') || r.includes('chair')) return 'Furniture';
        return 'Wall'; // Default fallback
    };

    const products = resources.map((res: any) => {
        const publicId = res.public_id || '';
        const parts = publicId.split('/');
        
        // Locate 'materials' root. 
        // Expected Structure: .../materials/Brand/Category/Series/Product
        const matIndex = parts.findIndex((p: string) => p.toLowerCase() === 'materials');
        
        if (matIndex === -1) return null; // Skip non-material assets

        // Defaults
        let brand = 'Generic';
        let rawCategory = 'Wall';
        let name = parts[parts.length - 1]; // Fallback to filename

        // Parse Structure based on requirements:
        // parts[matIndex + 1] = Brand
        // parts[matIndex + 2] = Category
        // parts[matIndex + 3] = Series
        // parts[matIndex + 4] = Product ID

        if (parts.length > matIndex + 1) {
            const rawBrand = parts[matIndex + 1];
            brand = capitalize(rawBrand); // e.g. sangetsu -> Sangetsu
        }
        
        if (parts.length > matIndex + 2) {
            rawCategory = parts[matIndex + 2];
        }

        if (parts.length > matIndex + 4) {
            const series = parts[matIndex + 3];
            const productId = parts[matIndex + 4];
            // Format: "SeriesName ProductID"
            name = `${series} ${productId}`;
        } else if (parts.length > matIndex + 3) {
            // Fallback for shallower structure: Use Product ID/Filename
            name = parts[matIndex + 3];
        }

        const category = mapCategory(rawCategory);

        // Price Inference logic
        let basePrice = 1000;
        if (category === 'Floor') basePrice = 4500;
        else if (category === 'Wall') basePrice = 1200;
        else if (category === 'Ceiling') basePrice = 800;
        else if (category === 'Furniture') basePrice = 15000;
        else if (category === 'Window') basePrice = 25000;

        // Add deterministic variance to price based on ID
        const priceVariance = (hashCode(publicId) % 20) * 100;
        const pricePerUnit = basePrice + priceVariance;

        // Optimize Texture URL
        const textureUrl = res.secure_url.replace('/upload/', '/upload/f_auto,q_auto/');

        // 実寸テクスチャ投影用メタデータ（mm）を画像仕様から導出。
        // Cloudinary search はリソースの実ピクセル幅/高さ (res.width/res.height) を返すため、
        // 「1mm=1px」「チップ=200dpi」やファイル名の識別コード(P/C/R/K)を用いて実寸を推定する。
        const physical = deriveMaterialPhysical({
          publicId,
          widthPx: typeof res.width === 'number' ? res.width : undefined,
          heightPx: typeof res.height === 'number' ? res.height : undefined,
        });

        // Infer PBR properties
        let glossiness = 'Matte';
        let roughness = 0.8;
        let metalness = 0.0;
        
        if (category === 'Floor') { glossiness = 'Satin'; roughness = 0.4; }
        else if (category === 'Window') { glossiness = 'High Polish'; roughness = 0.05; metalness = 0.2; }
        else if (category === 'Furniture') { glossiness = 'Semi-Gloss'; roughness = 0.5; }

        return {
            id: res.public_id,
            name: name, 
            brand: brand,
            category: category,
            pricePerUnit: pricePerUnit, 
            unit: '㎡',
            lossFactor: 0.15,
            textureUrl: textureUrl,
            color: '#e0e0e0',
            pbr: {
                roughness: roughness,
                metalness: metalness,
                reflectivity: 0.1,
                glossiness: glossiness,
                normalMapStrength: 0.5
            },
            promptHint: `(${brand} ${category} ${name})`,
            physical
        };
    });

    // Filter out nulls
    const validProducts = products.filter((p: any) => p !== null);

    return res.status(200).json(validProducts);

  } catch (error: any) {
    console.error("API Error in /api/materials:", error);
    return res.status(500).json({ error: "Failed to fetch materials", details: error.message });
  }
}