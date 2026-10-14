// Helpers for reads that can outgrow a single PostgREST request.
// - pagedSelect: walks .range() pages so results aren't cut at the 1000-row cap.
// - chunks: splits id lists so .in(...) filters stay well under the URL length limit
//   (~650 UUIDs in one .in() already returns 400 Bad Request).

export const PAGE_SIZE = 1000;
const MAX_PAGES = 50;
export const ID_CHUNK = 200;

export async function pagedSelect<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
  throw new Error("pagedSelect: too many rows");
}

export function chunks<T>(values: T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}
