
import { Product, FurnitureType } from './types.js';

// All product data is fetched dynamically from the /api/materials endpoint.
// No static product definitions should exist here.
export const PRODUCTS: Product[] = [];

export const CATEGORY_AREAS: Record<string, number> = {
  'Floor': 42.5,
  'Wall': 118.2,
  'Ceiling': 42.5
};

export const FURNITURE_COLORS: Record<FurnitureType, string> = {
  Sofa: '#4169E1',   // Royal Blue
  Table: '#8B4513',  // Saddle Brown
  Bed: '#2E8B57',    // Sea Green
  Chair: '#DAA520',  // Golden Rod
  Shelf: '#A52A2A'   // Brown
};

export const FURNITURE_DIMS: Record<FurnitureType, [number, number, number]> = {
  Sofa: [2.0, 0.8, 0.9],
  Table: [1.6, 0.75, 0.9],
  Bed: [1.6, 0.6, 2.1],
  Chair: [0.5, 0.9, 0.5],
  Shelf: [1.0, 1.8, 0.4]
};
