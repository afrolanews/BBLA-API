/**
 * @file api/businesses.ts
 * @description Vercel Serverless API Route to fetch, structure, and cache a directory 
 * of businesses stored in an Airtable base.
 *
 * Key Functionality:
 * 1. Uses the official `airtable` SDK to handle authentication, auto-pagination, 
 *    and rate-limit exponential backoffs.
 * 2. Implements a lightweight in-memory cache to reduce external Airtable API calls 
 *    on warm serverless instances.
 * 3. Sets CDN headers (`Cache-Control`) to let Vercel's Edge network handle 
 *    distributed caching globally.
 * 4. Gracefully falls back to stale cache if Airtable API calls fail.
 *
 * Environment Variables Required (Vercel Settings):
 * - AIRTABLE_API_KEY (or BBLA_API_readonly): Personal Access Token (PAT) with read permissions.
 * - AIRTABLE_BASE_ID: Target Airtable Base ID (e.g., "appiMc9EgfBzk0XJz").
 * - AIRTABLE_TABLE: Target Table Name (Defaults to 'BBLA Businesses').
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import Airtable from 'airtable';

// Cache expiration threshold for in-memory caching (5 minutes)
const CACHE_DURATION_MS = 5 * 60 * 1000;

/**
 * Strong typing for the transformed business entity returned to the client.
 */
interface Business {
  id: string;
  name: string;
  mainAfroLaCategory: string;
  category: string;
  neighborhood: string;
  streetAddress: string;
  phone: string;
  email: string;
  website: string;
  instagram: string;
  facebook: string;
  media: string;
  story: string;
  description: string;
}

/**
 * Structure for our in-memory cache store.
 */
interface Cache {
  data: Business[] | null;
  timestamp: number;
}

// Global in-memory cache variable.
// Note: In serverless, this persists only across warm invocations of the SAME lambda container instance.
let cache: Cache = { data: null, timestamp: 0 };

/**
 * Initializes and configures the Airtable SDK client instance.
 * Scoped inside a function to safely validate environment variables per call.
 * 
 * @throws {Error} If required environment variables are missing.
 */
function getBase() {
  const apiKey = process.env.AIRTABLE_API_KEY ?? process.env.BBLA_API_readonly;
  const baseId = process.env.AIRTABLE_BASE_ID;

  if (!apiKey || !baseId) {
    throw new Error('Missing AIRTABLE_API_KEY (or BBLA_API_readonly) / AIRTABLE_BASE_ID env vars');
  }

  return new Airtable({ apiKey }).base(baseId);
}

/**
 * Queries Airtable to retrieve all business records, automatically handling pagination,
 * sorting, and mapping raw fields into a clean `Business` object structure.
 */
async function fetchAllBusinesses(): Promise<Business[]> {
  const base = getBase();
  const tableName = process.env.AIRTABLE_TABLE ?? 'BBLA Businesses';

  // `.select().all()` automatically iterates through all paginated records (100 per page limit in Airtable)
  const records = await base(tableName).select({
    sort: [{ field: 'Name', direction: 'asc' }],
  }).all();

  // Map raw Airtable Record objects into our standardized TypeScript interface, providing safe fallbacks
  return records.map((r) => ({
    id: r.id,
    name: (r.get('Name') as string) ?? 'Unnamed',
    mainAfroLaCategory: (r.get('Main AfroLa Category') as string) ?? 'Other',
    category: (r.get('Category') as string) ?? 'Other',
    neighborhood: (r.get('Neighborhood') as string) ?? 'NA',
    streetAddress: (r.get('Street Address') as string) ?? 'NA',
    phone: (r.get('Phone') as string) ?? 'NA',
    email: (r.get('Email') as string) ?? 'NA',
    website: (r.get('Website') as string) ?? 'NA',
    instagram: (r.get('Instagram') as string) ?? 'NA',
    facebook: (r.get('Facebook') as string) ?? 'NA',
    media: (r.get('Media') as string) ?? 'NA',
    story: (r.get('Business Story') as string) ?? 'NA',
    description: (r.get('Business Desc') as string) ?? 'NA',
  }));
}

/**
 * Main Vercel API Route Handler
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Reject non-GET methods early
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const now = Date.now();
  const isFresh = cache.data && (now - cache.timestamp < CACHE_DURATION_MS);

  // 1. Serve from in-memory cache if available and fresh
  if (isFresh && cache.data) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cache.data);
  }

  // 2. Fetch fresh data from Airtable if cache is expired or empty
  try {
    const businesses = await fetchAllBusinesses();
    
    // Update local warm-instance cache
    cache = { data: businesses, timestamp: now };
    
    // Inform the client of cache status and instruct Vercel's Edge CDN:
    // - s-maxage=300: Cache response on Vercel CDN for 5 minutes (300 seconds)
    // - stale-while-revalidate=60: Serve stale CDN cache while fetching update in the background for up to 60 seconds
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    
    return res.status(200).json(businesses);
  } catch (err) {
    // Log actual underlying error to Vercel/server logs for monitoring
    console.error('Failed to fetch records from Airtable:', err);

    // 3. Fallback: If Airtable is down/failing, serve stale in-memory data if present rather than crashing
    if (cache.data) {
      res.setHeader('X-Cache', 'STALE');
      return res.status(200).json(cache.data);
    }

    // 4. Return standard error if no cache exists to save us
    return res.status(502).json({ error: 'Failed to fetch businesses' });
  }
}