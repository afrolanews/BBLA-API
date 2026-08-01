// api/businesses.ts
//
// Uses the official `airtable` SDK (as shown in Airtable's docs) instead of
// raw fetch — handles auth, pagination, and rate-limit backoff for us.
//
// Env vars to set in Vercel (Project → Settings → Environment Variables):
//   AIRTABLE_API_KEY   — read-only PAT, scoped to this base only
//   AIRTABLE_BASE_ID   — e.g. "appiMc9EgfBzk0XJz"
//   AIRTABLE_TABLE     — e.g. "Businesses"

import type { VercelRequest, VercelResponse } from '@vercel/node';
import Airtable from 'airtable';

const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

interface Business {
  id: string;
  name: string;
  mainAfroLaCategory: string;
  category: string;
  neighborhood: string;
  streetAddress: string;
  Phone: string;
  email: string;
  website: string;
  instagram: string;
  facebook: string;
  media: string;
  story: string;
}

interface Cache {
  data: Business[] | null;
  timestamp: number;
}

// In-memory cache. Resets on cold start — acceptable here since a miss just
// costs one extra Airtable call, not a broken response.
let cache: Cache = { data: null, timestamp: 0 };

function getBase() {
  const apiKey = process.env.BBLA_API_readonly;
  const baseId = process.env.AIRTABLE_BASE_ID

  if (!apiKey || !baseId) {
    throw new Error('Missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID env vars');
  }

  // Equivalent to the docs' `Airtable.configure(...)` + `.base(...)`,
  // just scoped to this function call rather than a module-level singleton.
  return new Airtable({ apiKey }).base(baseId);
}

async function fetchAllBusinesses(): Promise<Business[]> {
  const base = getBase();
  const tableName = process.env.AIRTABLE_TABLE ?? 'Businesses';

  const records = await base(tableName).select().all(); // SDK handles pagination internally

  return records.map((r) => ({
    id: r.id,
    name: (r.get('Name') as string) ?? 'Unnamed',
    mainAfroLaCategory: (r.get('Main AfroLa Category') as string) ?? 'Other',
    category: (r.get('Category') as string) ?? 'Other',
    neighborhood: (r.get('Neighborhood') as string) ?? 'NA',
    streetAddress: (r.get('Street Address') as string) ?? 'NA',
    Phone: (r.get('Phone') as string) ?? 'NA',
    email: (r.get('Email') as string) ?? 'NA',
    website: (r.get('Website') as string) ?? 'NA',
    instagram: (r.get('Instagram') as string) ?? 'NA',
    facebook: (r.get('Facebook') as string) ?? 'NA',
    media: (r.get('Media') as string) ?? 'NA',
    story: (r.get('Story') as string) ?? 'NA',
  }));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const now = Date.now();
  const isFresh = cache.data && now - cache.timestamp < CACHE_DURATION_MS;

  if (isFresh && cache.data) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cache.data);
  }

  try {
    const businesses = await fetchAllBusinesses();
    cache = { data: businesses, timestamp: now };
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json(businesses);
  } catch (err) {
    // Serve stale cache rather than failing outright, if we have any
    if (cache.data) {
      res.setHeader('X-Cache', 'STALE');
      return res.status(200).json(cache.data);
    }
    console.error(err);
    return res.status(502).json({ error: 'Failed to fetch businesses' });
  }
}