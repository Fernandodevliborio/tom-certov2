import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, Easing, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../theme/tokens';

/**
 * Big golden mic button — sem SVG, apenas Views + Animated nativo.
 * Camadas:
 *  - 3 glow rings concêntricos (View com borderRadius e opacity decrescente)
 *  - 3 ondas pulsantes (anel borderColor com scale/opacity loop)
 *  - botão circular dourado (com box-shadow gold)
 *  - inner circle + ícone mic
 */
export function BigMicButton({
  onPress,
  size = 168,
}: {
  onPress: () => void;
  size?: number;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const breath = useRef(new Animated.Value(0)).current;
  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  const ring3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const br = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, { toValue: 1, duration: 1800, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(breath, { toValue: 0, duration: 1800, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    br.start();
    const makeRing = (val: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(val, { toValue: 1, duration: 2400, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(val, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      );
    const r1 = makeRing(ring1, 0);
    const r2 = makeRing(ring2, 800);
    const r3 = makeRing(ring3, 1600);
    r1.start(); r2.start(); r3.start();
    return () => { br.stop(); r1.stop(); r2.stop(); r3.stop(); };
  }, []);

  const renderRing = (val: Animated.Value, key: string) => (
    <Animated.View
      key={key}
      style={[
        s.ring,
        {
          width: size + 30,
          height: size + 30,
          borderRadius: (size + 30) / 2,
          opacity: val.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0.55, 0.25, 0] }),
          transform: [{ scale: val.interpolate({ inputRange: [0, 1], outputRange: [1, 2.2] }) }],
        },
      ]}
    />
  );

  const breathScale = breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1.04] });
  const breathOpacity = breath.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] });
  const haloScale = breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1.1] });

  const haloSize = size * 1.85;
  const halo2Size = size * 1.55;
  const halo3Size = size * 1.30;

  return (
    <View style={[s.wrap, { width: size + 60, height: size + 60 }]}>
      {/* Glow halos (camadas com opacity decrescente — simula gradient radial) */}
      <Animated.View style={[
        s.halo,
        {
          width: haloSize, height: haloSize, borderRadius: haloSize / 2,
          opacity: 0.05, transform: [{ scale: haloScale }],
        },
      ]} />
      <Animated.View style={[
        s.halo,
        {
          width: halo2Size, height: halo2Size, borderRadius: halo2Size / 2,
          opacity: 0.08, transform: [{ scale: haloScale }],
        },
      ]} />
      <Animated.View style={[
        s.halo,
        {
          width: halo3Size, height: halo3Size, borderRadius: halo3Size / 2,
          opacity: 0.14, transform: [{ scale: haloScale }],
        },
      ]} />
      {/* Ondas pulsantes */}
      {renderRing(ring3, 'r3')}
      {renderRing(ring2, 'r2')}
      {renderRing(ring1, 'r1')}
      {/* Botão */}
      <TouchableOpacity
        testID="start-btn"
        onPress={onPress}
        onPressIn={() => Animated.spring(scale, { toValue: 0.94, useNativeDriver: true }).start()}
        onPressOut={() => Animated.spring(scale, { toValue: 1, friction: 5, useNativeDriver: true }).start()}
        activeOpacity={1}
      >
        <Animated.View
          style={[
            s.btn,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              opacity: breathOpacity,
              transform: [{ scale: Animated.multiply(scale, breathScale) }],
            },
          ]}
        >
          <View style={[s.inner, { width: size * 0.78, height: size * 0.78, borderRadius: (size * 0.78) / 2 }]}>
            <Ionicons name="mic" size={size * 0.42} color={Colors.bg} />
          </View>
        </Animated.View>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  halo: {
    position: 'absolute',
    backgroundColor: Colors.gold,
  },
  ring: {
    position: 'absolute',
    borderWidth: 1.5,
    borderColor: Colors.gold,
  },
  btn: {
    backgroundColor: Colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.goldLight,
    shadowColor: Colors.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.65,
    shadowRadius: 32,
    elevation: 14,
  },
  inner: {
    backgroundColor: Colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(0,0,0,0.18)',
  },
});
