import { cloudinary } from './cloudinary.js';
import { Product, MaterialCategory } from '../types.js';

// Helper to map folder names to MaterialCategory
const mapCategory = (raw: string): MaterialCategory => {
  const r = raw.toLowerCase();
  if (r.includes('floor')) return 'Floor';
  if (r.includes('ceil')) return 'Ceiling';
  if (r.includes('window')) return 'Window';
  if (r.includes('furniture')) return 'Furniture';
  return 'Wall';
};

// In-memory cache to avoid rate limits
let materialCache: Product[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

export async function getMaterialData(): Promise<Product[]> {
  const now = Date.now();
  if (materialCache && (now - lastFetchTime < CACHE_TTL)) {
    return materialCache;
  }

  try {
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      console.error("Cloudinary credentials missing.");
      return [];
    }

    const result = await cloudinary.api.resources({
      type: 'upload',
      prefix: 'materials/',
      max_results: 500,
      context: true
    });
    
    const products: Product[] = result.resources.map((res: any) => {
        const parts = res.public_id.split('/');
        const manufacturer = parts.length > 1 ? parts[1] : 'Unknown Brand';
        const rawCategory = parts.length > 2 ? parts[2] : 'Wall';
        const productId = parts.length > 3 ? parts[3] : res.public_id.split('/').pop();
        const category = mapCategory(rawCategory);
        
        const textureUrl = res.secure_url.replace('/upload/', '/upload/f_auto,q_auto/');
        
        // Extract PBR metadata from Cloudinary Context
        const ctx = res.context?.custom || {};
        
        return {
            id: res.public_id,
            name: ctx.name || productId, 
            brand: ctx.brand || manufacturer,
            category,
            pricePerUnit: parseFloat(ctx.price) || 5000,
            unit: ctx.unit || '㎡',
            lossFactor: parseFloat(ctx.lossFactor) || 0.1,
            textureUrl: textureUrl,
            color: ctx.color || '#e0e0e0',
            pbr: {
                roughness: parseFloat(ctx.roughness) ?? 0.6,
                metalness: parseFloat(ctx.metalness) ?? 0.1,
                reflectivity: parseFloat(ctx.reflectivity) ?? 0.1,
                glossiness: ctx.glossiness || 'Matte',
                normalMapStrength: parseFloat(ctx.normalMapStrength) ?? 0.5
            },
            promptHint: ctx.promptHint || `(${category} texture, ${manufacturer}, ${productId})`
        };
    });

    materialCache = products;
    lastFetchTime = now;
    return products;
  } catch (error) {
    console.error("Failed to fetch Cloudinary materials:", error);
    return materialCache || [];
  }
}
