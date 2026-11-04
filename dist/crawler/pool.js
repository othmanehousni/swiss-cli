/** Runs `worker` over `items` with at most `concurrency` in flight. Workers should not throw. */
export async function runPool(items, concurrency, worker) {
    let next = 0;
    const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
        while (next < items.length) {
            const item = items[next++];
            await worker(item);
        }
    });
    await Promise.all(lanes);
}
