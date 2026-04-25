import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { Colors, Radius, Spacing, Typography } from '../src/theme/tokens';
import { BottomNav } from '../src/components/BottomNav';
import { loadHistory, clearHistory, type DetectionEntry } from '../src/utils/historyStorage';

function formatRelative(ts: number): string {
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return `${diffSec}s atrás`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}min atrás`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h atrás`;
  const d = new Date(ts);
  return d.toLocaleDateString('pt-BR');
}

export default function HistoricoScreen() {
  const [items, setItems] = useState<DetectionEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = async () => {
    const data = await loadHistory();
    setItems(data);
    setLoaded(true);
  };

  useFocusEffect(React.useCallback(() => { reload(); }, []));

  const onClear = () => {
    Alert.alert('Limpar histórico', 'Apagar todas as detecções salvas?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Apagar',
        style: 'destructive',
        onPress: async () => {
          await clearHistory();
          await reload();
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.replace('/')} style={s.back}>
          <Ionicons name="chevron-back" size={22} color={Colors.gold} />
        </TouchableOpacity>
        <Text style={s.title}>Histórico</Text>
        {items.length > 0 ? (
          <TouchableOpacity onPress={onClear} style={s.clearBtn}>
            <Ionicons name="trash-outline" size={18} color={Colors.text2} />
          </TouchableOpacity>
        ) : (
          <View style={s.clearBtn} />
        )}
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {!loaded ? null : items.length === 0 ? (
          <View style={s.empty}>
            <Ionicons name="musical-notes-outline" size={56} color={Colors.text3} />
            <Text style={s.emptyTitle}>Sem detecções ainda</Text>
            <Text style={s.emptySub}>
              Quando o app identificar tons em suas análises, eles aparecerão aqui.
            </Text>
          </View>
        ) : (
          items.map((it, i) => (
            <View key={i} style={s.card}>
              <View style={s.cardLeft}>
                <Text style={s.keyTxt}>{it.key_name}</Text>
                <Text style={s.timeTxt}>{formatRelative(it.at)}</Text>
              </View>
              <View style={s.cardRight}>
                <Text style={[s.confTxt, { color: it.confidence >= 0.6 ? Colors.green : Colors.gold }]}>
                  {Math.round(it.confidence * 100)}%
                </Text>
              </View>
            </View>
          ))
        )}
        <View style={{ height: 100 }} />
      </ScrollView>

      <BottomNav />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  back: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  clearBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title: {
    color: Colors.white,
    fontFamily: Typography.bold,
    fontSize: 20,
  },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.lg,
    paddingTop: 8,
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 80,
    gap: 10,
  },
  emptyTitle: {
    color: Colors.white,
    fontFamily: Typography.semi,
    fontSize: 16,
    marginTop: 8,
  },
  emptySub: {
    color: Colors.text2,
    fontFamily: Typography.regular,
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: 32,
    lineHeight: 19,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 14,
    marginBottom: 10,
  },
  cardLeft: { flex: 1 },
  cardRight: {},
  keyTxt: { color: Colors.white, fontFamily: Typography.semi, fontSize: 16 },
  timeTxt: {
    color: Colors.text2,
    fontFamily: Typography.regular,
    fontSize: 12,
    marginTop: 2,
  },
  confTxt: { fontFamily: Typography.bold, fontSize: 16 },
});
