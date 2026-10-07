/** Runs `worker` over `items` with at most `concurrency` in flight. Workers should not throw. */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (next < items.length) {
        const item = items[next++] as T;
        await worker(item);
      }
    },
  );
  await Promise.all(lanes);
}
