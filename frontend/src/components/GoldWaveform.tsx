import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, Easing } from 'react-native';
import { Colors } from '../theme/tokens';

/**
 * Onda sonora dourada — reage ao audioLevel (0..1).
 * Usa barras animadas em alturas variáveis com phase shifts.
 */
export function GoldWaveform({
  level,
  active,
  height = 50,
  bars = 36,
  width,
}: {
  level: number;
  active: boolean;
  height?: number;
  bars?: number;
  width?: number;
}) {
  const animsRef = useRef<Animated.Value[]>(
    Array.from({ length: bars }, () => new Animated.Value(0.2))
  );

  useEffect(() => {
    const anims = animsRef.current;
    if (!active) {
      anims.forEach((a) => a.setValue(0.12));
      return;
    }
    const lv = Math.max(0.05, Math.min(1, level));
    anims.forEach((a, i) => {
      // formato senoidal modulado por nível
      const phase = (i / bars) * Math.PI * 2;
      const target = 0.2 + lv * (0.55 + 0.45 * Math.sin(Date.now() / 200 + phase));
      Animated.timing(a, {
        toValue: Math.max(0.08, Math.min(1, target)),
        duration: 140,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start();
    });
  }, [level, active, bars]);

  return (
    <View style={[s.row, { height, width: width ?? '100%' }]}>
      {animsRef.current.map((a, i) => {
        const dist = Math.abs(i - bars / 2) / (bars / 2);
        const opacity = a.interpolate({
          inputRange: [0, 1],
          outputRange: [0.15 + (1 - dist) * 0.2, 0.65 + (1 - dist) * 0.35],
        });
        const h = a.interpolate({
          inputRange: [0, 1],
          outputRange: [3, height],
        });
        const isCenter = dist < 0.2;
        return (
          <Animated.View
            key={i}
            style={[
              s.bar,
              {
                height: h,
                opacity,
                backgroundColor: isCenter ? Colors.goldLight : Colors.gold,
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  bar: {
    width: 2.5,
    borderRadius: 2,
    backgroundColor: Colors.gold,
  },
});
