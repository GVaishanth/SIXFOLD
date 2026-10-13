import { SAVE_CONFIG } from '@/config/gameConfig';
import { SAVE_SLOT_COUNT } from '@/types';
import type { ElementId, SaveData, SaveFile, SaveSlotMeta, SettingsState } from '@/types';
import {
  DEFAULT_SETTINGS,
  SAVE_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  defaultSaveData,
  emptySaveFile,
  slotMeta,
  validateSaveData,
  validateSaveFile,
  validateSettings,
} from '@/utils/saveSchema';
import { readJson, removeKey, writeJson } from '@/utils/storage';

/**
 * Save service — the only module that touches localStorage for game progress.
 *
 * Everything is wrapped defensively: a corrupt payload is backed up, replaced
 * with a safe default and reported, but never thrown at the UI.
 */

export interface LoadReport {
  file: SaveFile;
  repaired: boolean;
  error?: string;
}

const memoryFallback: { file: SaveFile | null; settings: SettingsState | null } = {
  file: null,
  settings: null,
};

export function loadSaveFile(): LoadReport {
  const result = readJson<unknown>(SAVE_STORAGE_KEY);

  // 1. A payload exists and can be parsed: validate, repair and keep it.
  if (result.ok && result.value) {
    const { file, repaired } = validateSaveFile(result.value);
    if (repaired) {
      // Keep a copy of the broken payload for debugging before overwriting.
      writeJson(`${SAVE_STORAGE_KEY}.broken`, result.value, SAVE_CONFIG.maxBytes);
      persistSaveFile(file);
    }
    return { file, repaired };
  }

  // 2. The payload is unparsable: preserve it verbatim so a bug report can
  //    still be diagnosed, then fall through to a rebuild.
  if (!result.ok) {
    const raw = readRaw(SAVE_STORAGE_KEY);
    if (raw !== null) writeRaw(`${SAVE_STORAGE_KEY}.broken`, raw);
  }

  // 3. A save written by an older version is migrated forward, never lost.
  for (const legacy of SAVE_CONFIG.legacyKeys) {
    const legacyResult = readJson<unknown>(legacy);
    if (legacyResult.ok && legacyResult.value) {
      const { file, repaired } = validateSaveFile(legacyResult.value);
      persistSaveFile(file);
      return { file, repaired, error: `migrated from ${legacy}` };
    }
  }

  // 4. Storage was genuinely empty — that is not a repair, just a first run.
  if (result.ok) {
    return { file: emptySaveFile(), repaired: false };
  }

  // 5. Corrupt storage with nothing to migrate: replace it with a valid file so
  //    the key is always parseable from here on.
  const fresh = memoryFallback.file ?? emptySaveFile();
  persistSaveFile(fresh);
  return { file: fresh, repaired: true, error: result.error };
}

/** Raw localStorage read that never throws (used only for corrupt payloads). */
function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Raw localStorage write that never throws. */
function writeRaw(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — nothing useful to do */
  }
}

export function persistSaveFile(file: SaveFile): boolean {
  memoryFallback.file = file;
  const result = writeJson(SAVE_STORAGE_KEY, file, SAVE_CONFIG.maxBytes);
  if (!result.ok) {
    console.warn('[sixfold] save write failed:', result.error);
  }
  return result.ok;
}

export function getSlotMetas(file: SaveFile): SaveSlotMeta[] {
  return Array.from({ length: SAVE_SLOT_COUNT }, (_, index) => {
    const data = file.slots[index] ?? null;
    return slotMeta(index, data, false);
  });
}

export function createSaveSlot(
  file: SaveFile,
  slot: number,
  name: string,
  starter: ElementId,
): { file: SaveFile; data: SaveData } {
  const data = defaultSaveData(slot, name, starter);
  const slots = [...file.slots];
  slots[slot] = data;
  const next: SaveFile = { ...file, slots, lastSlot: slot };
  persistSaveFile(next);
  return { file: next, data };
}

export function deleteSaveSlot(file: SaveFile, slot: number): SaveFile {
  const slots = [...file.slots];
  slots[slot] = null;
  const next: SaveFile = { ...file, slots };
  persistSaveFile(next);
  return next;
}

export function writeSlot(file: SaveFile, data: SaveData): SaveFile {
  const slots = [...file.slots];
  slots[data.slot] = data;
  const next: SaveFile = { ...file, slots, lastSlot: data.slot };
  persistSaveFile(next);
  return next;
}

/** Read a single slot directly from storage (used by the Free Mode loader). */
export function readSlot(slot: number): SaveData | null {
  const { file } = loadSaveFile();
  const raw = file.slots[slot] ?? null;
  if (!raw) return null;
  return validateSaveData(raw, slot).data;
}

export function clearAllSaves(): void {
  removeKey(SAVE_STORAGE_KEY);
  for (const legacy of SAVE_CONFIG.legacyKeys) removeKey(legacy);
  memoryFallback.file = null;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export function loadSettings(): SettingsState {
  const result = readJson<unknown>(SETTINGS_STORAGE_KEY);
  if (!result.ok || !result.value) {
    return memoryFallback.settings ?? { ...DEFAULT_SETTINGS };
  }
  const settings = validateSettings(result.value);
  memoryFallback.settings = settings;
  return settings;
}

export function persistSettings(settings: SettingsState): void {
  memoryFallback.settings = settings;
  const result = writeJson(SETTINGS_STORAGE_KEY, settings, 20_000);
  if (!result.ok) console.warn('[sixfold] settings write failed:', result.error);
}

export { DEFAULT_SETTINGS };
