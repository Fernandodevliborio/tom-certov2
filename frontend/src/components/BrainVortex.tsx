import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, Easing, Dimensions } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop, G, Path } from 'react-native-svg';
import { Ionicons } from '@expo/vector-icons';
import { Colors } from '../theme/tokens';

const AnimatedG = Animated.createAnimatedComponent(G);

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

  return (
    <View style={[s.container, { width: size, height: size }]}>
      {/* Outer rotating particle ring */}
      <Animated.View style={[StyleSheet.absoluteFill, s.center, { transform: [{ rotate: rotate2 }] }]}>
        {particles2.map((p, i) => <Particle key={`p2-${i}`} {...p} />)}
      </Animated.View>
      {/* Inner counter-rotating particles */}
      <Animated.View style={[StyleSheet.absoluteFill, s.center, { transform: [{ rotate: rotate1 }] }]}>
        {particles1.map((p, i) => <Particle key={`p1-${i}`} {...p} />)}
      </Animated.View>
      {/* SVG glow circle behind brain */}
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="glow" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor="#FFB020" stopOpacity="0.45" />
            <Stop offset="55%" stopColor="#FFB020" stopOpacity="0.10" />
            <Stop offset="100%" stopColor="#FFB020" stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={size * 0.32} fill="url(#glow)" />
      </Svg>
      {/* Brain icon center */}
      <Animated.View style={[s.center, StyleSheet.absoluteFill, { opacity: brainPulse, transform: [{ scale: brainPulse }] }]}>
        <View style={s.brainBox}>
          <BrainIcon size={size * 0.28} />
        </View>
      </Animated.View>
    </View>
  );
}

function BrainIcon({ size }: { size: number }) {
  // Custom brain SVG path
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M9 5C7.5 5 6 6.5 6 8C5 8.5 4 9.5 4 11C4 12 4.5 13 5 13.5C4.5 14 4 15 4 16C4 17.5 5.5 19 7 19C7.5 19.5 8.5 20 9.5 20C10.5 20 11.5 19.5 12 18.5C12.5 19.5 13.5 20 14.5 20C15.5 20 16.5 19.5 17 19C18.5 19 20 17.5 20 16C20 15 19.5 14 19 13.5C19.5 13 20 12 20 11C20 9.5 19 8.5 18 8C18 6.5 16.5 5 15 5C14 5 13 5.5 12.5 6.5C12 5.5 10 5 9 5Z"
        stroke={Colors.gold}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M12 6.5V18.5M9 9C9 9 9.5 11 11 11M15 9C15 9 14.5 11 13 11M9 14C9 14 10 16 12 16C14 16 15 14 15 14"
        stroke={Colors.goldLight}
        strokeWidth={1}
        strokeLinecap="round"
      />
    </Svg>
  );
}

const s = StyleSheet.create({
  container: { alignItems: 'center', justifyContent: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
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
    backgroundColor: 'rgba(255, 176, 32, 0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255, 176, 32, 0.32)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
