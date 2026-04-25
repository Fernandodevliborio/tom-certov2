import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Radius, Spacing, Typography } from '../theme/tokens';
import { formatKeyDisplay } from '../utils/noteUtils';

export function AICard({
  root,
  quality,
  confidence,
  hint,
}: {
  root: number | null;
  quality: 'major' | 'minor' | null;
  confidence: number; // 0..100
  hint?: string | null;
}) {
  const widthAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(widthAnim, {
      toValue: confidence,
      duration: 600,
      useNativeDriver: false,
    }).start();
  }, [confidence]);

  const pct = Math.max(0, Math.min(100, Math.round(confidence)));
  const color = pct >= 60 ? Colors.green : pct >= 35 ? Colors.gold : Colors.text2;
  const k = root !== null && quality ? formatKeyDisplay(root, quality) : null;

  return (
    <View style={s.card}>
      <View style={s.header}>
        <Ionicons name="sparkles-outline" size={13} color={Colors.gold} />
        <Text style={s.headerTxt}>IA ESTIMANDO TONALIDADE</Text>
      </View>

      {k ? (
        <View style={s.keyRow}>
          <Text style={s.keyNote}>{k.noteBr}</Text>
          <Text style={s.keyQual}>{k.qualityLabel}</Text>
        </View>
      ) : (
        <Text style={s.keyPlaceholder}>—</Text>
      )}
      {k ? <Text style={s.keyIntl}>({k.noteIntl})</Text> : null}

      <View style={s.barRow}>
        <View style={s.barTrack}>
          <Animated.View
            style={[
              s.barFill,
              {
                backgroundColor: color,
                width: widthAnim.interpolate({
                  inputRange: [0, 100],
                  outputRange: ['0%', '100%'],
                }),
              },
            ]}
          />
        </View>
        <Text style={[s.pct, { color }]}>{pct}%</Text>
      </View>

      {hint ? (
        <View style={s.hintRow}>
          <Ionicons name="ellipsis-horizontal-circle-outline" size={12} color={Colors.gold} />
          <Text style={s.hintTxt}>{hint}</Text>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.goldBorderSoft,
    padding: Spacing.lg,
    gap: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: 4,
  },
  headerTxt: {
    color: Colors.gold,
    fontFamily: Typography.semi,
    fontSize: 10.5,
    letterSpacing: 1.4,
  },
  keyRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  keyNote: { color: Colors.white, fontFamily: Typography.bold, fontSize: 36, lineHeight: 40 },
  keyQual: { color: Colors.textMuted, fontFamily: Typography.medium, fontSize: 18, marginBottom: 6 },
  keyIntl: { color: Colors.text2, fontFamily: Typography.regular, fontSize: 13, marginTop: -4 },
  keyPlaceholder: { color: Colors.text2, fontFamily: Typography.bold, fontSize: 36 },
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 10,
  },
  barTrack: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.surface3,
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: 3 },
  pct: {
    fontFamily: Typography.bold,
    fontSize: 13,
    minWidth: 38,
    textAlign: 'right',
  },
  hintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
  },
  hintTxt: {
    color: Colors.textMuted,
    fontFamily: Typography.regular,
    fontSize: 12,
  },
});
