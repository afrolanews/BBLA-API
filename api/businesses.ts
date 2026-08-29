/**
 * @file api/businesses.ts
 * @description Vercel Serverless API Route to fetch, structure, and cache a directory
 * of businesses stored in an Airtable base, with linked Events & Promos expanded
 * into full objects rather than left as raw record IDs.
 
 * Key Functionality:
 * 1. Uses the official `airtable` SDK to handle authentication, auto-pagination,
 *    and rate-limit exponential backoffs.
 * 2. Fetches `BBLA Businesses` and `BBLA Events` in parallel, then joins linked
 *    Events & Promos records into each business via an in-memory lookup map.
 * 3. Implements a lightweight in-memory cache to reduce external Airtable API calls
 *    on warm serverless instances.
 * 4. Sets CDN headers (`Cache-Control`) to let Vercel's Edge network handle
 *    distributed caching globally.
 * 5. Gracefully falls back to stale cache if Airtable API calls fail.
 *
 * Environment Variables Required (Vercel Settings):
 * - AIRTABLE_API_KEY: Personal Access Token (PAT) with read permissions.
 * - AIRTABLE_BASE_ID: Target Airtable Base ID (e.g., "appiMc9EgfBzk0XJz").
 * - AIRTABLE_TABLE: Target Businesses table name (Defaults to 'BBLA Businesses').
 * - AIRTABLE_EVENTS_TABLE: Target Events table name (Defaults to 'BBLA Events').
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import Airtable from 'airtable';

// Cache expiration threshold for in-memory caching (5 minutes)
const CACHE_DURATION_MS = 5 * 60 * 1000;

/**
 * Shape of a single Airtable Attachment object, as returned for any
 * "Attachment" field type (e.g. `Media`). Airtable always returns an array
 * of these, even for a single uploaded file.
 * https://support.airtable.com/docs/attachment-field
 */
interface AirtableAttachment {
  id: string;
  url: string;
  filename: string;
  size: number;
  type: string; // MIME type, e.g. "image/jpeg"
  width?: number;
  height?: number;
  thumbnails?: {
    small: { url: string; width: number; height: number };
    large: { url: string; width: number; height: number };
    full: { url: string; width: number; height: number };
  };
}

/**
 * A fully-expanded Event or Promo record, joined in from the `BBLA Events`
 * table rather than left as a raw linked-record ID. Field names/types below
 * match the actual Airtable schema for that table.
 */
interface EventOrPromo {
  id: string;
  eventName: string;
  locationName: string | null;
  dateTime: string | null; // ISO 8601, e.g. "2014-09-05T07:00:00.000Z"
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  zipCode: number | null;
  durationSeconds: number | null;
  category: string[]; // multi-select
  details: string | null;
  price: number | null; // currency
  attendees: string[]; // multi-select
  eventEmail: string | null;
  eventLink: string | null;
}

/**
 * Strong typing for the transformed business entity returned to the client.
 * Optional single-value Airtable fields are `string | null` rather than a
 * sentinel string like "NA" — this lets consumers use normal falsy checks
 * instead of string-matching against a magic value.
 */
interface Business {
  id: string;
  name: string;
  mainAfroLaCategory: string;
  // Multi-select fields return an array of the selected option strings.
  category: string[];
  neighborhood: string[];
  streetAddress: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  instagram: string | null;
  facebook: string | null;
  // Attachment fields return an array of attachment objects, not a string.
  media: AirtableAttachment[];
  story: string | null;
  description: string | null;
  // Expanded into full objects (joined from BBLA Events) rather than left
  // as raw linked-record IDs.
  eventsAndPromos: EventOrPromo[];
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
  const apiKey = process.env.BBLA_API_readonly;
  const baseId = process.env.AIRTABLE_BASE_ID;

  if (!apiKey || !baseId) {
    throw new Error('Missing AIRTABLE_API_KEY / AIRTABLE_BASE_ID env vars');
  }

  return new Airtable({ apiKey }).base(baseId);
}

/**
 * Safely reads a single-line/long-text-style string field off an Airtable
 * record, returning `null` instead of a sentinel string when empty or the
 * wrong type. Centralizes fallback behavior in one place instead of
 * repeating `(r.get('X') as string) ?? fallback` per field.
 */
function str(record: Airtable.Record<Airtable.FieldSet>, field: string): string | null {
  const val = record.get(field);
  return typeof val === 'string' && val.length > 0 ? val : null;
}

/**
 * Safely reads a numeric field (Number, Currency, Duration, etc.), returning
 * `null` instead of `undefined`/`NaN` when empty or the wrong type.
 */
function num(record: Airtable.Record<Airtable.FieldSet>, field: string): number | null {
  const val = record.get(field);
  return typeof val === 'number' ? val : null;
}

/**
 * Safely reads a multi-select field, returning an empty array instead of
 * `null`/`undefined` when the field has no selections. Multi-select fields
 * come back from Airtable as `string[]`.
 */
function multiSelect(record: Airtable.Record<Airtable.FieldSet>, field: string): string[] {
  const val = record.get(field);
  return Array.isArray(val) ? (val as string[]) : [];
}

/**
 * Safely reads an attachment field, returning an empty array when there are
 * no files attached rather than `null`/`undefined`.
 */
function attachments(
  record: Airtable.Record<Airtable.FieldSet>,
  field: string
): AirtableAttachment[] {
  const val = record.get(field);
  return Array.isArray(val) ? (val as AirtableAttachment[]) : [];
}

/**
 * Safely reads a linked-record field, returning an empty array instead of
 * `null`/`undefined`. Linked-record fields come back from Airtable as an
 * array of record ID strings.
 */
function linkedRecordIds(record: Airtable.Record<Airtable.FieldSet>, field: string): string[] {
  const val = record.get(field);
  return Array.isArray(val) ? (val as string[]) : [];
}

/**
 * Fetches every record from `BBLA Events` and returns a lookup map keyed by
 * record ID, so business records can join in the full event/promo object
 * instead of just the raw linked ID.
 */
async function fetchEventsAndPromosMap(): Promise<Map<string, EventOrPromo>> {
  const base = getBase();
  const tableName = process.env.AIRTABLE_EVENTS_TABLE ?? 'BBLA Events';

  const records = await base(tableName).select().all();

  const map = new Map<string, EventOrPromo>();
  for (const r of records) {
    map.set(r.id, {
      id: r.id,
      eventName: str(r, 'Event name') ?? 'Untitled',
      locationName: str(r, 'Location name'),
      dateTime: str(r, 'Date and time'),
      streetAddress: str(r, 'Street address'),
      city: str(r, 'City'),
      state: str(r, 'State'),
      zipCode: num(r, 'Zip code'),
      durationSeconds: num(r, 'Duration'),
      category: multiSelect(r, 'Category'),
      details: str(r, 'Details'),
      price: num(r, 'Price'),
      attendees: multiSelect(r, 'Attendees'),
      eventEmail: str(r, 'Event email'),
      eventLink: str(r, 'Event link'),
    });
  }
  return map;
}

/**
 * Queries Airtable to retrieve all business records, automatically handling pagination,
 * sorting, and mapping raw fields into a clean `Business` object structure. Also joins
 * in fully-expanded Events & Promos objects rather than leaving raw linked-record IDs.
 */
async function fetchAllBusinesses(): Promise<Business[]> {
  const base = getBase();
  const tableName = process.env.AIRTABLE_TABLE ?? 'BBLA Businesses';

  // Fetch businesses and events in parallel — no reason to wait on one
  // before starting the other.
  const [records, eventsPromosMap] = await Promise.all([
    base(tableName)
      .select({
        sort: [{ field: 'Name', direction: 'asc' }],
      })
      .all(),
    fetchEventsAndPromosMap(),
  ]);

  // Map raw Airtable Record objects into our standardized TypeScript interface, providing safe fallbacks
  return records.map((r) => {
    const linkedIds = linkedRecordIds(r, 'Events & Promos');
    const expandedEventsAndPromos = linkedIds
      .map((id) => eventsPromosMap.get(id))
      // Drop any dangling links (e.g. the linked event was deleted in
      // Airtable but the reference on the business record wasn't cleaned up).
      .filter((item): item is EventOrPromo => item !== undefined);

    return {
      id: r.id,
      name: str(r, 'Name') ?? 'Unnamed',
      mainAfroLaCategory: str(r, 'Main AfroLA category') ?? 'Other',
      category: multiSelect(r, 'Category'),
      neighborhood: multiSelect(r, 'Neighborhood'),
      streetAddress: str(r, 'Street Address'),
      phone: str(r, 'Phone'),
      email: str(r, 'Email'),
      website: str(r, 'Website'),
      instagram: str(r, 'Instagram'),
      facebook: str(r, 'Facebook'),
      media: attachments(r, 'Media'),
      story: str(r, 'Business Story'),
      description: str(r, 'Business Desc'),
      eventsAndPromos: expandedEventsAndPromos,
    };
  });
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