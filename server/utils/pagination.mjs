export function parsePagination(searchParams, { defaultLimit = 50, maxLimit = 100 } = {}) {
  const parsedLimit = Number.parseInt(searchParams.get("limit") ?? "", 10);
  const parsedCursor = Number.parseInt(searchParams.get("cursor") ?? "", 10);
  const limit = Math.min(Math.max(Number.isFinite(parsedLimit) ? parsedLimit : defaultLimit, 1), maxLimit);
  const cursor = Math.max(Number.isFinite(parsedCursor) ? parsedCursor : 0, 0);
  return { cursor, limit };
}

export function pageItems(items, cursor, limit) {
  const nextOffset = cursor + limit;
  const sliced = items.slice(cursor, nextOffset);
  return {
    items: sliced,
    page: {
      cursor,
      limit,
      total: items.length,
      nextCursor: nextOffset < items.length ? String(nextOffset) : null
    }
  };
}
