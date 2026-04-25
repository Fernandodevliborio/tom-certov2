import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, usePathname } from 'expo-router';
import { Colors, Radius, Spacing, Typography } from '../theme/tokens';

const TABS = [
  { key: 'historico', label: 'Histórico', icon: 'list-outline' as const, route: '/historico' },
  { key: 'home', label: 'Detectar', icon: 'pulse' as const, route: '/' },
  { key: 'config', label: 'Configurações', icon: 'settings-outline' as const, route: '/configuracoes' },
];

export function BottomNav() {
  const pathname = usePathname();
  const activeKey =
    pathname === '/configuracoes' ? 'config'
    : pathname === '/historico' ? 'historico'
    : 'home';

  return (
    <View style={s.wrap}>
      <View style={s.bar}>
        {TABS.map((t) => {
          const active = t.key === activeKey;
          if (t.key === 'home') {
            return (
              <TouchableOpacity
                key={t.key}
                onPress={() => router.replace(t.route)}
                activeOpacity={0.85}
                style={s.centerBtnWrap}
              >
                <View style={[s.centerBtn, active && s.centerBtnActive]}>
                  <Ionicons name="pulse" size={22} color={Colors.bg} />
                </View>
              </TouchableOpacity>
            );
          }
          return (
            <TouchableOpacity
              key={t.key}
              onPress={() => router.replace(t.route)}
              style={s.tab}
              activeOpacity={0.7}
            >
              <Ionicons
                name={t.icon}
                size={20}
                color={active ? Colors.gold : Colors.text2}
              />
              <Text style={[s.tabLabel, active && s.tabLabelActive]} numberOfLines={1}>
                {t.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Platform.select({ ios: 8, android: 12, default: 12 }),
    paddingTop: 6,
    backgroundColor: Colors.bg,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: Colors.surface,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 10,
    height: 64,
  },
  tab: {
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    gap: 3,
  },
  tabLabel: {
    color: Colors.text2,
    fontFamily: Typography.medium,
    fontSize: 10.5,
  },
  tabLabelActive: { color: Colors.gold },
  centerBtnWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: Colors.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.55,
    shadowRadius: 14,
    elevation: 8,
    transform: [{ translateY: -10 }],
    borderWidth: 2,
    borderColor: Colors.goldLight,
  },
  centerBtnActive: {
    backgroundColor: Colors.gold,
  },
});
