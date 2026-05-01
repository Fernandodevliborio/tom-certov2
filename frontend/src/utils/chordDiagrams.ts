/**
 * chordDiagrams.ts — Diagramas de acordes para violão/guitarra
 * ═══════════════════════════════════════════════════════════════════════════
 * Posições dos dedos para os acordes mais comuns
 */

export interface ChordDiagram {
  positions: number[];  // -1 = não toca, 0 = corda solta, 1-12 = casa
  fingers?: number[];   // Qual dedo usa em cada corda (1-4)
  startFret: number;    // Casa inicial (para acordes com pestana)
  barre?: {
    fret: number;
    fromString: number;
    toString: number;
  };
}

// Diagramas organizados por nota raiz e qualidade
const CHORD_DIAGRAMS: Record<string, ChordDiagram> = {
  // ═══ DÓ (C) ═══
  'C_major': {
    positions: [-1, 3, 2, 0, 1, 0],
    fingers: [0, 3, 2, 0, 1, 0],
    startFret: 1,
  },
  'C_minor': {
    positions: [-1, 3, 5, 5, 4, 3],
    fingers: [0, 1, 3, 4, 2, 1],
    startFret: 3,
    barre: { fret: 3, fromString: 1, toString: 6 },
  },
  'C_dim': {
    positions: [-1, 3, 4, 2, 4, 2],
    fingers: [0, 2, 3, 1, 4, 1],
    startFret: 1,
  },

  // ═══ DÓ# / RÉb (C#/Db) ═══
  'C#_major': {
    positions: [-1, 4, 6, 6, 6, 4],
    fingers: [0, 1, 2, 3, 4, 1],
    startFret: 4,
    barre: { fret: 4, fromString: 1, toString: 6 },
  },
  'C#_minor': {
    positions: [-1, 4, 6, 6, 5, 4],
    fingers: [0, 1, 3, 4, 2, 1],
    startFret: 4,
    barre: { fret: 4, fromString: 1, toString: 6 },
  },
  'C#_dim': {
    positions: [-1, 4, 5, 3, 5, -1],
    fingers: [0, 2, 3, 1, 4, 0],
    startFret: 3,
  },

  // ═══ RÉ (D) ═══
  'D_major': {
    positions: [-1, -1, 0, 2, 3, 2],
    fingers: [0, 0, 0, 1, 3, 2],
    startFret: 1,
  },
  'D_minor': {
    positions: [-1, -1, 0, 2, 3, 1],
    fingers: [0, 0, 0, 2, 3, 1],
    startFret: 1,
  },
  'D_dim': {
    positions: [-1, -1, 0, 1, 3, 1],
    fingers: [0, 0, 0, 1, 3, 2],
    startFret: 1,
  },

  // ═══ RÉ# / MIb (D#/Eb) ═══
  'D#_major': {
    positions: [-1, 6, 8, 8, 8, 6],
    fingers: [0, 1, 2, 3, 4, 1],
    startFret: 6,
    barre: { fret: 6, fromString: 1, toString: 6 },
  },
  'D#_minor': {
    positions: [-1, 6, 8, 8, 7, 6],
    fingers: [0, 1, 3, 4, 2, 1],
    startFret: 6,
    barre: { fret: 6, fromString: 1, toString: 6 },
  },
  'D#_dim': {
    positions: [-1, -1, 1, 2, 4, 2],
    fingers: [0, 0, 1, 2, 4, 3],
    startFret: 1,
  },

  // ═══ MI (E) ═══
  'E_major': {
    positions: [0, 2, 2, 1, 0, 0],
    fingers: [0, 2, 3, 1, 0, 0],
    startFret: 1,
  },
  'E_minor': {
    positions: [0, 2, 2, 0, 0, 0],
    fingers: [0, 2, 3, 0, 0, 0],
    startFret: 1,
  },
  'E_dim': {
    positions: [0, 1, 2, 0, 2, 0],
    fingers: [0, 1, 2, 0, 3, 0],
    startFret: 1,
  },

  // ═══ FÁ (F) ═══
  'F_major': {
    positions: [1, 3, 3, 2, 1, 1],
    fingers: [1, 3, 4, 2, 1, 1],
    startFret: 1,
    barre: { fret: 1, fromString: 1, toString: 6 },
  },
  'F_minor': {
    positions: [1, 3, 3, 1, 1, 1],
    fingers: [1, 3, 4, 1, 1, 1],
    startFret: 1,
    barre: { fret: 1, fromString: 1, toString: 6 },
  },
  'F_dim': {
    positions: [1, 2, 3, 1, 3, 1],
    fingers: [1, 2, 3, 1, 4, 1],
    startFret: 1,
    barre: { fret: 1, fromString: 1, toString: 6 },
  },

  // ═══ FÁ# / SOLb (F#/Gb) ═══
  'F#_major': {
    positions: [2, 4, 4, 3, 2, 2],
    fingers: [1, 3, 4, 2, 1, 1],
    startFret: 2,
    barre: { fret: 2, fromString: 1, toString: 6 },
  },
  'F#_minor': {
    positions: [2, 4, 4, 2, 2, 2],
    fingers: [1, 3, 4, 1, 1, 1],
    startFret: 2,
    barre: { fret: 2, fromString: 1, toString: 6 },
  },
  'F#_dim': {
    positions: [2, 3, 4, 2, 4, 2],
    fingers: [1, 2, 3, 1, 4, 1],
    startFret: 2,
    barre: { fret: 2, fromString: 1, toString: 6 },
  },

  // ═══ SOL (G) ═══
  'G_major': {
    positions: [3, 2, 0, 0, 0, 3],
    fingers: [2, 1, 0, 0, 0, 3],
    startFret: 1,
  },
  'G_minor': {
    positions: [3, 5, 5, 3, 3, 3],
    fingers: [1, 3, 4, 1, 1, 1],
    startFret: 3,
    barre: { fret: 3, fromString: 1, toString: 6 },
  },
  'G_dim': {
    positions: [3, 4, 5, 3, 5, 3],
    fingers: [1, 2, 3, 1, 4, 1],
    startFret: 3,
    barre: { fret: 3, fromString: 1, toString: 6 },
  },

  // ═══ SOL# / LÁb (G#/Ab) ═══
  'G#_major': {
    positions: [4, 6, 6, 5, 4, 4],
    fingers: [1, 3, 4, 2, 1, 1],
    startFret: 4,
    barre: { fret: 4, fromString: 1, toString: 6 },
  },
  'G#_minor': {
    positions: [4, 6, 6, 4, 4, 4],
    fingers: [1, 3, 4, 1, 1, 1],
    startFret: 4,
    barre: { fret: 4, fromString: 1, toString: 6 },
  },
  'G#_dim': {
    positions: [4, 5, 6, 4, 6, 4],
    fingers: [1, 2, 3, 1, 4, 1],
    startFret: 4,
    barre: { fret: 4, fromString: 1, toString: 6 },
  },

  // ═══ LÁ (A) ═══
  'A_major': {
    positions: [-1, 0, 2, 2, 2, 0],
    fingers: [0, 0, 1, 2, 3, 0],
    startFret: 1,
  },
  'A_minor': {
    positions: [-1, 0, 2, 2, 1, 0],
    fingers: [0, 0, 2, 3, 1, 0],
    startFret: 1,
  },
  'A_dim': {
    positions: [-1, 0, 1, 2, 1, 2],
    fingers: [0, 0, 1, 3, 2, 4],
    startFret: 1,
  },

  // ═══ LÁ# / SIb (A#/Bb) ═══
  'A#_major': {
    positions: [-1, 1, 3, 3, 3, 1],
    fingers: [0, 1, 2, 3, 4, 1],
    startFret: 1,
    barre: { fret: 1, fromString: 1, toString: 5 },
  },
  'A#_minor': {
    positions: [-1, 1, 3, 3, 2, 1],
    fingers: [0, 1, 3, 4, 2, 1],
    startFret: 1,
    barre: { fret: 1, fromString: 1, toString: 5 },
  },
  'A#_dim': {
    positions: [-1, 1, 2, 3, 2, -1],
    fingers: [0, 1, 2, 4, 3, 0],
    startFret: 1,
  },

  // ═══ SI (B) ═══
  'B_major': {
    positions: [-1, 2, 4, 4, 4, 2],
    fingers: [0, 1, 2, 3, 4, 1],
    startFret: 2,
    barre: { fret: 2, fromString: 1, toString: 5 },
  },
  'B_minor': {
    positions: [-1, 2, 4, 4, 3, 2],
    fingers: [0, 1, 3, 4, 2, 1],
    startFret: 2,
    barre: { fret: 2, fromString: 1, toString: 5 },
  },
  'B_dim': {
    positions: [-1, 2, 3, 4, 3, -1],
    fingers: [0, 1, 2, 4, 3, 0],
    startFret: 2,
  },
};

// Mapeamento de pitch class para nome da nota
const PC_TO_NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Obtém o diagrama de um acorde
 */
export function getChordDiagram(
  root: number, 
  quality: 'major' | 'minor' | 'dim'
): ChordDiagram | null {
  const noteName = PC_TO_NOTE[root];
  const key = `${noteName}_${quality}`;
  return CHORD_DIAGRAMS[key] || null;
}

/**
 * Lista todos os acordes disponíveis
 */
export function getAvailableChords(): string[] {
  return Object.keys(CHORD_DIAGRAMS);
}
