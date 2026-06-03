import { v2 as cloudinary } from 'cloudinary';
import { getFurnitureCatalog } from '../lib/furnitureCatalogService.js';

const cloudName = process.env.CLOUDINARY_CLOUD_NAME || process.env.VITE_CLOUDINARY_CLOUD_NAME;

cloudinary.config({
  cloud_name: cloudName,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (!cloudName || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    console.error('Furniture API: Cloudinary credentials missing (need CLOUDINARY_CLOUD_NAME or VITE_CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET).');
    res.status(500).json({ error: 'Server Configuration Error' });
    return;
  }
  try {
    const { items, stats } = await getFurnitureCatalog({ debug: process.env.NODE_ENV !== 'production' });
    if (process.env.NODE_ENV !== 'production') {
      res.status(200).json({ items, _debug: stats });
      return;
    }
    res.status(200).json(items);
  } catch (error) {
    console.error('Furniture API Error:', error);
    res.status(500).json({ error: 'Failed to fetch furniture' });
  }
}
