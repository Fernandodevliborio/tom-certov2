import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, TouchableOpacity, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Defs, RadialGradient, Stop, Circle } from 'react-native-svg';
import { Colors } from '../theme/tokens';

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

  return (
    <View style={[s.wrap, { width: size + 60, height: size + 60 }]}>
      {/* Background radial glow SVG */}
      <Svg width={size * 2.1} height={size * 2.1} style={[StyleSheet.absoluteFill, s.center]}>
        <Defs>
          <RadialGradient id="micglow" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor="#FFB020" stopOpacity="0.55" />
            <Stop offset="40%" stopColor="#FFB020" stopOpacity="0.18" />
            <Stop offset="100%" stopColor="#FFB020" stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Circle cx={size * 1.05} cy={size * 1.05} r={size * 0.95} fill="url(#micglow)" />
      </Svg>
      {renderRing(ring3, 'r3')}
      {renderRing(ring2, 'r2')}
      {renderRing(ring1, 'r1')}
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
  center: { alignItems: 'center', justifyContent: 'center' },
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
