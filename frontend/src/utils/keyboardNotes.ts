/**
 * keyboardNotes.ts — Notas de acordes para teclado
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface KeyboardNote {
  pitchClass: number;
  isRoot: boolean;
  label: string;
}

/**
 * Retorna as notas de um acorde para teclado
 */
export function getKeyboardNotes(
  root: number, 
  quality: 'major' | 'minor' | 'dim'
): KeyboardNote[] {
  // Intervalos: Maior = [0, 4, 7], Menor = [0, 3, 7], Dim = [0, 3, 6]
  const intervals = quality === 'major' ? [0, 4, 7] 
    : quality === 'minor' ? [0, 3, 7] 
    : [0, 3, 6];
  
  const NOTES = ['Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si'];
  
  return intervals.map((interval, i) => {
    const pc = (root + interval) % 12;
    return {
      pitchClass: pc,
      isRoot: i === 0,
      label: NOTES[pc],
    };
  });
}

/**
 * Retorna as notas do acorde como array de pitch classes
 */
export function getChordPitchClasses(
  root: number, 
  quality: 'major' | 'minor' | 'dim'
): number[] {
  const intervals = quality === 'major' ? [0, 4, 7] 
    : quality === 'minor' ? [0, 3, 7] 
    : [0, 3, 6];
  
  return intervals.map(i => (root + i) % 12);
}
