import React from 'react';
import { ScrollView, View, Text, StyleSheet } from 'react-native';
import { NOTES_BR } from '../utils/noteUtils';
import { Colors, Radius, Spacing, Typography } from '../theme/tokens';

export function HistoryChips({ notes }: { notes: number[] }) {
  if (notes.length === 0) {
    return (
      <View style={s.emptyWrap}>
        <Text style={s.empty}>aguardando primeiras notas</Text>
      </View>
    );
  }
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={s.row}
    >
      {notes.slice(-6).map((pc, i, arr) => {
        const isLast = i === arr.length - 1;
        return (
          <View key={i} style={[s.chip, isLast && s.chipActive]}>
            <Text style={[s.txt, isLast && s.txtActive]} numberOfLines={1}>
              {NOTES_BR[pc]}
            </Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  row: { gap: 8, paddingHorizontal: 2, paddingVertical: 4 },
  emptyWrap: { paddingVertical: 12, paddingHorizontal: 4 },
  empty: {
    color: Colors.text2,
    fontFamily: Typography.regular,
    fontSize: 12,
    fontStyle: 'italic',
  },
  chip: {
    minWidth: 52,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
  },
  chipActive: {
    backgroundColor: Colors.goldMuted,
    borderColor: Colors.goldBorder,
    shadowColor: Colors.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 3,
  },
  txt: {
    color: Colors.textMuted,
    fontSize: 14,
    fontFamily: Typography.semi,
  },
  txtActive: {
    color: Colors.gold,
  },
});
