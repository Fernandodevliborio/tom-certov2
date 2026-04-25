import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Colors, Radius, Spacing, Typography } from '../theme/tokens';
import { NOTES_INTL } from '../utils/noteUtils';

type Chord = { root: number; quality: 'major' | 'minor' | 'dim'; label: string; isTonic: boolean };

function degreeFor(i: number, _q: 'major' | 'minor') {
  return (['I', 'ii', 'iii', 'IV', 'V', 'vi'] as const)[i] ?? '';
}

function chordIntl(root: number, q: 'major' | 'minor' | 'dim') {
  return NOTES_INTL[root] + (q === 'minor' ? 'm' : q === 'dim' ? '°' : '');
}

export function HarmonicFieldChips({
  chords,
  quality,
}: {
  chords: Chord[];
  quality: 'major' | 'minor';
}) {
  return (
    <View style={s.grid}>
      {chords.map((c, i) => (
        <View key={i} style={[s.chip, c.isTonic && s.chipTonic]}>
          <Text style={[s.chord, c.isTonic && s.chordTonic]}>{chordIntl(c.root, c.quality)}</Text>
          <Text style={[s.degree, c.isTonic && s.degreeTonic]}>{degreeFor(i, quality)}</Text>
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    flexBasis: '15%',
    flexGrow: 1,
    minWidth: 48,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    gap: 2,
  },
  chipTonic: {
    backgroundColor: Colors.goldMuted,
    borderColor: Colors.goldBorder,
    shadowColor: Colors.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 3,
  },
  chord: {
    color: Colors.white,
    fontFamily: Typography.semi,
    fontSize: 14,
  },
  chordTonic: { color: Colors.gold },
  degree: {
    color: Colors.text2,
    fontFamily: Typography.medium,
    fontSize: 10,
    letterSpacing: 0.5,
  },
  degreeTonic: { color: Colors.goldLight },
});
