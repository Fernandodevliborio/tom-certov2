/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AFINADOR INTELIGENTE — Tom Certo
 *  Refator v2 (Feb 2026): experiência profissional sem falsos positivos.
 *
 *  Regras do UX:
 *   1. O microfone NÃO abre automaticamente ao entrar na tela.
 *   2. O usuário escolhe um instrumento e depois a corda/nota alvo.
 *   3. Só DEPOIS de escolher uma corda o microfone inicia.
 *   4. Gate de energia + gate de frequência-alvo (±4 semitons) evitam que
 *      ruído, voz ou outra corda gerem orientação falsa.
 *   5. Orientação (apertar/afrouxar) só aparece após leitura estável (>=250ms)
 *      dentro da janela da corda alvo.
 *   6. "Afinado" exige |cents| ≤ 5 mantido por >=400ms.
 *   7. Estados claros: Selecione uma corda → Toque a corda → Ouvindo →
 *      Apertar/Afrouxar → Afinado. Fora da janela: "Som fora da corda".
 * ═══════════════════════════════════════════════════════════════════════════
 */
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated,
  Dimensions, Platform, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useTuner } from '../src/hooks/useTuner';

const { width: SW } = Dimensions.get('window');

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
};

// ─── Instrumentos + cordas padrão ──────────────────────────────────────────
const INSTRUMENTS = {
  violao: {
    name: 'Violão', emoji: '🎸',
    strings: [
      { note: 'E', octave: 2, freq: 82.41, name: '6ª · Mi' },
      { note: 'A', octave: 2, freq: 110.00, name: '5ª · Lá' },
      { note: 'D', octave: 3, freq: 146.83, name: '4ª · Ré' },
      { note: 'G', octave: 3, freq: 196.00, name: '3ª · Sol' },
      { note: 'B', octave: 3, freq: 246.94, name: '2ª · Si' },
      { note: 'E', octave: 4, freq: 329.63, name: '1ª · Mi' },
    ],
  },
  guitarra: {
    name: 'Guitarra', emoji: '🎸',
    strings: [
      { note: 'E', octave: 2, freq: 82.41, name: '6ª · Mi' },
      { note: 'A', octave: 2, freq: 110.00, name: '5ª · Lá' },
      { note: 'D', octave: 3, freq: 146.83, name: '4ª · Ré' },
      { note: 'G', octave: 3, freq: 196.00, name: '3ª · Sol' },
      { note: 'B', octave: 3, freq: 246.94, name: '2ª · Si' },
      { note: 'E', octave: 4, freq: 329.63, name: '1ª · Mi' },
    ],
  },
  baixo: {
    name: 'Baixo', emoji: '🎸',
    strings: [
      { note: 'E', octave: 1, freq: 41.20, name: '4ª · Mi' },
      { note: 'A', octave: 1, freq: 55.00, name: '3ª · Lá' },
      { note: 'D', octave: 2, freq: 73.42, name: '2ª · Ré' },
      { note: 'G', octave: 2, freq: 98.00, name: '1ª · Sol' },
    ],
  },
  ukulele: {
    name: 'Ukulele', emoji: '🪕',
    strings: [
      { note: 'G', octave: 4, freq: 392.00, name: '4ª · Sol' },
      { note: 'C', octave: 4, freq: 261.63, name: '3ª · Dó' },
      { note: 'E', octave: 4, freq: 329.63, name: '2ª · Mi' },
      { note: 'A', octave: 4, freq: 440.00, name: '1ª · Lá' },
    ],
  },
};

type InstrumentKey = keyof typeof INSTRUMENTS;
type StringSpec = typeof INSTRUMENTS['violao']['strings'][number];

// ─── Máquina de estados do afinador ────────────────────────────────────────
type Phase =
  | 'no_string'        // Nenhuma corda selecionada (neutro)
  | 'starting_mic'     // Iniciando microfone após primeira seleção
  | 'awaiting_attack'  // Corda selecionada, aguardando o usuário tocar
  | 'listening'        // Sinal detectado na janela da corda, coletando
  | 'guiding'          // Leitura estável → mostrar apertar/afrouxar
  | 'tuned'            // Dentro de ±5¢ por >=400ms
  | 'out_of_range'     // Som detectado, mas não é a corda selecionada
  | 'error';

// ─── Constantes de detecção ────────────────────────────────────────────────
const MIN_ENERGY          = 0.15;  // gate de volume (web + proxy native)
const IN_WINDOW_CENTS     = 400;   // ±4 semitons = mesma corda
const TUNED_CENTS         = 5;     // ±5¢ → afinado
const STABLE_MS           = 250;   // ler estável por 250ms antes de orientar
const TUNED_MS            = 400;   // manter dentro de ±5¢ por 400ms
const SILENCE_MS          = 900;   // após silêncio, volta a "Toque a corda"
const HISTORY_SIZE        = 8;     // janela para mediana/std de cents

// ─── Error Boundary ────────────────────────────────────────────────────────
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
  const tuner = useTuner();

  // ─── Estado principal ────────────────────────────────────────────────────
  const [instrument, setInstrument] = useState<InstrumentKey>('violao');
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>('no_string');
  const [smoothedCents, setSmoothedCents] = useState<number | null>(null);
  const [displayFreq, setDisplayFreq] = useState<number | null>(null);

  // ─── Refs temporais ──────────────────────────────────────────────────────
  const centsHistoryRef    = useRef<number[]>([]);
  const stableStartRef     = useRef<number | null>(null);
  const tunedStartRef      = useRef<number | null>(null);
  const lastSignalTimeRef  = useRef<number | null>(null);
  const lastTunedNameRef   = useRef<string | null>(null);
  const micStartTokenRef   = useRef(0);

  const currentInstrument = INSTRUMENTS[instrument];
  const selectedString: StringSpec | null =
    selectedIdx !== null ? currentInstrument.strings[selectedIdx] : null;

  // ─── Ciclo de vida do microfone ──────────────────────────────────────────
  // Regra: mic só liga se usuário selecionou uma corda. Sem corda → desliga.
  useEffect(() => {
    const token = ++micStartTokenRef.current;
    let cancelled = false;

    (async () => {
      if (selectedString && !tuner.isActive) {
        setPhase('starting_mic');
        try {
          await tuner.start();
        } catch (err) {
          console.warn('[Tuner] start failed:', err);
        }
        if (!cancelled && token === micStartTokenRef.current) {
          setPhase('awaiting_attack');
        }
      } else if (!selectedString && tuner.isActive) {
        await tuner.stop();
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedString?.freq]);

  // Stop mic ao desmontar
  useEffect(() => {
    return () => {
      tuner.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Reset de fase quando muda a corda alvo ─────────────────────────────
  useEffect(() => {
    centsHistoryRef.current = [];
    stableStartRef.current = null;
    tunedStartRef.current = null;
    lastSignalTimeRef.current = null;
    setSmoothedCents(null);
    setDisplayFreq(null);
    if (!selectedString) {
      setPhase('no_string');
    } else if (tuner.isActive) {
      setPhase('awaiting_attack');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedString?.freq]);

  // ─── Loop de análise (50ms) ─────────────────────────────────────────────
  useEffect(() => {
    if (!selectedString || !tuner.isActive) return;

    const interval = setInterval(() => {
      if (tuner.error) { setPhase('error'); return; }
      const now = Date.now();
      const freq = tuner.frequency;
      const noise = tuner.noiseLevel;
      const target = selectedString.freq;

      const hasSignal =
        freq !== null && freq > 30 && freq < 2000 && noise >= MIN_ENERGY;

      // ── Sem sinal → tratar silêncio ────────────────────────────────────
      if (!hasSignal) {
        if (lastSignalTimeRef.current !== null) {
          const silentFor = now - lastSignalTimeRef.current;
          if (silentFor >= SILENCE_MS) {
            centsHistoryRef.current = [];
            stableStartRef.current = null;
            tunedStartRef.current = null;
            lastSignalTimeRef.current = null;
            setSmoothedCents(null);
            setDisplayFreq(null);
            setPhase('awaiting_attack');
          }
        }
        return;
      }

      // ── Sinal presente ─────────────────────────────────────────────────
      lastSignalTimeRef.current = now;

      // Tentar casar com oitava mais próxima da corda-alvo
      // (um harmônico pode chegar com +1200¢; dobra ou metade)
      let adjFreq = freq as number;
      while (adjFreq > target * 1.5) adjFreq /= 2;
      while (adjFreq < target / 1.5) adjFreq *= 2;

      const cents = 1200 * Math.log2(adjFreq / target);

      // ── Fora da janela da corda alvo ───────────────────────────────────
      if (Math.abs(cents) > IN_WINDOW_CENTS) {
        centsHistoryRef.current = [];
        stableStartRef.current = null;
        tunedStartRef.current = null;
        setDisplayFreq(freq);
        setSmoothedCents(null);
        setPhase('out_of_range');
        return;
      }

      // ── Dentro da janela: acumular histórico + suavizar ────────────────
      const hist = centsHistoryRef.current;
      hist.push(cents);
      if (hist.length > HISTORY_SIZE) hist.shift();

      // Mediana = robusta contra outliers
      const sorted = [...hist].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];

      setDisplayFreq(freq);
      setSmoothedCents(median);

      // Precisamos de ao menos 3 leituras para orientar
      if (hist.length < 3) {
        stableStartRef.current = null;
        setPhase('listening');
        return;
      }

      // Desvio padrão para medir estabilidade
      const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
      const variance =
        hist.reduce((a, b) => a + (b - mean) * (b - mean), 0) / hist.length;
      const std = Math.sqrt(variance);
      const isStable = std < 22;

      if (!isStable) {
        stableStartRef.current = null;
        tunedStartRef.current = null;
        setPhase('listening');
        return;
      }

      if (stableStartRef.current === null) stableStartRef.current = now;
      const stableFor = now - stableStartRef.current;
      if (stableFor < STABLE_MS) {
        setPhase('listening');
        return;
      }

      // Estável o suficiente → orientar ou declarar afinado
      if (Math.abs(median) <= TUNED_CENTS) {
        if (tunedStartRef.current === null) tunedStartRef.current = now;
        if (now - tunedStartRef.current >= TUNED_MS) {
          setPhase('tuned');
        } else {
          setPhase('guiding');
        }
      } else {
        tunedStartRef.current = null;
        setPhase('guiding');
      }
    }, 50);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedString?.freq, tuner.frequency, tuner.noiseLevel, tuner.isActive, tuner.error]);

  // ─── Feedback háptico ao afinar ──────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'tuned' || !selectedString) return;
    if (lastTunedNameRef.current === selectedString.name) return;
    lastTunedNameRef.current = selectedString.name;
    (async () => {
      try {
        const Haptics = require('expo-haptics');
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch {}
    })();
  }, [phase, selectedString?.name]);

  // Resetar memória do "último afinado" quando sai do estado tuned
  useEffect(() => {
    if (phase !== 'tuned') lastTunedNameRef.current = null;
  }, [phase]);

  // ─── Status derivado (UI strings + cor + ícone) ─────────────────────────
  const status = useMemo(() => {
    if (tuner.error || phase === 'error') {
      return { msg: tuner.error || 'Erro no microfone', color: C.red, glow: C.redGlow, icon: 'alert-circle' as const };
    }
    if (!selectedString || phase === 'no_string') {
      return { msg: 'Selecione uma corda para começar', color: C.text2, glow: 'transparent', icon: 'musical-notes-outline' as const };
    }
    if (phase === 'starting_mic') {
      return { msg: 'Iniciando microfone…', color: C.text2, glow: 'transparent', icon: 'mic-outline' as const };
    }
    if (phase === 'awaiting_attack') {
      return { msg: 'Toque a corda selecionada', color: C.text2, glow: 'transparent', icon: 'hand-left-outline' as const };
    }
    if (phase === 'out_of_range') {
      return { msg: 'Som fora da corda selecionada', color: C.amber, glow: C.amberGlow, icon: 'warning-outline' as const };
    }
    if (phase === 'listening') {
      return { msg: 'Ouvindo…', color: C.blue, glow: C.blueGlow, icon: 'radio-outline' as const };
    }
    if (phase === 'tuned') {
      return { msg: 'Afinado', color: C.green, glow: C.greenGlow, icon: 'checkmark-circle' as const };
    }
    // guiding
    if (smoothedCents !== null) {
      if (smoothedCents < -TUNED_CENTS) {
        return { msg: 'Apertar um pouco', color: C.blue, glow: C.blueGlow, icon: 'arrow-up-circle' as const };
      }
      if (smoothedCents > TUNED_CENTS) {
        return { msg: 'Afrouxar um pouco', color: C.red, glow: C.redGlow, icon: 'arrow-down-circle' as const };
      }
      return { msg: 'Afinado', color: C.green, glow: C.greenGlow, icon: 'checkmark-circle' as const };
    }
    return { msg: 'Ouvindo…', color: C.text3, glow: 'transparent', icon: 'ellipse-outline' as const };
  }, [phase, smoothedCents, tuner.error, selectedString]);

  // ─── Animações ───────────────────────────────────────────────────────────
  const needleAnim = useRef(new Animated.Value(0)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Ponteiro: só move quando há leitura confiável
  useEffect(() => {
    const showNeedle =
      (phase === 'guiding' || phase === 'tuned') && smoothedCents !== null;
    const normalized = showNeedle
      ? Math.max(-50, Math.min(50, smoothedCents as number)) / 50
      : 0;
    Animated.spring(needleAnim, {
      toValue: normalized,
      friction: 10, tension: 50,
      useNativeDriver: true,
    }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smoothedCents, phase]);

  // Glow quando afinado
  useEffect(() => {
    if (phase === 'tuned') {
      Animated.loop(
        Animated.sequence([
          Animated.timing(glowAnim, { toValue: 0.8, duration: 700, useNativeDriver: true }),
          Animated.timing(glowAnim, { toValue: 0.4, duration: 700, useNativeDriver: true }),
        ])
      ).start();
    } else {
      glowAnim.stopAnimation();
      glowAnim.setValue(0);
    }
  }, [phase, glowAnim]);

  // Pulse sutil contínuo
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.04, duration: 1800, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1.0,  duration: 1800, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulseAnim]);

  // ─── Handlers ────────────────────────────────────────────────────────────
  const handleSelectString = useCallback((idx: number) => {
    setSelectedIdx(prev => (prev === idx ? null : idx));
  }, []);

  const handleSelectInstrument = useCallback((key: InstrumentKey) => {
    // Trocar instrumento desmarca a corda e para o microfone
    setInstrument(key);
    setSelectedIdx(null);
  }, []);

  const handleBack = useCallback(() => {
    tuner.stop();
    router.back();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRetry = useCallback(async () => {
    await tuner.stop();
    await new Promise(r => setTimeout(r, 250));
    if (selectedString) {
      setPhase('starting_mic');
      await tuner.start();
      setPhase('awaiting_attack');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedString?.freq]);

  const needleRotation = needleAnim.interpolate({
    inputRange: [-1, 1],
    outputRange: ['-45deg', '45deg'],
  });

  const centsAbs = smoothedCents !== null ? Math.abs(Math.round(smoothedCents)) : 0;
  const showCentsText =
    (phase === 'guiding' || phase === 'tuned') && smoothedCents !== null;

  // ─── Render ──────────────────────────────────────────────────────────────
  return (
    <View style={ss.container}>
      <LinearGradient
        colors={['#0A0A0F', '#050508', '#0A0A0F']}
        style={StyleSheet.absoluteFill}
      />
      <SafeAreaView style={ss.safe}>
        {/* Header */}
        <View style={ss.header}>
          <TouchableOpacity onPress={handleBack} style={ss.backBtn} testID="tuner-back-btn">
            <Ionicons name="chevron-back" size={24} color={C.white} />
          </TouchableOpacity>
          <View style={ss.headerCenter}>
            <Text style={ss.headerTitle}>Afinador Inteligente</Text>
            <View style={ss.betaBadge}>
              <Text style={ss.betaText}>BETA</Text>
            </View>
          </View>
          <View style={ss.headerRight} />
        </View>

        {/* Instrumentos */}
        <View style={ss.instrumentRow}>
          {(Object.keys(INSTRUMENTS) as InstrumentKey[]).map(key => (
            <TouchableOpacity
              key={key}
              onPress={() => handleSelectInstrument(key)}
              style={[ss.instrumentChip, instrument === key && ss.instrumentChipActive]}
              testID={`tuner-instrument-${key}`}
            >
              <Text style={ss.instrumentEmoji}>{INSTRUMENTS[key].emoji}</Text>
              <Text style={[ss.instrumentText, instrument === key && ss.instrumentTextActive]}>
                {INSTRUMENTS[key].name}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Área principal */}
        <View style={ss.mainArea}>
          {/* Erro de microfone */}
          {tuner.error ? (
            <View style={ss.errorOverlay}>
              <View style={ss.errorIconContainer}>
                <Ionicons name="mic-off" size={48} color={C.red} />
              </View>
              <Text style={ss.errorTextMain}>{tuner.error}</Text>
              <TouchableOpacity style={ss.retryBtn} onPress={handleRetry} testID="tuner-retry-btn">
                <LinearGradient
                  colors={[C.amber, C.amberLight]}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                  style={ss.retryBtnGradient}
                >
                  <Ionicons name="refresh" size={18} color={C.bg} />
                  <Text style={ss.retryBtnText}>Tentar novamente</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          ) : phase === 'starting_mic' ? (
            <View style={ss.loadingContainer}>
              <ActivityIndicator size="large" color={C.amber} />
              <Text style={ss.loadingText}>Iniciando microfone…</Text>
            </View>
          ) : (
            <>
              {/* Medidor */}
              <View style={ss.meterContainer}>
                <View style={ss.outerRing}>
                  {[-40, -20, 0, 20, 40].map(val => (
                    <View
                      key={val}
                      style={[ss.tickMark, { transform: [{ rotate: `${val * 0.9}deg` }] }]}
                    >
                      <View style={[ss.tickLine, val === 0 && ss.tickLineCenter]} />
                    </View>
                  ))}

                  <Animated.View
                    style={[
                      ss.needleContainer,
                      { transform: [{ rotate: needleRotation }] },
                      (phase !== 'guiding' && phase !== 'tuned') && { opacity: 0.25 },
                    ]}
                  >
                    <LinearGradient colors={[status.color, 'transparent']} style={ss.needle} />
                  </Animated.View>

                  <Animated.View
                    style={[
                      ss.centerGlow,
                      {
                        backgroundColor: status.glow,
                        opacity: phase === 'tuned' ? glowAnim : 0.2,
                      },
                    ]}
                  />
                  <View style={[ss.centerDot, { backgroundColor: status.color }]} />
                </View>

                {/* Nota alvo no centro */}
                <View style={ss.noteDisplay}>
                  <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
                    <Text style={[
                      ss.noteText,
                      { color: selectedString ? C.white : C.text3 },
                    ]} testID="tuner-target-note">
                      {selectedString ? selectedString.note : '—'}
                    </Text>
                  </Animated.View>
                  {selectedString && (
                    <Text style={ss.octaveText}>{selectedString.octave}</Text>
                  )}
                </View>
              </View>

              {/* Frequência captada */}
              <View style={ss.freqContainer}>
                <Text style={ss.freqLabel}>FREQUÊNCIA</Text>
                <Text style={ss.freqValue} testID="tuner-frequency-display">
                  {displayFreq && (phase === 'guiding' || phase === 'tuned' || phase === 'listening')
                    ? `${displayFreq.toFixed(1)} Hz`
                    : '— Hz'}
                  {selectedString && (
                    <Text style={ss.freqTarget}>  · alvo {selectedString.freq.toFixed(1)} Hz</Text>
                  )}
                </Text>
              </View>

              {/* Status card */}
              <View
                style={[
                  ss.statusCard,
                  { borderColor: status.color === C.text2 || status.color === C.text3 ? C.border : status.color },
                ]}
                testID="tuner-status-card"
              >
                <View style={[ss.statusGlow, { backgroundColor: status.glow }]} />
                <Ionicons name={status.icon} size={26} color={status.color} />
                <Text style={[ss.statusText, { color: status.color }]} testID="tuner-status-text">
                  {status.msg}
                </Text>
                {showCentsText && (
                  <Text style={ss.centsText}>
                    {(smoothedCents as number) > 0 ? '+' : ''}
                    {Math.round(smoothedCents as number)}¢
                    {centsAbs <= TUNED_CENTS ? '' : ''}
                  </Text>
                )}
              </View>

              {/* Seta animada quando nenhuma corda escolhida */}
              {phase === 'no_string' && (
                <View style={ss.arrowHint}>
                  <Ionicons name="arrow-down" size={18} color={C.amber} />
                  <Text style={ss.arrowHintText}>Escolha uma corda abaixo</Text>
                </View>
              )}
            </>
          )}
        </View>

        {/* Cordas */}
        <View style={ss.stringsSection}>
          <Text style={ss.stringsTitle}>CORDAS · {currentInstrument.name.toUpperCase()}</Text>
          <View style={ss.stringsGrid}>
            {currentInstrument.strings.map((str, idx) => {
              const isSelected = selectedIdx === idx;
              const isTuned = isSelected && phase === 'tuned';
              return (
                <TouchableOpacity
                  key={`${str.note}-${str.octave}-${idx}`}
                  onPress={() => handleSelectString(idx)}
                  activeOpacity={0.8}
                  style={[
                    ss.stringCard,
                    isSelected && ss.stringCardActive,
                    isTuned && ss.stringCardPerfect,
                  ]}
                  testID={`tuner-string-${idx}`}
                >
                  <Text style={[
                    ss.stringNote,
                    isSelected && ss.stringNoteActive,
                    isTuned && ss.stringNotePerfect,
                  ]}>
                    {str.note}
                    <Text style={ss.stringOctave}>{str.octave}</Text>
                  </Text>
                  <Text style={ss.stringFreq}>{str.freq.toFixed(0)} Hz</Text>
                  {isTuned && (
                    <View style={ss.checkBadge}>
                      <Ionicons name="checkmark" size={12} color={C.bg} />
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Footer */}
        <View style={ss.footer}>
          <Ionicons name="information-circle-outline" size={13} color={C.text3} />
          <Text style={ss.footerText}>
            {selectedString
              ? 'Toque a corda selecionada · Estável por 250ms para orientar'
              : 'Escolha o instrumento e depois a corda que deseja afinar'}
          </Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

const ss = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  safe: { flex: 1 },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: C.surface,
    alignItems: 'center', justifyContent: 'center',
  },
  headerCenter: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: C.white, letterSpacing: -0.3 },
  betaBadge: {
    backgroundColor: 'rgba(255,176,32,0.15)', borderWidth: 1, borderColor: C.amber,
    borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2,
  },
  betaText: { fontSize: 9, fontWeight: '700', color: C.amber, letterSpacing: 1 },
  headerRight: { width: 40, height: 40 },

  instrumentRow: {
    flexDirection: 'row', justifyContent: 'center', gap: 8,
    paddingHorizontal: 16, paddingBottom: 16,
  },
  instrumentChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20,
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
  instrumentChipActive: { backgroundColor: 'rgba(255,176,32,0.1)', borderColor: C.amber },
  instrumentEmoji: { fontSize: 14 },
  instrumentText: { fontSize: 12, fontWeight: '500', color: C.text2 },
  instrumentTextActive: { color: C.amber },

  mainArea: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },

  loadingContainer: { alignItems: 'center', gap: 16 },
  loadingText: { fontSize: 14, color: C.text2 },

  errorOverlay: { alignItems: 'center', gap: 16 },
  errorIconContainer: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: 'rgba(239,68,68,0.1)',
    alignItems: 'center', justifyContent: 'center',
  },
  errorTextMain: { fontSize: 14, color: C.text2, textAlign: 'center', maxWidth: 280 },
  retryBtn: { borderRadius: 25, overflow: 'hidden', marginTop: 8 },
  retryBtnGradient: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 24, paddingVertical: 14,
  },
  retryBtnText: { fontSize: 14, fontWeight: '600', color: C.bg },

  meterContainer: {
    width: 240, height: 240, alignItems: 'center', justifyContent: 'center',
    marginBottom: 24,
  },
  outerRing: {
    width: 200, height: 200, borderRadius: 100, borderWidth: 3, borderColor: C.border,
    alignItems: 'center', justifyContent: 'center', backgroundColor: C.surface,
  },
  tickMark: { position: 'absolute', top: 8, width: 2, height: 20, alignItems: 'center' },
  tickLine: { width: 2, height: 12, backgroundColor: C.text3, borderRadius: 1 },
  tickLineCenter: { height: 16, backgroundColor: C.amber },
  needleContainer: { position: 'absolute', top: 20, width: 4, height: 80, alignItems: 'center' },
  needle: { width: 4, height: 70, borderRadius: 2 },
  centerGlow: { position: 'absolute', width: 80, height: 80, borderRadius: 40 },
  centerDot: { position: 'absolute', width: 20, height: 20, borderRadius: 10 },
  noteDisplay: { position: 'absolute', flexDirection: 'row', alignItems: 'baseline' },
  noteText: { fontSize: 64, fontWeight: '800', letterSpacing: -2 },
  octaveText: { fontSize: 24, fontWeight: '600', color: C.text2, marginLeft: 4 },

  freqContainer: { alignItems: 'center', marginBottom: 18 },
  freqLabel: { fontSize: 10, fontWeight: '600', color: C.text3, letterSpacing: 2, marginBottom: 4 },
  freqValue: { fontSize: 16, fontWeight: '500', color: C.text2, fontVariant: ['tabular-nums'] },
  freqTarget: { fontSize: 13, color: C.text3 },

  statusCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 22, paddingVertical: 14, borderRadius: 16,
    backgroundColor: C.surface, borderWidth: 2, minWidth: 260,
    justifyContent: 'center', overflow: 'hidden',
  },
  statusGlow: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0.08,
  },
  statusText: { fontSize: 17, fontWeight: '700', letterSpacing: 0.3 },
  centsText: { fontSize: 12, color: C.text3, fontVariant: ['tabular-nums'] },

  arrowHint: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14,
  },
  arrowHintText: { fontSize: 12, color: C.amber, fontWeight: '500' },

  stringsSection: { paddingHorizontal: 16, paddingBottom: 16 },
  stringsTitle: {
    fontSize: 10, fontWeight: '600', color: C.text3, letterSpacing: 2,
    textAlign: 'center', marginBottom: 12,
  },
  stringsGrid: {
    flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: 8,
  },
  stringCard: {
    alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: 12, backgroundColor: C.surface,
    borderWidth: 1, borderColor: C.border, minWidth: 54,
  },
  stringCardActive: {
    borderColor: C.amber,
    backgroundColor: 'rgba(255,176,32,0.12)',
    transform: [{ scale: 1.05 }],
  },
  stringCardPerfect: {
    borderColor: C.green,
    backgroundColor: 'rgba(16,185,129,0.12)',
  },
  stringNote: { fontSize: 18, fontWeight: '700', color: C.text2 },
  stringNoteActive: { color: C.amber },
  stringNotePerfect: { color: C.green },
  stringOctave: { fontSize: 12, fontWeight: '500' },
  stringFreq: { fontSize: 9, color: C.text3, marginTop: 2 },
  checkBadge: {
    position: 'absolute', top: -4, right: -4,
    width: 16, height: 16, borderRadius: 8, backgroundColor: C.green,
    alignItems: 'center', justifyContent: 'center',
  },

  footer: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 12, paddingHorizontal: 20,
  },
  footerText: { fontSize: 11, color: C.text3, textAlign: 'center', flexShrink: 1 },

  errorContainer: {
    flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16,
  },
  errorTitle: { fontSize: 24, fontWeight: '700', color: C.white },
  errorMessage: { fontSize: 14, color: C.text2, textAlign: 'center' },
  errorButton: {
    backgroundColor: C.amber, paddingHorizontal: 32, paddingVertical: 14,
    borderRadius: 25, marginTop: 16,
  },
  errorButtonText: { fontSize: 15, fontWeight: '600', color: C.bg },
});
