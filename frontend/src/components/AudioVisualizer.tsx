import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, Easing } from 'react-native';

interface Props {
  level: number; // 0..1
  color?: string;
  height?: number;
  bars?: number;
  active?: boolean;
}

export default function AudioVisualizer({
  level,
  color = '#FFB020',
  height = 56,
  bars = 7,
  active = true,
}: Props) {
  const animRefs = useRef(
    Array.from({ length: bars }, () => new Animated.Value(0.1))
  ).current;

  useEffect(() => {
    if (!active) {
      animRefs.forEach(v => {
        Animated.timing(v, { toValue: 0.1, duration: 180, useNativeDriver: false }).start();
      });
      return;
    }

    const now = Date.now() / 200;
    animRefs.forEach((v, i) => {
      const phase = (i / bars) * Math.PI * 2;
      const wave = 0.5 + 0.5 * Math.sin(now + phase);
      const target = Math.max(0.15, Math.min(1, level * 0.8 + wave * level * 0.5 + 0.1));
      Animated.timing(v, {
        toValue: target,
        duration: 120,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start();
    });
  }, [level, active, bars, animRefs]);

  return (
    <View style={s.row}>
      {animRefs.map((v, i) => (
        <Animated.View
          key={i}
          style={[
            s.bar,
            {
              height: v.interpolate({
                inputRange: [0, 1],
                outputRange: [4, height],
              }),
              backgroundColor: color,
            },
          ]}
        />
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  bar: {
    width: 5,
    borderRadius: 3,
  },
});
