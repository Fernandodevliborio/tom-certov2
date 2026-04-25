import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as Updates from 'expo-updates';
import { Colors, Radius, Spacing, Typography } from '../src/theme/tokens';
import { BottomNav } from '../src/components/BottomNav';
import { useAuth } from '../src/auth/AuthContext';

export default function ConfiguracoesScreen() {
  const { logout, session } = useAuth();
  const [checking, setChecking] = useState(false);

  const onCheckUpdate = async () => {
    if (checking) return;
    if (Platform.OS === 'web' || !Updates.isEnabled) {
      Alert.alert('Atualização', 'A busca de atualizações só funciona no aplicativo instalado.');
      return;
    }
    setChecking(true);
    try {
      const res = await Updates.checkForUpdateAsync();
      if (res.isAvailable) {
        await Updates.fetchUpdateAsync();
        Alert.alert('Atualização baixada', 'Nova versão baixada! O app vai reiniciar.', [
          { text: 'Reiniciar', onPress: () => Updates.reloadAsync().catch(() => {}) },
        ]);
      } else {
        Alert.alert('Você está em dia', 'Versão mais recente já instalada.');
      }
    } catch (e: any) {
      Alert.alert('Falha', e?.message ? String(e.message) : 'Verifique sua conexão.');
    } finally {
      setChecking(false);
    }
  };

  const onLogout = () => {
    Alert.alert('Sair', 'Deseja sair da conta?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Sair', style: 'destructive', onPress: logout },
    ]);
  };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.replace('/')} style={s.back}>
          <Ionicons name="chevron-back" size={22} color={Colors.gold} />
        </TouchableOpacity>
        <Text style={s.title}>Configurações</Text>
        <View style={s.back} />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Account */}
        <Text style={s.sectionLabel}>CONTA</Text>
        <View style={s.card}>
          <View style={s.row}>
            <View style={s.rowLeft}>
              <Ionicons name="person-circle-outline" size={22} color={Colors.gold} />
              <View>
                <Text style={s.rowTitle}>{session?.customer_name || 'Usuário'}</Text>
                <Text style={s.rowSub}>Conta ativa</Text>
              </View>
            </View>
          </View>
        </View>

        {/* App */}
        <Text style={s.sectionLabel}>APLICATIVO</Text>
        <View style={s.card}>
          <TouchableOpacity style={s.row} onPress={onCheckUpdate} activeOpacity={0.7}>
            <View style={s.rowLeft}>
              <Ionicons name="refresh-outline" size={22} color={Colors.gold} />
              <View>
                <Text style={s.rowTitle}>Buscar atualização</Text>
                <Text style={s.rowSub}>v4.0.1 · {(Updates.updateId ?? 'embedded').slice(0, 8)}</Text>
              </View>
            </View>
            {checking ? <ActivityIndicator size="small" color={Colors.gold} /> : <Ionicons name="chevron-forward" size={18} color={Colors.text2} />}
          </TouchableOpacity>
          <View style={s.divider} />
          <TouchableOpacity style={s.row} onPress={onLogout} activeOpacity={0.7}>
            <View style={s.rowLeft}>
              <Ionicons name="log-out-outline" size={22} color={Colors.red} />
              <View>
                <Text style={[s.rowTitle, { color: Colors.red }]}>Sair</Text>
                <Text style={s.rowSub}>Encerrar sessão no dispositivo</Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={18} color={Colors.text2} />
          </TouchableOpacity>
        </View>

        {/* About */}
        <Text style={s.sectionLabel}>SOBRE</Text>
        <View style={s.card}>
          <View style={s.row}>
            <View style={s.rowLeft}>
              <Ionicons name="sparkles-outline" size={22} color={Colors.gold} />
              <View>
                <Text style={s.rowTitle}>Tom Certo</Text>
                <Text style={s.rowSub}>Detecção inteligente de tonalidade com IA</Text>
              </View>
            </View>
          </View>
        </View>

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
  title: {
    color: Colors.white,
    fontFamily: Typography.bold,
    fontSize: 20,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.lg, paddingTop: 8 },
  sectionLabel: {
    color: Colors.text2,
    fontFamily: Typography.semi,
    fontSize: 11,
    letterSpacing: 1.4,
    marginTop: Spacing.lg,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: 14,
  },
  rowLeft: { flexDirection: 'row', alignItems: 'center', gap: 14, flex: 1 },
  rowTitle: { color: Colors.white, fontFamily: Typography.semi, fontSize: 14 },
  rowSub: { color: Colors.text2, fontFamily: Typography.regular, fontSize: 11.5, marginTop: 2 },
  divider: { height: 1, backgroundColor: Colors.border, marginLeft: 56 },
});
