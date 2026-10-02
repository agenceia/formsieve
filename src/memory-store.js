/** Bounded, atomic within ONE JS process only. Use a shared atomic store on clusters. */
export function memoryStore({ maxEntries = 10000, now = Date.now } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('Invalid store capacity');
  const entries = new Map();
  function get(key, ttlMs) {
    const time = now();
    for (const [key, value] of entries) if (value.expires <= time) entries.delete(key);
    let entry = entries.get(key);
    if (!entry) {
      // Fail closed instead of evicting live limits under attack.
      if (entries.size >= maxEntries) throw new Error('Store capacity exceeded');
      entry = { count: 0, expires: time + ttlMs };
      entries.set(key, entry);
    }
    return entry;
  }
  return {
    async consume(key, limit, windowMs) {
      const entry = get(key, windowMs);
      if (entry.count >= limit) return false;
      entry.count++;
      return true;
    },
    async claim(key, ttlMs) {
      const entry = get(key, ttlMs);
      if (entry.count) return false;
      entry.count = 1;
      return true;
    },
  };
}
