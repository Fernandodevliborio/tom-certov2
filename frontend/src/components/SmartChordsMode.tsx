/**
 * SmartChordsMode.tsx — Modo Acordes Inteligentes
 * ═══════════════════════════════════════════════════════════════════════════
 * Exibe acordes contextualizados do campo harmônico detectado.
 * Suporta: Violão, Guitarra, Teclado, Baixo
 */

import React, { useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NOTES_BR, NOTES_INTL, getHarmonicField, HarmonicChord } from '../utils/noteUtils';
import { getChordDiagram, ChordDiagram } from '../utils/chordDiagrams';
import { getKeyboardNotes, KeyboardNote } from '../utils/keyboardNotes';
import { getBassNotes, BassNote } from '../utils/bassNotes';

const { width: SW } = Dimensions.get('window');

// Cores do tema
const C = {
  bg: '#050508',
  surface: '#0D0D12',
  surfaceLight: '#16161D',
  border: '#1E1E28',
  amber: '#FFB020',
  amberLight: '#FFCC66',
  amberMuted: 'rgba(255,176,32,0.15)',
  white: '#FFFFFF',
  text2: '#9CA3AF',
  text3: '#4B5563',
  green: '#10B981',
  greenMuted: 'rgba(16,185,129,0.15)',
  blue: '#3B82F6',
  blueMuted: 'rgba(59,130,246,0.15)',
  purple: '#8B5CF6',
  red: '#EF4444',
};

// Tipos de instrumento
export type InstrumentType = 'violao' | 'guitarra' | 'teclado' | 'baixo';

const INSTRUMENTS: { id: InstrumentType; label: string; icon: string; emoji: string }[] = [
  { id: 'violao', label: 'Violão', icon: 'musical-notes', emoji: '🎸' },
  { id: 'guitarra', label: 'Guitarra', icon: 'flash', emoji: '🎸' },
  { id: 'teclado', label: 'Teclado', icon: 'apps', emoji: '🎹' },
  { id: 'baixo', label: 'Baixo', icon: 'radio', emoji: '🎸' },
];

// Graus harmônicos
const MAJOR_DEGREES = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];
const MINOR_DEGREES = ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'];

// Funções harmônicas explicadas
const HARMONIC_FUNCTIONS: Record<string, { role: string; color: string; description: string }> = {
  'I': { role: 'TÔNICA', color: C.green, description: 'Centro de repouso — onde a música "descansa"' },
  'i': { role: 'TÔNICA', color: C.green, description: 'Centro de repouso — onde a música "descansa"' },
  'ii': { role: 'PRÉ-DOMINANTE', color: C.blue, description: 'Prepara a dominante — cria tensão suave' },
  'ii°': { role: 'PRÉ-DOMINANTE', color: C.blue, description: 'Prepara a dominante — cria tensão suave' },
  'iii': { role: 'MEDIANTE', color: C.purple, description: 'Ponte entre tônica e subdominante' },
  'III': { role: 'MEDIANTE', color: C.purple, description: 'Relativo maior — cor harmônica' },
  'IV': { role: 'SUBDOMINANTE', color: C.amber, description: 'Afastamento suave da tônica' },
  'iv': { role: 'SUBDOMINANTE', color: C.amber, description: 'Afastamento suave da tônica' },
  'V': { role: 'DOMINANTE', color: C.red, description: 'Máxima tensão — quer resolver para I' },
  'v': { role: 'DOMINANTE', color: C.red, description: 'Tensão moderada — menor dramático' },
  'vi': { role: 'SUBMEDIANTE', color: C.purple, description: 'Relativo menor — cor melancólica' },
  'VI': { role: 'SUBMEDIANTE', color: C.purple, description: 'Ponto de luz na escala menor' },
  'vii°': { role: 'SENSÍVEL', color: C.red, description: 'Tensão extrema — resolve para I' },
  'VII': { role: 'SUBTÔNICA', color: C.amber, description: 'Um tom abaixo da tônica' },
};

interface Props {
  tonic: number;
  quality: 'major' | 'minor';
  currentNote?: number | null;  // Nota sendo cantada/tocada agora
  onClose?: () => void;
}

export default function SmartChordsMode({ tonic, quality, currentNote, onClose }: Props) {
  const [instrument, setInstrument] = useState<InstrumentType>('violao');
  const [selectedChordIndex, setSelectedChordIndex] = useState<number>(0);

  // Campo harmônico
  const harmonicField = useMemo(
    () => getHarmonicField(tonic, quality),
    [tonic, quality]
  );

  const degrees = quality === 'major' ? MAJOR_DEGREES : MINOR_DEGREES;

  // Acorde selecionado
  const selectedChord = harmonicField[selectedChordIndex];
  const selectedDegree = degrees[selectedChordIndex];
  const harmonicFunc = HARMONIC_FUNCTIONS[selectedDegree] || {
    role: 'ACORDE',
    color: C.text2,
    description: 'Parte do campo harmônico',
  };

  // Detectar qual acorde está sendo tocado (baseado na nota atual)
  const activeChordIndex = useMemo(() => {
    if (currentNote === null || currentNote === undefined) return null;
    const idx = harmonicField.findIndex(c => c.root === currentNote);
    return idx >= 0 ? idx : null;
  }, [currentNote, harmonicField]);

  return (
    <View style={ss.container}>
      {/* Header */}
      <View style={ss.header}>
        <View style={ss.headerLeft}>
          <Text style={ss.headerTitle}>Acordes Inteligentes</Text>
          <Text style={ss.headerSub}>
            Campo de {NOTES_BR[tonic]} {quality === 'major' ? 'maior' : 'menor'}
          </Text>
        </View>
        {onClose && (
          <TouchableOpacity style={ss.closeBtn} onPress={onClose}>
            <Ionicons name="close" size={20} color={C.text2} />
          </TouchableOpacity>
        )}
      </View>

      {/* Seletor de Instrumento */}
      <View style={ss.instrumentBar}>
        {INSTRUMENTS.map(inst => (
          <TouchableOpacity
            key={inst.id}
            style={[ss.instrumentBtn, instrument === inst.id && ss.instrumentBtnActive]}
            onPress={() => setInstrument(inst.id)}
          >
            <Text style={ss.instrumentEmoji}>{inst.emoji}</Text>
            <Text style={[ss.instrumentLabel, instrument === inst.id && ss.instrumentLabelActive]}>
              {inst.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Grade de Acordes */}
      <ScrollView 
        horizontal 
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={ss.chordGridScroll}
      >
        {harmonicField.map((chord, i) => {
          const isSelected = i === selectedChordIndex;
          const isActive = i === activeChordIndex;
          const degree = degrees[i];
          const func = HARMONIC_FUNCTIONS[degree];

          return (
            <TouchableOpacity
              key={i}
              style={[
                ss.chordCard,
                isSelected && ss.chordCardSelected,
                isActive && ss.chordCardActive,
                chord.isTonic && ss.chordCardTonic,
              ]}
              onPress={() => setSelectedChordIndex(i)}
              activeOpacity={0.7}
            >
              <Text style={[ss.chordDegree, { color: func?.color || C.text2 }]}>
                {degree}
              </Text>
              <Text style={[ss.chordName, isSelected && ss.chordNameSelected]}>
                {chord.label}
              </Text>
              <Text style={ss.chordIntl}>
                {NOTES_INTL[chord.root]}{chord.quality === 'minor' ? 'm' : chord.quality === 'dim' ? '°' : ''}
              </Text>
              {isActive && (
                <View style={ss.activeIndicator}>
                  <Text style={ss.activeIndicatorText}>♪</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Visualização do Acorde Selecionado */}
      <View style={ss.chordDetail}>
        <View style={ss.chordDetailHeader}>
          <View>
            <Text style={ss.chordDetailName}>{selectedChord.label}</Text>
            <Text style={ss.chordDetailIntl}>
              ({NOTES_INTL[selectedChord.root]}{selectedChord.quality === 'minor' ? 'm' : selectedChord.quality === 'dim' ? 'dim' : ''})
            </Text>
          </View>
          <View style={[ss.functionBadge, { backgroundColor: harmonicFunc.color + '22', borderColor: harmonicFunc.color + '44' }]}>
            <Text style={[ss.functionBadgeText, { color: harmonicFunc.color }]}>
              {harmonicFunc.role}
            </Text>
          </View>
        </View>

        <Text style={ss.functionDesc}>{harmonicFunc.description}</Text>

        {/* Visualização específica do instrumento */}
        <View style={ss.diagramContainer}>
          {(instrument === 'violao' || instrument === 'guitarra') && (
            <GuitarDiagram chord={selectedChord} />
          )}
          {instrument === 'teclado' && (
            <KeyboardDiagram chord={selectedChord} />
          )}
          {instrument === 'baixo' && (
            <BassDiagram chord={selectedChord} />
          )}
        </View>
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DIAGRAMA DE VIOLÃO/GUITARRA
// ═══════════════════════════════════════════════════════════════════════════

function GuitarDiagram({ chord }: { chord: HarmonicChord }) {
  const diagram = getChordDiagram(chord.root, chord.quality);

  if (!diagram) {
    return (
      <View style={ss.diagramPlaceholder}>
        <Text style={ss.diagramPlaceholderText}>Diagrama não disponível</Text>
      </View>
    );
  }

  const FRET_COUNT = 5;
  const STRING_COUNT = 6;
  const FRET_HEIGHT = 28;
  const STRING_SPACING = 28;
  const DIAGRAM_WIDTH = STRING_SPACING * (STRING_COUNT - 1) + 40;
  const DIAGRAM_HEIGHT = FRET_HEIGHT * FRET_COUNT + 50;

  return (
    <View style={ss.guitarDiagram}>
      <View style={[ss.guitarNeck, { width: DIAGRAM_WIDTH, height: DIAGRAM_HEIGHT }]}>
        {/* Número da casa inicial */}
        {diagram.startFret > 1 && (
          <Text style={ss.fretNumber}>{diagram.startFret}ª</Text>
        )}

        {/* Cordas (linhas verticais) */}
        {Array.from({ length: STRING_COUNT }).map((_, i) => (
          <View
            key={`string-${i}`}
            style={[
              ss.guitarString,
              {
                left: 20 + i * STRING_SPACING,
                height: FRET_HEIGHT * FRET_COUNT,
                top: 30,
              },
            ]}
          />
        ))}

        {/* Trastes (linhas horizontais) */}
        {Array.from({ length: FRET_COUNT + 1 }).map((_, i) => (
          <View
            key={`fret-${i}`}
            style={[
              ss.guitarFret,
              {
                top: 30 + i * FRET_HEIGHT,
                left: 18,
                width: DIAGRAM_WIDTH - 36,
              },
              i === 0 && ss.guitarNut,
            ]}
          />
        ))}

        {/* Posições dos dedos */}
        {diagram.positions.map((pos, i) => {
          if (pos === -1) {
            // Corda não tocada (X)
            return (
              <Text
                key={`pos-${i}`}
                style={[ss.guitarMuted, { left: 14 + i * STRING_SPACING }]}
              >
                ✕
              </Text>
            );
          }
          if (pos === 0) {
            // Corda solta (O)
            return (
              <View
                key={`pos-${i}`}
                style={[ss.guitarOpen, { left: 14 + i * STRING_SPACING }]}
              />
            );
          }
          // Dedo na casa
          const fretPos = pos - (diagram.startFret > 1 ? diagram.startFret - 1 : 0);
          return (
            <View
              key={`pos-${i}`}
              style={[
                ss.guitarFinger,
                {
                  left: 12 + i * STRING_SPACING,
                  top: 30 + (fretPos - 0.5) * FRET_HEIGHT - 8,
                },
              ]}
            >
              <Text style={ss.guitarFingerText}>{diagram.fingers?.[i] || ''}</Text>
            </View>
          );
        })}

        {/* Pestana (barre) */}
        {diagram.barre && (
          <View
            style={[
              ss.guitarBarre,
              {
                top: 30 + (diagram.barre.fret - (diagram.startFret > 1 ? diagram.startFret - 1 : 0) - 0.5) * FRET_HEIGHT - 3,
                left: 14 + (diagram.barre.fromString - 1) * STRING_SPACING,
                width: (diagram.barre.toString - diagram.barre.fromString) * STRING_SPACING + 20,
              },
            ]}
          />
        )}
      </View>

      {/* Notas do acorde */}
      <View style={ss.chordNotesRow}>
        <Text style={ss.chordNotesLabel}>Notas: </Text>
        <Text style={ss.chordNotesValue}>
          {getChordNotes(chord.root, chord.quality).map(n => NOTES_BR[n]).join(' - ')}
        </Text>
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DIAGRAMA DE TECLADO
// ═══════════════════════════════════════════════════════════════════════════

function KeyboardDiagram({ chord }: { chord: HarmonicChord }) {
  const notes = getKeyboardNotes(chord.root, chord.quality);
  
  // Teclas brancas e pretas de uma oitava
  const WHITE_KEYS = [0, 2, 4, 5, 7, 9, 11]; // C, D, E, F, G, A, B
  const BLACK_KEYS = [1, 3, 6, 8, 10]; // C#, D#, F#, G#, A#
  const BLACK_KEY_POSITIONS = [0.7, 1.7, 3.7, 4.7, 5.7]; // Posição relativa

  const KEY_WIDTH = 32;
  const BLACK_KEY_WIDTH = 22;
  const WHITE_KEY_HEIGHT = 100;
  const BLACK_KEY_HEIGHT = 60;

  const chordNotes = getChordNotes(chord.root, chord.quality);

  return (
    <View style={ss.keyboardDiagram}>
      <View style={[ss.keyboardContainer, { width: KEY_WIDTH * 7 + 2 }]}>
        {/* Teclas brancas */}
        {WHITE_KEYS.map((pc, i) => {
          const isInChord = chordNotes.includes(pc);
          const isRoot = pc === chord.root;
          return (
            <View
              key={`white-${pc}`}
              style={[
                ss.whiteKey,
                { left: i * KEY_WIDTH, width: KEY_WIDTH, height: WHITE_KEY_HEIGHT },
                isInChord && ss.whiteKeyActive,
                isRoot && ss.keyRoot,
              ]}
            >
              {isInChord && (
                <Text style={[ss.keyLabel, isRoot && ss.keyLabelRoot]}>
                  {NOTES_BR[pc]}
                </Text>
              )}
            </View>
          );
        })}

        {/* Teclas pretas */}
        {BLACK_KEYS.map((pc, i) => {
          const isInChord = chordNotes.includes(pc);
          const isRoot = pc === chord.root;
          return (
            <View
              key={`black-${pc}`}
              style={[
                ss.blackKey,
                {
                  left: BLACK_KEY_POSITIONS[i] * KEY_WIDTH - BLACK_KEY_WIDTH / 2 + KEY_WIDTH / 2,
                  width: BLACK_KEY_WIDTH,
                  height: BLACK_KEY_HEIGHT,
                },
                isInChord && ss.blackKeyActive,
                isRoot && ss.keyRoot,
              ]}
            >
              {isInChord && (
                <Text style={[ss.blackKeyLabel, isRoot && ss.keyLabelRoot]}>
                  {NOTES_BR[pc].replace('#', '♯')}
                </Text>
              )}
            </View>
          );
        })}
      </View>

      {/* Notas do acorde */}
      <View style={ss.chordNotesRow}>
        <Text style={ss.chordNotesLabel}>Notas: </Text>
        <Text style={ss.chordNotesValue}>
          {chordNotes.map(n => NOTES_BR[n]).join(' - ')}
        </Text>
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DIAGRAMA DE BAIXO
// ═══════════════════════════════════════════════════════════════════════════

function BassDiagram({ chord }: { chord: HarmonicChord }) {
  const bassNotes = getBassNotes(chord.root, chord.quality);

  return (
    <View style={ss.bassDiagram}>
      <View style={ss.bassNotesGrid}>
        <View style={ss.bassNoteCard}>
          <Text style={ss.bassNoteLabel}>RAIZ (1ª)</Text>
          <Text style={ss.bassNoteName}>{NOTES_BR[bassNotes.root]}</Text>
          <Text style={ss.bassNoteIntl}>{NOTES_INTL[bassNotes.root]}</Text>
          <Text style={ss.bassNoteHint}>Fundamental do acorde</Text>
        </View>

        <View style={ss.bassNoteCard}>
          <Text style={ss.bassNoteLabel}>QUINTA (5ª)</Text>
          <Text style={ss.bassNoteName}>{NOTES_BR[bassNotes.fifth]}</Text>
          <Text style={ss.bassNoteIntl}>{NOTES_INTL[bassNotes.fifth]}</Text>
          <Text style={ss.bassNoteHint}>Estabilidade harmônica</Text>
        </View>

        <View style={ss.bassNoteCard}>
          <Text style={ss.bassNoteLabel}>OITAVA (8ª)</Text>
          <Text style={ss.bassNoteName}>{NOTES_BR[bassNotes.octave]}</Text>
          <Text style={ss.bassNoteIntl}>{NOTES_INTL[bassNotes.octave]}</Text>
          <Text style={ss.bassNoteHint}>Raiz uma oitava acima</Text>
        </View>
      </View>

      {/* Padrão sugerido */}
      <View style={ss.bassPatternBox}>
        <Text style={ss.bassPatternLabel}>PADRÃO BÁSICO</Text>
        <View style={ss.bassPatternRow}>
          <View style={ss.bassPatternBeat}>
            <Text style={ss.bassPatternNote}>{NOTES_BR[bassNotes.root]}</Text>
            <Text style={ss.bassPatternBeatNum}>1</Text>
          </View>
          <Text style={ss.bassPatternArrow}>→</Text>
          <View style={ss.bassPatternBeat}>
            <Text style={ss.bassPatternNote}>{NOTES_BR[bassNotes.fifth]}</Text>
            <Text style={ss.bassPatternBeatNum}>2</Text>
          </View>
          <Text style={ss.bassPatternArrow}>→</Text>
          <View style={ss.bassPatternBeat}>
            <Text style={ss.bassPatternNote}>{NOTES_BR[bassNotes.octave]}</Text>
            <Text style={ss.bassPatternBeatNum}>3</Text>
          </View>
          <Text style={ss.bassPatternArrow}>→</Text>
          <View style={ss.bassPatternBeat}>
            <Text style={ss.bassPatternNote}>{NOTES_BR[bassNotes.fifth]}</Text>
            <Text style={ss.bassPatternBeatNum}>4</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// FUNÇÕES AUXILIARES
// ═══════════════════════════════════════════════════════════════════════════

function getChordNotes(root: number, quality: 'major' | 'minor' | 'dim'): number[] {
  // Intervalos: Maior = [0, 4, 7], Menor = [0, 3, 7], Dim = [0, 3, 6]
  const intervals = quality === 'major' ? [0, 4, 7] 
    : quality === 'minor' ? [0, 3, 7] 
    : [0, 3, 6];
  
  return intervals.map(i => (root + i) % 12);
}

// ═══════════════════════════════════════════════════════════════════════════
// ESTILOS
// ═══════════════════════════════════════════════════════════════════════════

const ss = StyleSheet.create({
  container: {
    backgroundColor: C.surface,
    borderRadius: 16,
    padding: 16,
    marginHorizontal: 16,
    marginVertical: 8,
  },

  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  headerLeft: {},
  headerTitle: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 18,
    color: C.white,
  },
  headerSub: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 13,
    color: C.text2,
    marginTop: 2,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: C.surfaceLight,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Seletor de Instrumento
  instrumentBar: {
    flexDirection: 'row',
    backgroundColor: C.bg,
    borderRadius: 12,
    padding: 4,
    marginBottom: 16,
  },
  instrumentBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    borderRadius: 8,
    gap: 4,
  },
  instrumentBtnActive: {
    backgroundColor: C.surfaceLight,
  },
  instrumentEmoji: {
    fontSize: 16,
  },
  instrumentLabel: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 11,
    color: C.text3,
  },
  instrumentLabelActive: {
    color: C.white,
  },

  // Grade de Acordes
  chordGridScroll: {
    paddingVertical: 4,
    gap: 8,
  },
  chordCard: {
    width: 64,
    backgroundColor: C.bg,
    borderRadius: 10,
    padding: 8,
    marginRight: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: C.border,
  },
  chordCardSelected: {
    borderColor: C.amber,
    backgroundColor: C.amberMuted,
  },
  chordCardActive: {
    borderColor: C.green,
    backgroundColor: C.greenMuted,
  },
  chordCardTonic: {
    borderColor: C.green + '66',
  },
  chordDegree: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 11,
    marginBottom: 2,
  },
  chordName: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 16,
    color: C.white,
  },
  chordNameSelected: {
    color: C.amber,
  },
  chordIntl: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 10,
    color: C.text3,
    marginTop: 2,
  },
  activeIndicator: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: C.green,
    alignItems: 'center',
    justifyContent: 'center',
  },
  activeIndicatorText: {
    fontSize: 10,
    color: C.white,
  },

  // Detalhe do Acorde
  chordDetail: {
    marginTop: 16,
    backgroundColor: C.bg,
    borderRadius: 12,
    padding: 16,
  },
  chordDetailHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  chordDetailName: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 28,
    color: C.white,
  },
  chordDetailIntl: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 14,
    color: C.text2,
  },
  functionBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  functionBadgeText: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 10,
    letterSpacing: 0.5,
  },
  functionDesc: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 13,
    color: C.text2,
    marginBottom: 16,
  },

  // Container do Diagrama
  diagramContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 150,
  },
  diagramPlaceholder: {
    padding: 20,
    alignItems: 'center',
  },
  diagramPlaceholderText: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 13,
    color: C.text3,
  },

  // Diagrama Violão/Guitarra
  guitarDiagram: {
    alignItems: 'center',
  },
  guitarNeck: {
    position: 'relative',
    backgroundColor: '#1a1a1a',
    borderRadius: 4,
  },
  guitarString: {
    position: 'absolute',
    width: 1,
    backgroundColor: C.text3,
  },
  guitarFret: {
    position: 'absolute',
    height: 2,
    backgroundColor: '#555',
  },
  guitarNut: {
    height: 4,
    backgroundColor: '#ddd',
  },
  fretNumber: {
    position: 'absolute',
    left: -16,
    top: 40,
    fontFamily: 'Manrope_500Medium',
    fontSize: 10,
    color: C.text2,
  },
  guitarFinger: {
    position: 'absolute',
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: C.amber,
    alignItems: 'center',
    justifyContent: 'center',
  },
  guitarFingerText: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 11,
    color: C.bg,
  },
  guitarMuted: {
    position: 'absolute',
    top: 8,
    fontSize: 12,
    color: C.text3,
  },
  guitarOpen: {
    position: 'absolute',
    top: 10,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: C.text2,
  },
  guitarBarre: {
    position: 'absolute',
    height: 8,
    borderRadius: 4,
    backgroundColor: C.amber,
  },

  // Notas do acorde
  chordNotesRow: {
    flexDirection: 'row',
    marginTop: 12,
    alignItems: 'center',
  },
  chordNotesLabel: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 12,
    color: C.text3,
  },
  chordNotesValue: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 14,
    color: C.white,
  },

  // Diagrama Teclado
  keyboardDiagram: {
    alignItems: 'center',
  },
  keyboardContainer: {
    position: 'relative',
    height: 110,
    backgroundColor: '#1a1a1a',
    borderRadius: 4,
    padding: 4,
  },
  whiteKey: {
    position: 'absolute',
    backgroundColor: '#f5f5f5',
    borderRadius: 0,
    borderBottomLeftRadius: 3,
    borderBottomRightRadius: 3,
    borderWidth: 1,
    borderColor: '#ccc',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: 6,
  },
  whiteKeyActive: {
    backgroundColor: C.amberLight,
  },
  blackKey: {
    position: 'absolute',
    backgroundColor: '#222',
    borderBottomLeftRadius: 3,
    borderBottomRightRadius: 3,
    zIndex: 1,
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: 4,
  },
  blackKeyActive: {
    backgroundColor: C.amber,
  },
  keyRoot: {
    backgroundColor: C.green,
  },
  keyLabel: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 10,
    color: C.bg,
  },
  keyLabelRoot: {
    color: C.white,
  },
  blackKeyLabel: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 8,
    color: C.white,
  },

  // Diagrama Baixo
  bassDiagram: {
    width: '100%',
  },
  bassNotesGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  bassNoteCard: {
    flex: 1,
    backgroundColor: C.surfaceLight,
    borderRadius: 10,
    padding: 12,
    alignItems: 'center',
  },
  bassNoteLabel: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 9,
    color: C.text3,
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  bassNoteName: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 24,
    color: C.white,
  },
  bassNoteIntl: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 12,
    color: C.text2,
  },
  bassNoteHint: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 9,
    color: C.text3,
    marginTop: 4,
    textAlign: 'center',
  },
  bassPatternBox: {
    marginTop: 16,
    backgroundColor: C.surfaceLight,
    borderRadius: 10,
    padding: 12,
  },
  bassPatternLabel: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 10,
    color: C.text3,
    letterSpacing: 0.5,
    textAlign: 'center',
    marginBottom: 8,
  },
  bassPatternRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 4,
  },
  bassPatternBeat: {
    alignItems: 'center',
    backgroundColor: C.bg,
    borderRadius: 8,
    padding: 8,
    minWidth: 44,
  },
  bassPatternNote: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 14,
    color: C.white,
  },
  bassPatternBeatNum: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 10,
    color: C.text3,
  },
  bassPatternArrow: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 14,
    color: C.text3,
  },
});
