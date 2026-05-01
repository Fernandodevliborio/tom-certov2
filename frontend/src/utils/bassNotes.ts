/**
 * bassNotes.ts — Notas de acordes para baixo
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface BassNote {
  root: number;   // Nota raiz
  fifth: number;  // Quinta
  octave: number; // Oitava (mesma nota que raiz)
}

/**
 * Retorna as notas de um acorde para baixo (raiz, quinta, oitava)
 */
export function getBassNotes(
  root: number, 
  quality: 'major' | 'minor' | 'dim'
): BassNote {
  // Para baixo, usamos: raiz, quinta (ou quinta diminuta para dim), oitava
  const fifthInterval = quality === 'dim' ? 6 : 7; // 5ª justa ou diminuta
  
  return {
    root: root,
    fifth: (root + fifthInterval) % 12,
    octave: root, // Mesma nota, uma oitava acima
  };
}

/**
 * Retorna padrão de linha de baixo sugerido
 */
export function getBassPattern(
  root: number, 
  quality: 'major' | 'minor' | 'dim'
): number[] {
  const notes = getBassNotes(root, quality);
  
  // Padrão básico: raiz → quinta → oitava → quinta
  return [notes.root, notes.fifth, notes.octave, notes.fifth];
}

/**
 * Retorna padrão de walking bass (mais elaborado)
 */
export function getWalkingBassPattern(
  root: number, 
  quality: 'major' | 'minor' | 'dim'
): number[] {
  const third = quality === 'major' ? (root + 4) % 12 : (root + 3) % 12;
  const fifth = quality === 'dim' ? (root + 6) % 12 : (root + 7) % 12;
  
  // Walking: raiz → terça → quinta → terça
  return [root, third, fifth, third];
}
