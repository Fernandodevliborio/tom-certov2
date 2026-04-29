import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated,
  Dimensions, Platform, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useTuner } from '../src/hooks/useTuner';

const { width: SW, height: SH } = Dimensions.get('window');

const C = {
  bg: '#050508',
  surface: '#0D0D12',
  surfaceLight: '#16161D',
  border: '#1E1E28',
  amber: '#FFB020',
  amberLight: '#FFCC66',
  amberGlow: 'rgba(255,176,32,0.4)',
  amberMuted: 'rgba(255,176,32,0.08)',
  white: '#FFFFFF',
  text2: '#9CA3AF',
  text3: '#4B5563',
  red: '#EF4444',
  redGlow: 'rgba(239,68,68,0.4)',
  green: '#10B981',
  greenGlow: 'rgba(16,185,129,0.4)',
  blue: '#3B82F6',
  blueGlow: 'rgba(59,130,246,0.4)',
  purple: '#8B5CF6',
  cyan: '#06B6D4',
};

// Notas musicais com frequências
const ALL_NOTES = [
  { note: 'C', freq: 16.35 },
  { note: 'C#', freq: 17.32 },
  { note: 'D', freq: 18.35 },
  { note: 'D#', freq: 19.45 },
  { note: 'E', freq: 20.60 },
  { note: 'F', freq: 21.83 },
  { note: 'F#', freq: 23.12 },
  { note: 'G', freq: 24.50 },
  { note: 'G#', freq: 25.96 },
  { note: 'A', freq: 27.50 },
  { note: 'A#', freq: 29.14 },
  { note: 'B', freq: 30.87 },
];

// Instrumentos premium
const INSTRUMENTS = {
  violao: {
    name: 'Violão',
    icon: 'musical-notes',
    emoji: '🎸',
    strings: [
      { note: 'E', octave: 2, freq: 82.41, name: '6ª - Mi' },
      { note: 'A', octave: 2, freq: 110.00, name: '5ª - Lá' },
      { note: 'D', octave: 3, freq: 146.83, name: '4ª - Ré' },
      { note: 'G', octave: 3, freq: 196.00, name: '3ª - Sol' },
      { note: 'B', octave: 3, freq: 246.94, name: '2ª - Si' },
      { note: 'E', octave: 4, freq: 329.63, name: '1ª - Mi' },
    ],
  },
  guitarra: {
    name: 'Guitarra',
    icon: 'flash',
    emoji: '🎸',
    strings: [
      { note: 'E', octave: 2, freq: 82.41, name: '6ª - Mi' },
      { note: 'A', octave: 2, freq: 110.00, name: '5ª - Lá' },
      { note: 'D', octave: 3, freq: 146.83, name: '4ª - Ré' },
      { note: 'G', octave: 3, freq: 196.00, name: '3ª - Sol' },
      { note: 'B', octave: 3, freq: 246.94, name: '2ª - Si' },
      { note: 'E', octave: 4, freq: 329.63, name: '1ª - Mi' },
    ],
  },
  baixo: {
    name: 'Baixo',
    icon: 'radio',
    emoji: '🎸',
    strings: [
      { note: 'E', octave: 1, freq: 41.20, name: '4ª - Mi' },
      { note: 'A', octave: 1, freq: 55.00, name: '3ª - Lá' },
      { note: 'D', octave: 2, freq: 73.42, name: '2ª - Ré' },
      { note: 'G', octave: 2, freq: 98.00, name: '1ª - Sol' },
    ],
  },
  ukulele: {
    name: 'Ukulele',
    icon: 'sunny',
    emoji: '🪕',
    strings: [
      { note: 'G', octave: 4, freq: 392.00, name: '4ª - Sol' },
      { note: 'C', octave: 4, freq: 261.63, name: '3ª - Dó' },
      { note: 'E', octave: 4, freq: 329.63, name: '2ª - Mi' },
      { note: 'A', octave: 4, freq: 440.00, name: '1ª - Lá' },
    ],
  },
};

type InstrumentKey = keyof typeof INSTRUMENTS;

// Função para encontrar a nota mais próxima
function getClosestNote(frequency: number): { note: string; octave: number; freq: number; cents: number } | null {
  if (!frequency || frequency < 20 || frequency > 5000) return null;
  
  // Calcula a nota usando a fórmula: n = 12 * log2(f/440) + 49
  const n = 12 * Math.log2(frequency / 440) + 49;
  const nearestN = Math.round(n);
  const cents = Math.round((n - nearestN) * 100);
  
  const octave = Math.floor((nearestN - 1) / 12);
  const noteIndex = (nearestN - 1) % 12;
  const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  
  const exactFreq = 440 * Math.pow(2, (nearestN - 49) / 12);
  
  return {
    note: noteNames[noteIndex < 0 ? noteIndex + 12 : noteIndex],
    octave: octave,
    freq: exactFreq,
    cents: cents,
  };
}

// Error Boundary
class TunerErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; errorMsg: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMsg: '' };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, errorMsg: error?.message || 'Erro desconhecido' };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[TunerErrorBoundary]', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <SafeAreaView style={ss.safe}>
          <View style={ss.errorContainer}>
            <Ionicons name="warning" size={64} color={C.amber} />
            <Text style={ss.errorTitle}>Algo deu errado</Text>
            <Text style={ss.errorMessage}>{this.state.errorMsg}</Text>
            <TouchableOpacity style={ss.errorButton} onPress={() => router.back()}>
              <Text style={ss.errorButtonText}>Voltar</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}

export default function TunerScreenWrapper() {
  return (
    <TunerErrorBoundary>
      <TunerScreen />
    </TunerErrorBoundary>
  );
}

function TunerScreen() {
  const [instrument, setInstrument] = useState<InstrumentKey>('violao');
  const [isLoading, setIsLoading] = useState(true);
  const [initAttempts, setInitAttempts] = useState(0);
  
  const tuner = useTuner();
  
  // ═══════════════════════════════════════════════════════════════════════════
  // CORREÇÃO CRÍTICA: Sistema de detecção estável com debounce e hysteresis
  // ═══════════════════════════════════════════════════════════════════════════
  
  // Limites de detecção - MUITO mais rigorosos
  const MIN_NOISE_LEVEL = 0.20;           // Volume mínimo para considerar som (aumentado de 0.08)
  const MIN_FREQ_STABILITY_MS = 150;       // Tempo mínimo para confirmar nota (ms)
  const SILENCE_COOLDOWN_MS = 600;         // Tempo para voltar ao estado neutro após silêncio
  const FREQ_TOLERANCE_HZ = 8;             // Tolerância para considerar mesma nota (Hz)
  
  // Estados de detecção
  const [confirmedFrequency, setConfirmedFrequency] = useState<number | null>(null);
  const [isDetectingSound, setIsDetectingSound] = useState(false);
  const [detectionPhase, setDetectionPhase] = useState<'idle' | 'detecting' | 'confirmed'>('idle');
  
  // Refs para tracking temporal
  const lastFrequencyRef = useRef<number | null>(null);
  const frequencyStableStartRef = useRef<number | null>(null);
  const silenceStartRef = useRef<number | null>(null);
  const detectionIntervalRef = useRef<NodeJS.Timeout | null>(null);
  
  // Feedback sonoro refs
  const [lastTunedString, setLastTunedString] = useState<string | null>(null);
  const tunedSoundTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // ═══════════════════════════════════════════════════════════════════════════
  // LÓGICA DE DETECÇÃO ESTÁVEL COM DEBOUNCE
  // ═══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    // Limpar interval anterior
    if (detectionIntervalRef.current) {
      clearInterval(detectionIntervalRef.current);
    }
    
    // Processar a cada 50ms para suavidade
    detectionIntervalRef.current = setInterval(() => {
      const now = Date.now();
      const hasSound = tuner.noiseLevel >= MIN_NOISE_LEVEL;
      const currentFreq = tuner.frequency;
      
      // ════════════════════════════════════════════════════════════════════
      // CASO 1: Sem som suficiente → Transição para silêncio
      // ════════════════════════════════════════════════════════════════════
      if (!hasSound || currentFreq === null || currentFreq < 50 || currentFreq > 1000) {
        // Marcar início do silêncio se ainda não marcou
        if (silenceStartRef.current === null) {
          silenceStartRef.current = now;
        }
        
        // Se silêncio persiste por SILENCE_COOLDOWN_MS, resetar tudo
        const silenceDuration = now - silenceStartRef.current;
        if (silenceDuration >= SILENCE_COOLDOWN_MS) {
          setIsDetectingSound(false);
          setConfirmedFrequency(null);
          setDetectionPhase('idle');
          lastFrequencyRef.current = null;
          frequencyStableStartRef.current = null;
        }
        return;
      }
      
      // ════════════════════════════════════════════════════════════════════
      // CASO 2: Som detectado → Validar estabilidade antes de confirmar
      // ════════════════════════════════════════════════════════════════════
      silenceStartRef.current = null; // Reset do contador de silêncio
      
      const lastFreq = lastFrequencyRef.current;
      
      // Verificar se a frequência é estável (dentro da tolerância)
      const isStable = lastFreq !== null && 
        Math.abs(currentFreq - lastFreq) <= FREQ_TOLERANCE_HZ;
      
      if (isStable) {
        // Frequência estável - contar tempo
        if (frequencyStableStartRef.current === null) {
          frequencyStableStartRef.current = now;
        }
        
        const stableDuration = now - frequencyStableStartRef.current;
        
        // Se estável por tempo suficiente, CONFIRMAR a nota
        if (stableDuration >= MIN_FREQ_STABILITY_MS) {
          setIsDetectingSound(true);
          setConfirmedFrequency(currentFreq);
          setDetectionPhase('confirmed');
        } else {
          // Ainda detectando, não confirmado
          setDetectionPhase('detecting');
        }
      } else {
        // Frequência mudou - resetar contador de estabilidade
        frequencyStableStartRef.current = now;
        lastFrequencyRef.current = currentFreq;
        
        // Se já estava confirmado, manter por um momento (hysteresis)
        if (detectionPhase !== 'confirmed') {
          setDetectionPhase('detecting');
        }
      }
      
      lastFrequencyRef.current = currentFreq;
      
    }, 50);
    
    return () => {
      if (detectionIntervalRef.current) {
        clearInterval(detectionIntervalRef.current);
      }
    };
  }, [tuner.noiseLevel, tuner.frequency, detectionPhase]);
  
  // Reset completo ao desativar o tuner
  useEffect(() => {
    if (!tuner.isActive) {
      setIsDetectingSound(false);
      setConfirmedFrequency(null);
      setDetectionPhase('idle');
      lastFrequencyRef.current = null;
      frequencyStableStartRef.current = null;
      silenceStartRef.current = null;
    }
  }, [tuner.isActive]);
  
  // ═══════════════════════════════════════════════════════════════════════════
  // FEEDBACK HÁPTICO QUANDO AFINADO
  // ═══════════════════════════════════════════════════════════════════════════
  const playTunedSound = useCallback(async (stringName: string) => {
    if (lastTunedString === stringName) return;
    if (tunedSoundTimeoutRef.current) return;
    
    try {
      const Haptics = require('expo-haptics');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      
      setLastTunedString(stringName);
      
      tunedSoundTimeoutRef.current = setTimeout(() => {
        tunedSoundTimeoutRef.current = null;
        setLastTunedString(null);
      }, 2000);
    } catch (err) {
      console.log('[Tuner] Haptics not available:', err);
    }
  }, [lastTunedString]);
  
  useEffect(() => {
    return () => {
      if (tunedSoundTimeoutRef.current) {
        clearTimeout(tunedSoundTimeoutRef.current);
      }
    };
  }, []);
  
  // Animações
  const needleAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;
  const waveAnim1 = useRef(new Animated.Value(0)).current;
  const waveAnim2 = useRef(new Animated.Value(0)).current;
  const waveAnim3 = useRef(new Animated.Value(0)).current;
  
  const currentInstrument = INSTRUMENTS[instrument];
  
  // ═══════════════════════════════════════════════════════════════════════════
  // NOTA DETECTADA — APENAS quando há som CONFIRMADO (não ruído)
  // ═══════════════════════════════════════════════════════════════════════════
  const detectedNote = (detectionPhase === 'confirmed' && confirmedFrequency) 
    ? getClosestNote(confirmedFrequency) 
    : null;
  const cents = detectedNote?.cents || 0;
  
  // ═══════════════════════════════════════════════════════════════════════════
  // STATUS DA AFINAÇÃO — Baseado no detectionPhase (não ruído direto)
  // ═══════════════════════════════════════════════════════════════════════════
  const getTuningStatus = () => {
    if (tuner.error) {
      return { 
        status: 'error', 
        message: tuner.error, 
        color: C.red, 
        glow: C.redGlow,
        icon: 'alert-circle' as const,
      };
    }
    if (isLoading) {
      return { 
        status: 'loading', 
        message: 'Iniciando microfone...', 
        color: C.text2, 
        glow: 'transparent',
        icon: 'mic-outline' as const,
      };
    }
    if (!tuner.isActive) {
      return { 
        status: 'idle', 
        message: 'Toque uma corda para começar', 
        color: C.text2, 
        glow: 'transparent',
        icon: 'musical-notes-outline' as const,
      };
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // ESTADO NEUTRO: Aguardando som ou detectando (não confirmado)
    // ════════════════════════════════════════════════════════════════════════
    if (detectionPhase === 'idle' || detectionPhase === 'detecting' || !detectedNote) {
      return { 
        status: 'waiting', 
        message: 'Toque uma corda para começar', 
        color: C.text3, 
        glow: 'transparent',
        icon: 'musical-notes-outline' as const,
      };
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // SOM CONFIRMADO: Mostrar instruções de afinação
    // ════════════════════════════════════════════════════════════════════════
    const absCents = Math.abs(cents);
    
    if (absCents <= 3) {
      return { 
        status: 'perfect', 
        message: 'Afinado ✓', 
        color: C.green, 
        glow: C.greenGlow,
        icon: 'checkmark-circle' as const,
      };
    } else if (absCents <= 8) {
      return { 
        status: 'almost', 
        message: 'Quase lá...', 
        color: C.amber, 
        glow: C.amberGlow,
        icon: 'ellipse' as const,
      };
    } else if (cents < -8) {
      return { 
        status: 'low', 
        message: 'Aperte a corda ↑', 
        color: C.blue, 
        glow: C.blueGlow,
        icon: 'arrow-up-circle' as const,
      };
    } else {
      return { 
        status: 'high', 
        message: 'Afrouxe a corda ↓', 
        color: C.red, 
        glow: C.redGlow,
        icon: 'arrow-down-circle' as const,
      };
    }
  };
  
  const status = getTuningStatus();
  
  // Animação de pulse contínuo - MAIS LENTA E SUTIL
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.04, duration: 1800, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1800, useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, []);
  
  // Animação de ondas - APENAS quando CONFIRMADO (não ruído)
  useEffect(() => {
    if (detectionPhase !== 'confirmed') {
      waveAnim1.setValue(0);
      waveAnim2.setValue(0);
      waveAnim3.setValue(0);
      return;
    }
    
    const createWave = (anim: Animated.Value, delay: number) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(anim, { toValue: 1, duration: 3500, useNativeDriver: true }),
          Animated.timing(anim, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      );
    };
    
    const wave1 = createWave(waveAnim1, 0);
    const wave2 = createWave(waveAnim2, 1000);
    const wave3 = createWave(waveAnim3, 2000);
    
    wave1.start();
    wave2.start();
    wave3.start();
    
    return () => {
      wave1.stop();
      wave2.stop();
      wave3.stop();
    };
  }, [detectionPhase]);
  
  // Animação do ponteiro baseado nos cents - APENAS quando CONFIRMADO
  useEffect(() => {
    if (detectionPhase !== 'confirmed') {
      // Centralizar ponteiro no silêncio/idle
      Animated.spring(needleAnim, {
        toValue: 0,
        friction: 10,
        tension: 50,
        useNativeDriver: true,
      }).start();
      return;
    }
    
    const normalizedCents = Math.max(-50, Math.min(50, cents)) / 50;
    Animated.spring(needleAnim, {
      toValue: normalizedCents,
      friction: 10,
      tension: 50,
      useNativeDriver: true,
    }).start();
  }, [cents, detectionPhase]);
  
  // Glow quando afinado
  useEffect(() => {
    if (status.status === 'perfect') {
      Animated.loop(
        Animated.sequence([
          Animated.timing(glowAnim, { toValue: 0.8, duration: 800, useNativeDriver: true }),
          Animated.timing(glowAnim, { toValue: 0.5, duration: 800, useNativeDriver: true }),
        ])
      ).start();
    } else {
      glowAnim.setValue(0);
    }
  }, [status.status]);
  
  // Inicialização
  useEffect(() => {
    let mounted = true;
    
    const init = async () => {
      try {
        setIsLoading(true);
        await new Promise(r => setTimeout(r, 200));
        if (!mounted) return;
        await tuner.start();
        if (mounted) setIsLoading(false);
      } catch (err) {
        if (mounted) {
          setIsLoading(false);
          if (initAttempts < 1) {
            setTimeout(() => mounted && setInitAttempts(a => a + 1), 1000);
          }
        }
      }
    };
    
    init();
    return () => { mounted = false; tuner.stop(); };
  }, [initAttempts]);
  
  const handleRetry = async () => {
    setIsLoading(true);
    await tuner.stop();
    await new Promise(r => setTimeout(r, 300));
    await tuner.start();
    setIsLoading(false);
  };
  
  const handleBack = () => {
    tuner.stop();
    router.back();
  };
  
  const needleRotation = needleAnim.interpolate({
    inputRange: [-1, 1],
    outputRange: ['-45deg', '45deg'],
  });
  
  // ═══════════════════════════════════════════════════════════════════════════
  // CORDA MAIS PRÓXIMA — APENAS quando detecção CONFIRMADA
  // ═══════════════════════════════════════════════════════════════════════════
  const getClosestString = () => {
    // Só retorna corda se detecção está confirmada
    if (detectionPhase !== 'confirmed' || !confirmedFrequency) return null;
    
    let closest = currentInstrument.strings[0];
    let minDiff = Math.abs(confirmedFrequency - closest.freq);
    
    for (const str of currentInstrument.strings) {
      const diff = Math.abs(confirmedFrequency - str.freq);
      if (diff < minDiff) {
        minDiff = diff;
        closest = str;
      }
    }
    return closest;
  };
  
  const closestString = getClosestString();
  
  // ═══════════════════════════════════════════════════════════════════════
  // NOVO: Tocar som/vibração quando afinado
  // ═══════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (status.status === 'perfect' && closestString) {
      playTunedSound(closestString.name);
    }
  }, [status.status, closestString?.name, playTunedSound]);
  
  return (
    <View style={ss.container}>
      <LinearGradient
        colors={['#0A0A0F', '#050508', '#0A0A0F']}
        style={StyleSheet.absoluteFill}
      />
      
      <SafeAreaView style={ss.safe}>
        {/* Header Premium */}
        <View style={ss.header}>
          <TouchableOpacity onPress={handleBack} style={ss.backBtn}>
            <Ionicons name="chevron-back" size={24} color={C.white} />
          </TouchableOpacity>
          
          <View style={ss.headerCenter}>
            <Text style={ss.headerTitle}>Afinador Inteligente</Text>
            <View style={ss.betaBadge}>
              <Text style={ss.betaText}>BETA</Text>
            </View>
          </View>
          
          <View style={ss.headerRight}>
            <Ionicons name="settings-outline" size={22} color={C.text3} />
          </View>
        </View>
        
        {/* Seletor de Instrumento Premium */}
        <View style={ss.instrumentRow}>
          {(Object.keys(INSTRUMENTS) as InstrumentKey[]).map((key) => (
            <TouchableOpacity
              key={key}
              onPress={() => setInstrument(key)}
              style={[
                ss.instrumentChip,
                instrument === key && ss.instrumentChipActive,
              ]}
            >
              <Text style={ss.instrumentEmoji}>{INSTRUMENTS[key].emoji}</Text>
              <Text style={[
                ss.instrumentText,
                instrument === key && ss.instrumentTextActive,
              ]}>
                {INSTRUMENTS[key].name}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        
        {/* Área Principal */}
        <View style={ss.mainArea}>
          {/* Loading */}
          {isLoading && (
            <View style={ss.loadingContainer}>
              <ActivityIndicator size="large" color={C.amber} />
              <Text style={ss.loadingText}>Iniciando microfone...</Text>
            </View>
          )}
          
          {/* Error */}
          {!isLoading && tuner.error && (
            <View style={ss.errorOverlay}>
              <View style={ss.errorIconContainer}>
                <Ionicons name="mic-off" size={48} color={C.red} />
              </View>
              <Text style={ss.errorTextMain}>{tuner.error}</Text>
              <TouchableOpacity style={ss.retryBtn} onPress={handleRetry}>
                <LinearGradient
                  colors={[C.amber, C.amberLight]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={ss.retryBtnGradient}
                >
                  <Ionicons name="refresh" size={18} color={C.bg} />
                  <Text style={ss.retryBtnText}>Tentar novamente</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          )}
          
          {/* Tuner Ativo */}
          {!isLoading && !tuner.error && (
            <>
              {/* Medidor Circular Premium */}
              <View style={ss.meterContainer}>
                {/* Ondas de fundo - MAIS SUTIS */}
                {[waveAnim1, waveAnim2, waveAnim3].map((anim, i) => (
                  <Animated.View
                    key={i}
                    style={[
                      ss.waveRing,
                      {
                        opacity: anim.interpolate({
                          inputRange: [0, 1],
                          outputRange: [0.2, 0], // Reduzido de 0.3
                        }),
                        transform: [{
                          scale: anim.interpolate({
                            inputRange: [0, 1],
                            outputRange: [1, 1.5], // Reduzido de 1.8
                          }),
                        }],
                      },
                    ]}
                  />
                ))}
                
                {/* Círculo externo com marcadores */}
                <View style={ss.outerRing}>
                  {/* Marcadores */}
                  {[-40, -20, 0, 20, 40].map((val) => (
                    <View
                      key={val}
                      style={[
                        ss.tickMark,
                        { transform: [{ rotate: `${val * 0.9}deg` }] },
                        val === 0 && ss.tickMarkCenter,
                      ]}
                    >
                      <View style={[
                        ss.tickLine,
                        val === 0 && ss.tickLineCenter,
                      ]} />
                    </View>
                  ))}
                  
                  {/* Ponteiro */}
                  <Animated.View
                    style={[
                      ss.needleContainer,
                      { transform: [{ rotate: needleRotation }] },
                    ]}
                  >
                    <LinearGradient
                      colors={[status.color, 'transparent']}
                      style={ss.needle}
                    />
                  </Animated.View>
                  
                  {/* Centro com glow */}
                  <Animated.View
                    style={[
                      ss.centerGlow,
                      {
                        backgroundColor: status.glow,
                        opacity: status.status === 'perfect' ? glowAnim : 0.3,
                      },
                    ]}
                  />
                  <View style={[ss.centerDot, { backgroundColor: status.color }]} />
                </View>
                
                {/* Display da Nota */}
                <View style={ss.noteDisplay}>
                  <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                    <Text style={[ss.noteText, { color: detectedNote ? C.white : C.text3 }]}>
                      {detectedNote?.note || '—'}
                    </Text>
                  </Animated.View>
                  {detectedNote && (
                    <Text style={ss.octaveText}>{detectedNote.octave}</Text>
                  )}
                </View>
              </View>
              
              {/* Frequência - só mostra valor real quando confirmado */}
              <View style={ss.freqContainer}>
                <Text style={ss.freqLabel}>FREQUÊNCIA</Text>
                <Text style={ss.freqValue}>
                  {detectionPhase === 'confirmed' && confirmedFrequency 
                    ? `${confirmedFrequency.toFixed(1)} Hz` 
                    : '— Hz'}
                </Text>
              </View>
              
              {/* Status Card — baseado em detectionPhase */}
              <View style={[ss.statusCard, { borderColor: detectionPhase === 'confirmed' ? status.color : C.border }]}>
                <View style={[ss.statusGlow, { backgroundColor: detectionPhase === 'confirmed' ? status.glow : 'transparent' }]} />
                <Ionicons
                  name={status.icon}
                  size={28}
                  color={status.color}
                />
                <Text style={[ss.statusText, { color: status.color }]}>
                  {status.message}
                </Text>
                {/* Mostrar cents apenas quando confirmado e não afinado */}
                {detectionPhase === 'confirmed' && detectedNote && Math.abs(cents) > 3 && (
                  <Text style={ss.centsText}>
                    {cents > 0 ? '+' : ''}{cents} cents
                  </Text>
                )}
              </View>
              
              {/* Corda detectada - Só mostra quando CONFIRMADO */}
              {detectionPhase === 'confirmed' && closestString && confirmedFrequency && (
                <View style={ss.stringInfo}>
                  <Ionicons name="musical-note" size={16} color={C.amber} />
                  <Text style={ss.stringInfoText}>{closestString.name}</Text>
                </View>
              )}
            </>
          )}
        </View>
        
        {/* Cordas do Instrumento */}
        <View style={ss.stringsSection}>
          <Text style={ss.stringsTitle}>CORDAS • {currentInstrument.name.toUpperCase()}</Text>
          <View style={ss.stringsGrid}>
            {currentInstrument.strings.map((str, idx) => {
              const isActive = detectionPhase === 'confirmed' && closestString?.freq === str.freq && confirmedFrequency;
              const isPerfect = isActive && Math.abs(cents) <= 3;
              
              return (
                <View
                  key={idx}
                  style={[
                    ss.stringCard,
                    isActive && ss.stringCardActive,
                    isPerfect && ss.stringCardPerfect,
                  ]}
                >
                  <Text style={[
                    ss.stringNote,
                    isActive && ss.stringNoteActive,
                    isPerfect && ss.stringNotePerfect,
                  ]}>
                    {str.note}
                    <Text style={ss.stringOctave}>{str.octave}</Text>
                  </Text>
                  <Text style={ss.stringFreq}>{str.freq.toFixed(0)} Hz</Text>
                  {isPerfect && (
                    <View style={ss.checkBadge}>
                      <Ionicons name="checkmark" size={12} color={C.bg} />
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        </View>
        
        {/* Footer */}
        <View style={ss.footer}>
          <Ionicons name="information-circle-outline" size={14} color={C.text3} />
          <Text style={ss.footerText}>Detecção de pitch em tempo real • IA integrada</Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

const ss = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  safe: { flex: 1 },
  
  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: C.white,
    letterSpacing: -0.3,
  },
  betaBadge: {
    backgroundColor: 'rgba(255,176,32,0.15)',
    borderWidth: 1,
    borderColor: C.amber,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  betaText: {
    fontSize: 9,
    fontWeight: '700',
    color: C.amber,
    letterSpacing: 1,
  },
  headerRight: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  
  // Instruments
  instrumentRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  instrumentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  instrumentChipActive: {
    backgroundColor: 'rgba(255,176,32,0.1)',
    borderColor: C.amber,
  },
  instrumentEmoji: {
    fontSize: 14,
  },
  instrumentText: {
    fontSize: 12,
    fontWeight: '500',
    color: C.text2,
  },
  instrumentTextActive: {
    color: C.amber,
  },
  
  // Main Area
  mainArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  
  // Loading
  loadingContainer: {
    alignItems: 'center',
    gap: 16,
  },
  loadingText: {
    fontSize: 14,
    color: C.text2,
  },
  
  // Error
  errorOverlay: {
    alignItems: 'center',
    gap: 16,
  },
  errorIconContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(239,68,68,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorTextMain: {
    fontSize: 14,
    color: C.text2,
    textAlign: 'center',
    maxWidth: 280,
  },
  retryBtn: {
    borderRadius: 25,
    overflow: 'hidden',
    marginTop: 8,
  },
  retryBtnGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  retryBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: C.bg,
  },
  
  // Meter
  meterContainer: {
    width: 240,
    height: 240,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  waveRing: {
    position: 'absolute',
    width: 200,
    height: 200,
    borderRadius: 100,
    borderWidth: 2,
    borderColor: C.amber,
  },
  outerRing: {
    width: 200,
    height: 200,
    borderRadius: 100,
    borderWidth: 3,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.surface,
  },
  tickMark: {
    position: 'absolute',
    top: 8,
    width: 2,
    height: 20,
    alignItems: 'center',
  },
  tickMarkCenter: {},
  tickLine: {
    width: 2,
    height: 12,
    backgroundColor: C.text3,
    borderRadius: 1,
  },
  tickLineCenter: {
    height: 16,
    backgroundColor: C.amber,
  },
  needleContainer: {
    position: 'absolute',
    top: 20,
    width: 4,
    height: 80,
    alignItems: 'center',
  },
  needle: {
    width: 4,
    height: 70,
    borderRadius: 2,
  },
  centerGlow: {
    position: 'absolute',
    width: 80,
    height: 80,
    borderRadius: 40,
  },
  centerDot: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderRadius: 10,
  },
  noteDisplay: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  noteText: {
    fontSize: 64,
    fontWeight: '800',
    letterSpacing: -2,
  },
  octaveText: {
    fontSize: 24,
    fontWeight: '600',
    color: C.text2,
    marginLeft: 4,
  },
  
  // Frequency
  freqContainer: {
    alignItems: 'center',
    marginBottom: 20,
  },
  freqLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: C.text3,
    letterSpacing: 2,
    marginBottom: 4,
  },
  freqValue: {
    fontSize: 18,
    fontWeight: '500',
    color: C.text2,
    fontVariant: ['tabular-nums'],
  },
  
  // Status Card
  statusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderRadius: 16,
    backgroundColor: C.surface,
    borderWidth: 2,
    minWidth: 240,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  statusGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0.1,
  },
  statusText: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  centsText: {
    fontSize: 12,
    color: C.text3,
    fontVariant: ['tabular-nums'],
  },
  
  // String Info
  stringInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 16,
  },
  stringInfoText: {
    fontSize: 14,
    fontWeight: '500',
    color: C.amber,
  },
  
  // Strings Section
  stringsSection: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  stringsTitle: {
    fontSize: 10,
    fontWeight: '600',
    color: C.text3,
    letterSpacing: 2,
    textAlign: 'center',
    marginBottom: 12,
  },
  stringsGrid: {
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  stringCard: {
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    minWidth: 54,
  },
  stringCardActive: {
    borderColor: C.amber,
    backgroundColor: 'rgba(255,176,32,0.08)',
  },
  stringCardPerfect: {
    borderColor: C.green,
    backgroundColor: 'rgba(16,185,129,0.1)',
  },
  stringNote: {
    fontSize: 18,
    fontWeight: '700',
    color: C.text2,
  },
  stringNoteActive: {
    color: C.amber,
  },
  stringNotePerfect: {
    color: C.green,
  },
  stringOctave: {
    fontSize: 12,
    fontWeight: '500',
  },
  stringFreq: {
    fontSize: 9,
    color: C.text3,
    marginTop: 2,
  },
  checkBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: C.green,
    alignItems: 'center',
    justifyContent: 'center',
  },
  
  // Footer
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
  },
  footerText: {
    fontSize: 11,
    color: C.text3,
  },
  
  // Error Boundary
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 16,
  },
  errorTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: C.white,
  },
  errorMessage: {
    fontSize: 14,
    color: C.text2,
    textAlign: 'center',
  },
  errorButton: {
    backgroundColor: C.amber,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 25,
    marginTop: 16,
  },
  errorButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: C.bg,
  },
});
