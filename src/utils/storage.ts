/**
 * localStorage helpers that never throw.
 *
 * Every read/write is wrapped so a hostile or disabled storage backend (private
 * browsing, quota exceeded, corrupted JSON) degrades gracefully instead of
 * taking the whole game down.
 */

export interface StorageResult<T> {
  ok: boolean;
  value: T | null;
  error?: string;
}

export function isStorageAvailable(): boolean {
  try {
    const probe = '__sixfold_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

export function readJson<T>(key: string): StorageResult<T> {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return { ok: true, value: null };
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (error) {
    return { ok: false, value: null, error: error instanceof Error ? error.message : 'unknown' };
  }
}

export function writeJson(key: string, value: unknown, maxBytes = Infinity): StorageResult<null> {
  let payload: string;
  try {
    payload = JSON.stringify(value);
  } catch (error) {
    return { ok: false, value: null, error: error instanceof Error ? error.message : 'serialise failed' };
  }
  if (payload.length > maxBytes) {
    return { ok: false, value: null, error: 'payload-too-large' };
  }
  try {
    window.localStorage.setItem(key, payload);
    return { ok: true, value: null };
  } catch (error) {
    return { ok: false, value: null, error: error instanceof Error ? error.message : 'write failed' };
  }
}

export function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore — nothing useful to do if storage is unavailable */
  }
}
