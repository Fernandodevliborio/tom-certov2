import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Radius, Spacing, Typography } from '../theme/tokens';

export interface AIStep {
  id: string;
  label: string;
  status: 'done' | 'active' | 'pending';
}

export function AIStepsList({ steps }: { steps: AIStep[] }) {
  return (
    <View style={s.list}>
      {steps.map((step) => (
        <StepRow key={step.id} step={step} />
      ))}
    </View>
  );
}

function StepRow({ step }: { step: AIStep }) {
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (step.status === 'active') {
      const loop = Animated.loop(
        Animated.timing(spin, { toValue: 1, duration: 1100, useNativeDriver: true })
      );
      loop.start();
      return () => loop.stop();
    }
  }, [step.status]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <View style={s.row}>
      <View style={s.iconWrap}>
        {step.status === 'done' ? (
          <Ionicons name="checkmark-circle" size={18} color={Colors.green} />
        ) : step.status === 'active' ? (
          <Animated.View style={{ transform: [{ rotate }] }}>
            <Ionicons name="sync" size={16} color={Colors.gold} />
          </Animated.View>
        ) : (
          <View style={s.dotPending} />
        )}
      </View>
      <Text
        style={[
          s.label,
          step.status === 'done' && s.labelDone,
          step.status === 'active' && s.labelActive,
        ]}
        numberOfLines={1}
      >
        {step.label}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  list: { gap: 12, paddingHorizontal: Spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconWrap: { width: 22, alignItems: 'center', justifyContent: 'center' },
  dotPending: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: Colors.text3,
  },
  label: {
    color: Colors.text2,
    fontFamily: Typography.medium,
    fontSize: 14,
  },
  labelDone: { color: Colors.green },
  labelActive: { color: Colors.white },
});
