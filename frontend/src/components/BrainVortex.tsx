import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../theme/tokens';

/**
 * BrainVortex sem SVG: ícone Ionicons "musical-notes" (cérebro substituído por
 * um símbolo de IA/notas) com 2 anéis de partículas em órbita (Views animadas)
 * e camadas de halo dourado.
 */

function Particle({ angle, radius, size, delay, duration }: {
  angle: number; radius: number; size: number; delay: number; duration: number;
}) {
  const phase = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(phase, { toValue: 1, duration, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  const x = phase.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [Math.cos(angle) * (radius - 18), Math.cos(angle) * (radius + 14), Math.cos(angle) * (radius - 18)],
  });
  const y = phase.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [Math.sin(angle) * (radius - 18), Math.sin(angle) * (radius + 14), Math.sin(angle) * (radius - 18)],
  });
  const opacity = phase.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: [0.25, 0.85, 0.25],
  });
  return (
    <Animated.View
      style={[
        s.particle,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          opacity,
          transform: [{ translateX: x }, { translateY: y }],
        },
      ]}
    />
  );
}

export function BrainVortex({ size = 220 }: { size?: number }) {
  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  const brainPulse = useRef(new Animated.Value(0.85)).current;

  useEffect(() => {
    const r1 = Animated.loop(
      Animated.timing(ring1, { toValue: 1, duration: 6000, easing: Easing.linear, useNativeDriver: true })
    );
    const r2 = Animated.loop(
      Animated.timing(ring2, { toValue: 1, duration: 9000, easing: Easing.linear, useNativeDriver: true })
    );
    const bp = Animated.loop(
      Animated.sequence([
        Animated.timing(brainPulse, { toValue: 1, duration: 1100, useNativeDriver: true }),
        Animated.timing(brainPulse, { toValue: 0.85, duration: 1100, useNativeDriver: true }),
      ])
    );
    r1.start(); r2.start(); bp.start();
    return () => { r1.stop(); r2.stop(); bp.stop(); };
  }, []);

  const rotate1 = ring1.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const rotate2 = ring2.interpolate({ inputRange: [0, 1], outputRange: ['360deg', '0deg'] });

  // Particle ring radii
  const r1 = size * 0.35;
  const r2 = size * 0.46;
  const particles1 = Array.from({ length: 14 }, (_, i) => ({
    angle: (i / 14) * Math.PI * 2,
    radius: r1,
    size: 3 + (i % 3),
    delay: i * 90,
    duration: 2400,
  }));
  const particles2 = Array.from({ length: 22 }, (_, i) => ({
    angle: (i / 22) * Math.PI * 2 + 0.3,
    radius: r2,
    size: 2 + (i % 2),
    delay: i * 60,
    duration: 3600,
  }));

  // 3 halo layers (gold gradient simulation)
  const haloA = size * 0.95;
  const haloB = size * 0.75;
  const haloC = size * 0.55;

  return (
    <View style={[s.container, { width: size, height: size }]}>
      {/* Halos para simular gradiente radial */}
      <View style={[s.halo, { width: haloA, height: haloA, borderRadius: haloA / 2, opacity: 0.10 }]} />
      <View style={[s.halo, { width: haloB, height: haloB, borderRadius: haloB / 2, opacity: 0.18 }]} />
      <View style={[s.halo, { width: haloC, height: haloC, borderRadius: haloC / 2, opacity: 0.30 }]} />

      {/* Outer rotating particle ring */}
      <Animated.View style={[StyleSheet.absoluteFill, s.center, { transform: [{ rotate: rotate2 }] }]}>
        {particles2.map((p, i) => <Particle key={`p2-${i}`} {...p} />)}
      </Animated.View>
      {/* Inner counter-rotating particles */}
      <Animated.View style={[StyleSheet.absoluteFill, s.center, { transform: [{ rotate: rotate1 }] }]}>
        {particles1.map((p, i) => <Particle key={`p1-${i}`} {...p} />)}
      </Animated.View>
      {/* Brain icon center */}
      <Animated.View style={[s.center, StyleSheet.absoluteFill, { opacity: brainPulse, transform: [{ scale: brainPulse }] }]}>
        <View style={s.brainBox}>
          <Ionicons name="sparkles" size={size * 0.30} color={Colors.gold} />
        </View>
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { alignItems: 'center', justifyContent: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  halo: {
    position: 'absolute',
    backgroundColor: Colors.gold,
  },
  particle: {
    position: 'absolute',
    backgroundColor: Colors.gold,
    shadowColor: Colors.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 4,
  },
  brainBox: {
    width: 88,
    height: 88,
    borderRadius: 24,
    backgroundColor: 'rgba(255, 176, 32, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255, 176, 32, 0.40)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: Colors.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 16,
    elevation: 8,
  },
});
