/**
 * Session-title resolution from the storage projection cache.
 *
 * The panel renders session ids as human-readable names. The authoritative
 * source is the disk file `session_projcache.json` that storage writes for
 * every known session — the same source the e2e suites resolve ids from.
 * Page text is never parsed: it is render output, not data.
 *
 * @module dsh-agent-bus/titles
 */

import { readFile } from 'node:fs/promises'

/**
 * Fallback shown when a session's title cannot be resolved.
 *
 * Session ids are `session-<uuid>`; slicing the raw id yields the useless
 * literal "session-", so the prefix is dropped and the short uuid fragment
 * is shown instead (e.g. `6e2cafd9`) — a dormant session stays identifiable
 * in the directory even before it ever got a title.
 */
export function fallbackTitle(sessionId: string): string {
  const short = sessionId.startsWith('session-')
    ? sessionId.slice('session-'.length)
    : sessionId
  return short.slice(0, 8)
}

/**
 * Resolve every session title from a parsed projection-cache document.
 *
 * The cache shape is `{ tables: { sessions: { [sessionId]: { rows: { title:
 * { val: string } } } } } }`. Rows whose title value is absent or not a
 * non-empty string are skipped — a session without a resolvable title simply
 * stays out of the map and callers fall back to the id prefix.
 *
 * @param document - the parsed JSON, or any other value (tolerated as empty).
 * @returns session id → title.
 */
export function resolveTitles(document: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (typeof document !== 'object' || document === null) return out
  const tables = (document as Record<string, unknown>).tables
  if (typeof tables !== 'object' || tables === null) return out
  const sessions = (tables as Record<string, unknown>).sessions
  if (typeof sessions !== 'object' || sessions === null) return out
  for (const [sessionId, entry] of Object.entries(sessions as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue
    const rows = (entry as Record<string, unknown>).rows
    if (typeof rows !== 'object' || rows === null) continue
    const title = (rows as Record<string, unknown>).title
    if (typeof title !== 'object' || title === null) continue
    const val = (title as Record<string, unknown>).val
    if (typeof val === 'string' && val !== '') out.set(sessionId, val)
  }
  return out
}

/**
 * Read the projection cache and resolve every title.
 *
 * A missing or malformed file yields an empty map — the panel falls back to
 * id prefixes rather than failing the snapshot over a display concern.
 *
 * @param path - absolute path of the projection cache.
 * @returns session id → title.
 */
export async function readTitlesFile(path: string): Promise<Map<string, string>> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return new Map()
  }
  try {
    return resolveTitles(JSON.parse(text))
  } catch {
    return new Map()
  }
}
