// api/businesses.js
// Deploy on Vercel. Set these as Environment Variables in your Vercel project
// (never commit them to source):
//   AIRTABLE_BASE_ID
//   BBLA_API_readonly        (read-only PAT, scoped to this base)
//   AIRTABLE_TABLE        (e.g. "Businesses")

const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// In-memory cache. Resets on cold start — fine for this use case since a
// re-fetch just means one extra Airtable call, not a broken app.
let cache = { data: null, timestamp: 0 };


async function fetchAllFromAirtable() {
  const { AIRTABLE_BASE_ID, BBLA_API_readonly, AIRTABLE_TABLE } = process.env;
  let records = [];
  let offset;

  do {
    const url = new URL(
      `https://api.airtable.com/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE}`
    );
    if (offset) url.searchParams.set('offset', offset);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });

    if (!res.ok) {
      throw new Error(`Airtable error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    records = records.concat(data.records);
    offset = data.offset;
  } while (offset);

  return records.map((r) => ({
    id: r.id,
    name: r.fields.Name ?? 'Unnamed',
    category: r.fields.Category ?? 'Other',
    location: r.fields.Location ?? 'Online',
    rating: r.fields.Rating ?? null,
    hasPromo: !!r.fields.HasPromo,
  }));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const now = Date.now();
  const isFresh = cache.data && now - cache.timestamp < CACHE_DURATION_MS;

  if (isFresh) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cache.data);
  }

  try {
    const businesses = await fetchAllFromAirtable();
    cache = { data: businesses, timestamp: now };
    res.setHeader('X-Cache', 'MISS');
    // Also let any CDN/edge caching (e.g. Vercel's) cache this response
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json(businesses);
  } catch (err) {
    // Serve stale cache rather than nothing, if we have it
    if (cache.data) {
      res.setHeader('X-Cache', 'STALE');
      return res.status(200).json(cache.data);
    }
    console.error(err);
    return res.status(502).json({ error: 'Failed to fetch businesses' });
  }
}
