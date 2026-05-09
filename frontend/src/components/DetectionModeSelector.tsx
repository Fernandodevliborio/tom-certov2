// ═══════════════════════════════════════════════════════════════════════════
// DetectionModeSelector — seletor discreto de modo de detecção
// ═══════════════════════════════════════════════════════════════════════════
//
// Card colapsado por padrão (apenas mostra modo atual). Toca para expandir e
// revelar as duas opções lado a lado. Visual premium, alinhado ao restante do
// app (cores escuras + accent dourado).
//
// Props:
//   value:    'vocal' | 'vocal_instrument'
//   onChange: troca o modo (dispara hardReset no hook se já estiver rodando)
//   disabled: true durante recovery (evita troca durante restart)
// ═══════════════════════════════════════════════════════════════════════════

import React, { useState } from 'react';
import { Pressable, Text, View, LayoutAnimation, Platform, UIManager } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  DETECTION_MODE_LABEL,
  DETECTION_MODE_DESC,
  type DetectionMode,
} from '../utils/detectionMode';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface Props {
  value: DetectionMode;
  onChange: (mode: DetectionMode) => void;
  disabled?: boolean;
}

const C = {
  bg: 'rgba(255, 255, 255, 0.04)',
  border: 'rgba(255, 255, 255, 0.08)',
  borderActive: 'rgba(245, 158, 11, 0.45)',
  text: '#E5E7EB',
  textMuted: '#9CA3AF',
  accent: '#F59E0B',
  accentBg: 'rgba(245, 158, 11, 0.12)',
  cardBgActive: 'rgba(245, 158, 11, 0.05)',
};

export function DetectionModeSelector({ value, onChange, disabled = false }: Props) {
  const [expanded, setExpanded] = useState(false);

  const toggleExpanded = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded(e => !e);
  };

  const select = (mode: DetectionMode) => {
    if (disabled || mode === value) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setExpanded(false);
      return;
    }
    onChange(mode);
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded(false);
  };

  return (
    <View testID="detection-mode-selector" style={{ width: '100%' }}>
      {/* Header colapsado */}
      <Pressable
        testID="detection-mode-toggle"
        onPress={toggleExpanded}
        disabled={disabled}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingVertical: 10,
          paddingHorizontal: 14,
          backgroundColor: expanded ? C.cardBgActive : C.bg,
          borderWidth: 1,
          borderColor: expanded ? C.borderActive : C.border,
          borderRadius: 12,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
          <View
            style={{
              width: 26,
              height: 26,
              borderRadius: 8,
              backgroundColor: C.accentBg,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons
              name={value === 'vocal_instrument' ? 'musical-notes' : 'mic'}
              size={14}
              color={C.accent}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text
              style={{
                color: C.textMuted,
                fontSize: 10,
                letterSpacing: 0.8,
                fontFamily: 'Manrope_600SemiBold',
                textTransform: 'uppercase',
              }}
            >
              Modo de detecção
            </Text>
            <Text
              testID="detection-mode-current-label"
              style={{
                color: C.text,
                fontSize: 13,
                fontFamily: 'Manrope_700Bold',
                marginTop: 1,
              }}
            >
              {DETECTION_MODE_LABEL[value]}
            </Text>
          </View>
        </View>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={16}
          color={C.textMuted}
        />
      </Pressable>

      {/* Opções expandidas */}
      {expanded && (
        <View style={{ marginTop: 8, gap: 6 }}>
          {(['vocal', 'vocal_instrument'] as const).map(opt => {
            const isActive = opt === value;
            return (
              <Pressable
                key={opt}
                testID={`detection-mode-option-${opt}`}
                onPress={() => select(opt)}
                disabled={disabled}
                style={{
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  gap: 10,
                  paddingVertical: 10,
                  paddingHorizontal: 12,
                  backgroundColor: isActive ? C.accentBg : 'transparent',
                  borderWidth: 1,
                  borderColor: isActive ? C.borderActive : C.border,
                  borderRadius: 10,
                }}
              >
                <View
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 8,
                    borderWidth: 1.5,
                    borderColor: isActive ? C.accent : C.textMuted,
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginTop: 2,
                  }}
                >
                  {isActive && (
                    <View
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: C.accent,
                      }}
                    />
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <Text
                    style={{
                      color: isActive ? C.accent : C.text,
                      fontSize: 13,
                      fontFamily: 'Manrope_700Bold',
                    }}
                  >
                    {DETECTION_MODE_LABEL[opt]}
                  </Text>
                  <Text
                    style={{
                      color: C.textMuted,
                      fontSize: 11,
                      lineHeight: 15,
                      marginTop: 2,
                    }}
                  >
                    {DETECTION_MODE_DESC[opt]}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}
