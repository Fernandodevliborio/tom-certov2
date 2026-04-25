/**
 * Persistent storage for detected keys (last N).
 * Uses AsyncStorage. Schema: list of { key_name, root, quality, confidence, at }.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@tom_certo:detection_history_v1';
const MAX_ITEMS = 50;

export interface DetectionEntry {
  key_name: string;
  root: number;
  quality: 'major' | 'minor';
  confidence: number;
  at: number;
}

export async function loadHistory(): Promise<DetectionEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function pushHistory(entry: DetectionEntry): Promise<void> {
  try {
    const cur = await loadHistory();
    // Evita duplicar o mesmo tom em sequência (< 30s)
    const last = cur[0];
    if (last && last.key_name === entry.key_name && (entry.at - last.at) < 30_000) return;
    const next = [entry, ...cur].slice(0, MAX_ITEMS);
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* swallow */
  }
}

export async function clearHistory(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    /* swallow */
  }
}
