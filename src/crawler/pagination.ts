export type PageResult<P, C> = P & {
  /** Cursor that produced this page (null = first page). */
  cursor: C | null;
  index: number;
};

/**
 * Walks a paginated listing page by page, starting from a saved cursor.
 * Stops on the last page (`next` is null), after `maxPages`, on an empty page
 * (when `count` is given), and refuses to loop forever if a store keeps
 * returning the same cursor.
 */
export async function* paginate<P extends { next: C | null }, C>(
  fetchPage: (cursor: C | null) => Promise<P>,
  options: { start?: C | null; maxPages?: number; count?: (page: P) => number } = {},
): AsyncGenerator<PageResult<P, C>> {
  let cursor: C | null = options.start ?? null;
  const seen = new Set<string>();
  for (let index = 0; options.maxPages == null || index < options.maxPages; index++) {
    const key = JSON.stringify(cursor);
    if (seen.has(key)) throw new Error(`Pagination loop detected at cursor ${key}`);
    seen.add(key);

    const page = await fetchPage(cursor);
    yield { ...page, cursor, index };
    if (page.next == null || options.count?.(page) === 0) return;
    cursor = page.next;
  }
}

/** Next offset for offset/limit pagination, or null after the last page. */
export function nextOffset(
  offset: number,
  received: number,
  total: number | null | undefined,
): number | null {
  const next = offset + received;
  if (received === 0) return null;
  if (total != null && next >= total) return null;
  return next;
}
