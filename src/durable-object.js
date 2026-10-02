import { DurableObject } from 'cloudflare:workers';

/** One object per hashed rate/duplicate key, containing only a counter and expiry. */
export class FormSieveStore extends DurableObject {
  async consume(limit, ttlMs) {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86400000) throw new TypeError('Invalid counter policy');
    return this.ctx.storage.transaction(async txn => {
      const now = Date.now();
      let state = await txn.get('counter');
      if (!state || state.expires <= now) state = { count: 0, expires: now + ttlMs };
      if (state.count >= limit) return false;
      state.count++;
      await txn.put('counter', state);
      await txn.setAlarm(state.expires);
      return true;
    });
  }
  async alarm() {
    await this.ctx.storage.transaction(async txn => {
      const state = await txn.get('counter');
      if (!state || state.expires <= Date.now()) await txn.delete('counter');
      else await txn.setAlarm(state.expires);
    });
  }
}
