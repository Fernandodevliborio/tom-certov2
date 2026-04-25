import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, StyleSheet, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Radius, Spacing, Typography } from '../theme/tokens';

export type StatusVariant = 'idle' | 'analyzing' | 'probable' | 'confirmed';

export function StatusPill({
  label,
  variant,
}: {
  label: string;
  variant: StatusVariant;
}) {
  const pulse = useRef(new Animated.Value(0)).current;
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (variant === 'analyzing' || variant === 'probable') {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1, duration: 850, useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 0, duration: 850, useNativeDriver: true }),
        ])
      );
      loop.start();
      const sp = Animated.loop(
        Animated.timing(spin, { toValue: 1, duration: 1800, easing: Easing.linear, useNativeDriver: true })
      );
      sp.start();
      return () => { loop.stop(); sp.stop(); };
    }
  }, [variant]);

  if (variant === 'confirmed') {
    return (
      <View style={[s.pill, s.pillConfirmed]}>
        <Ionicons name="checkmark-circle" size={13} color={Colors.green} />
        <Text style={[s.pillText, { color: Colors.green }]}>{label.toUpperCase()}</Text>
      </View>
    );
  }

  if (variant === 'idle') {
    return (
      <View style={[s.pill, s.pillIdle]}>
        <Animated.View
          style={[
            s.dot,
            { backgroundColor: Colors.green, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) },
          ]}
        />
        <Text style={[s.pillText, { color: Colors.white }]}>{label.toUpperCase()}</Text>
      </View>
    );
  }

  // analyzing / probable
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <View style={[s.pill, s.pillAnalyzing]}>
      <Animated.View style={{ transform: [{ rotate }] }}>
        <Ionicons name="sparkles" size={11} color={Colors.gold} />
      </Animated.View>
      <Text style={[s.pillText, { color: Colors.gold }]} numberOfLines={1}>
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: Spacing.base,
    paddingVertical: 7,
    borderRadius: Radius.pill,
    borderWidth: 1,
  },
  pillIdle: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderColor: 'rgba(255,255,255,0.10)',
  },
  pillAnalyzing: {
    backgroundColor: Colors.goldMuted,
    borderColor: Colors.goldBorder,
  },
  pillConfirmed: {
    backgroundColor: Colors.greenSoft,
    borderColor: Colors.greenBorder,
  },
  pillText: {
    fontFamily: Typography.semi,
    fontSize: 10.5,
    letterSpacing: 1.2,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
});
