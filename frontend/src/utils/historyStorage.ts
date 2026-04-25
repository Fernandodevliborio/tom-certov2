/**
 * Persistent storage for detected keys (last N).
 * Uses expo-secure-store (já compilado no APK existente). Fallback p/ memória no web.
 */
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const KEY = 'tom_certo_history_v1';
const MAX_ITEMS = 50;

export interface DetectionEntry {
  key_name: string;
  root: number;
  quality: 'major' | 'minor';
  confidence: number;
  at: number;
}

let memCache: DetectionEntry[] | null = null;

async function readRaw(): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      const v = (globalThis as any).localStorage?.getItem(KEY);
      return v ?? null;
    } catch {
      return null;
    }
  }
  try {
    return await SecureStore.getItemAsync(KEY);
  } catch {
    return null;
  }
}

async function writeRaw(v: string): Promise<void> {
  if (Platform.OS === 'web') {
    try { (globalThis as any).localStorage?.setItem(KEY, v); } catch { /* noop */ }
    return;
  }
  try {
    await SecureStore.setItemAsync(KEY, v);
  } catch { /* noop */ }
}

async function deleteRaw(): Promise<void> {
  if (Platform.OS === 'web') {
    try { (globalThis as any).localStorage?.removeItem(KEY); } catch { /* noop */ }
    return;
  }
  try {
    await SecureStore.deleteItemAsync(KEY);
  } catch { /* noop */ }
}

export async function loadHistory(): Promise<DetectionEntry[]> {
  if (memCache) return memCache;
  try {
    const raw = await readRaw();
    if (!raw) { memCache = []; return memCache; }
    const parsed = JSON.parse(raw);
    memCache = Array.isArray(parsed) ? parsed : [];
    return memCache;
  } catch {
    memCache = [];
    return memCache;
  }
}

export async function pushHistory(entry: DetectionEntry): Promise<void> {
  try {
    const cur = await loadHistory();
    const last = cur[0];
    if (last && last.key_name === entry.key_name && (entry.at - last.at) < 30_000) return;
    const next = [entry, ...cur].slice(0, MAX_ITEMS);
    memCache = next;
    await writeRaw(JSON.stringify(next));
  } catch { /* swallow */ }
}

export async function clearHistory(): Promise<void> {
  try {
    memCache = [];
    await deleteRaw();
  } catch { /* swallow */ }
}
