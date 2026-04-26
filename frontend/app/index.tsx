import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated, Dimensions,
  Easing, Platform, Modal, ScrollView, Linking, Alert, ActivityIndicator, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Updates from 'expo-updates';
import { LinearGradient } from 'expo-linear-gradient';

import { useKeyDetection } from '../src/hooks/useKeyDetection';
import { NOTES_BR, NOTES_INTL, formatKeyDisplay, getHarmonicField } from '../src/utils/noteUtils';
import { useAuth } from '../src/auth/AuthContext';

const { width: SW, height: SH } = Dimensions.get('window');

const C = {
  bg: '#0A0A0A', surface: '#0E0E0E', surface2: '#141414',
  border: '#1C1C1C', borderStrong: '#2A2A2A',
  amber: '#FFB020', amberSoft: '#FFC966', amberDeep: '#A26800',
  amberGlow: 'rgba(255,176,32,0.45)',
  amberMuted: 'rgba(255,176,32,0.10)', amberBorder: 'rgba(255,176,32,0.32)',
  white: '#FFFFFF', text2: '#A0A0A0', text3: '#5A5A5A', text4: '#3A3A3A',
  red: '#EF4444', redMuted: 'rgba(239,68,68,0.12)',
  green: '#22C55E', blue: '#60A5FA',
};

// ═════════════════════════════════════════════════════════════════════════
// HOME SCREEN — Tela única unificada (idle + active no mesmo layout premium)
// ═════════════════════════════════════════════════════════════════════════
export default function HomeScreen() {
  const det = useKeyDetection();
  return (
    <SafeAreaView testID="home-screen" style={ss.safe}>
      <PremiumScreen det={det} />
    </SafeAreaView>
  );
}

// ═════════════════════════════════════════════════════════════════════════
// PREMIUM SCREEN — segue exatamente a referência visual
// ═════════════════════════════════════════════════════════════════════════
function PremiumScreen({ det }: { det: ReturnType<typeof useKeyDetection> }) {
  const { logout, session } = useAuth();
  const {
    currentNote, audioLevel, isRunning, errorMessage, errorReason,
    softReset, reset, mlResult, recentNotes, changeSuggestion,
  } = det;

  const [errorModalVisible, setErrorModalVisible] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const prevErr = useRef<string | null>(null);

  // OTA auto-check no startup
  useEffect(() => {
    if (Platform.OS === 'web' || !Updates.isEnabled) return;
    let mounted = true;
    (async () => {
      try {
        const res = await Updates.checkForUpdateAsync();
        if (res.isAvailable && mounted) {
          await Updates.fetchUpdateAsync();
          if (mounted) await Updates.reloadAsync();
        }
      } catch { /* silencioso */ }
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (errorMessage && errorMessage !== prevErr.current) setErrorModalVisible(true);
    prevErr.current = errorMessage;
  }, [errorMessage]);

  const onCheckUpdate = async () => {
    if (checkingUpdate) return;
    if (Platform.OS === 'web' || !Updates.isEnabled) {
      Alert.alert('Atualização', 'A busca de atualizações só funciona no aplicativo instalado.');
      return;
    }
    setCheckingUpdate(true);
    try {
      const res = await Updates.checkForUpdateAsync();
      if (res.isAvailable) {
        await Updates.fetchUpdateAsync();
        Alert.alert('Atualização baixada', 'Nova versão baixada! O app vai reiniciar agora.',
          [{ text: 'Reiniciar', onPress: () => Updates.reloadAsync().catch(() => {}) }]);
      } else {
        Alert.alert('Você está em dia', 'Versão mais recente já instalada.');
      }
    } catch (e: any) {
      Alert.alert('Falha ao buscar atualização', e?.message ? String(e.message) : 'Verifique sua conexão.');
    } finally {
      setCheckingUpdate(false);
    }
  };

  // ═══════════════════════════════════════════════════════════════
  // ESTRATÉGIA "TOM SEGURO" v6 — só mostra tom quando há ALTA confiança
  // ═══════════════════════════════════════════════════════════════
  const MIN_INDIVIDUAL_CONF = 0.60;
  const MIN_CONFIRM_CONF = 0.70;
  const FAST_CONFIRM_CONF = 0.80;
  const LOCK_WINDOW_SIZE = 3;

  const lockedKeyRef = useRef<{ tonic: number; quality: 'major' | 'minor'; key_name: string; confidence: number; at: number } | null>(null);
  const lockWindowRef = useRef<Array<{ tonic: number; quality: 'major' | 'minor'; confidence: number }>>([]);
  const [lockedKeyTick, setLockedKeyTick] = useState(0);

  useEffect(() => {
    if (!mlResult?.success || mlResult.tonic === undefined || !mlResult.quality) return;
    const conf = mlResult.confidence ?? 0;
    const tonic = mlResult.tonic;
    const quality = mlResult.quality as 'major' | 'minor';
    const keyName = mlResult.key_name || '';

    if (lockedKeyRef.current) return;

    if (conf >= FAST_CONFIRM_CONF) {
      lockedKeyRef.current = { tonic, quality, key_name: keyName, confidence: conf, at: Date.now() };
      setLockedKeyTick(t => t + 1);
      return;
    }

    if (conf < MIN_INDIVIDUAL_CONF) return;

    lockWindowRef.current = [
      ...lockWindowRef.current.slice(-(LOCK_WINDOW_SIZE - 1)),
      { tonic, quality, confidence: conf },
    ];

    const counts = new Map<string, { count: number; sumConf: number; tonic: number; quality: 'major' | 'minor' }>();
    for (const r of lockWindowRef.current) {
      const k = `${r.tonic}-${r.quality}`;
      const e = counts.get(k) || { count: 0, sumConf: 0, tonic: r.tonic, quality: r.quality };
      e.count += 1; e.sumConf += r.confidence;
      counts.set(k, e);
    }
    let bestEntry: { count: number; sumConf: number; tonic: number; quality: 'major' | 'minor' } | null = null;
    for (const v of counts.values()) {
      if (!bestEntry || v.count > bestEntry.count ||
          (v.count === bestEntry.count && v.sumConf > bestEntry.sumConf)) bestEntry = v;
    }
    if (!bestEntry) return;
    const avgConf = bestEntry.sumConf / bestEntry.count;
    if (bestEntry.count >= 2 && avgConf >= MIN_CONFIRM_CONF) {
      lockedKeyRef.current = {
        tonic: bestEntry.tonic, quality: bestEntry.quality, key_name: keyName,
        confidence: avgConf, at: Date.now(),
      };
      setLockedKeyTick(t => t + 1);
    }
  }, [mlResult?.confidence, mlResult?.tonic, mlResult?.quality, mlResult?.success]);

  useEffect(() => {
    if (!isRunning) {
      lockedKeyRef.current = null;
      lockWindowRef.current = [];
      setLockedKeyTick(t => t + 1);
    }
  }, [isRunning]);

  // 🔄 Restart Detection — limpa estado SEM parar o microfone
  const restartDetection = useCallback(async () => {
    lockedKeyRef.current = null;
    lockWindowRef.current = [];
    setLockedKeyTick(t => t + 1);
    try { await softReset(); } catch { /* tolerado */ }
  }, [softReset]);

  // ═══════════════════════════════════════════════════════════════
  // MÁQUINA DE ESTADOS — só status, nunca tom provisório
  // ═══════════════════════════════════════════════════════════════
  type Stage = 'idle' | 'listening' | 'analyzing' | 'needs_more' | 'confirmed';
  const [analysisCount, setAnalysisCount] = useState(0);

  useEffect(() => {
    if (mlResult?.success) setAnalysisCount(c => c + 1);
  }, [mlResult]);
  useEffect(() => { if (!isRunning) setAnalysisCount(0); }, [isRunning]);

  const stage: Stage = useMemo(() => {
    if (lockedKeyRef.current) return 'confirmed';
    if (!isRunning) return 'idle';
    const flags = mlResult?.flags || [];
    if (flags.includes('few_notes') || flags.includes('single_phrase')) return 'needs_more';
    if (analysisCount === 0) return 'listening';
    return 'analyzing';
  }, [isRunning, analysisCount, mlResult?.flags, lockedKeyTick]);

  const confirmedKey = lockedKeyRef.current
    ? { root: lockedKeyRef.current.tonic, quality: lockedKeyRef.current.quality }
    : null;

  // Status text grande (abaixo do mic button)
  const statusBig = useMemo(() => {
    switch (stage) {
      case 'idle': return 'INICIAR DETECÇÃO';
      case 'listening': return 'OUVINDO...';
      case 'analyzing': return 'ANALISANDO...';
      case 'needs_more': return 'CANTE MAIS UM POUCO...';
      case 'confirmed': return 'TOM DETECTADO';
    }
  }, [stage]);

  const handleMicPress = useCallback(async () => {
    if (isRunning) return; // Já está rodando, não faz nada (evita parar acidentalmente)
    await det.start();
  }, [isRunning, det.start]);

  const handleStop = useCallback(() => { reset(); }, [reset]);

  // ═══════════════════════════════════════════════════════════════
  // ANIMAÇÕES
  // ═══════════════════════════════════════════════════════════════
  const fadeIn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 320, useNativeDriver: true }).start();
  }, []);

  return (
    <Animated.View style={[ss.root, { opacity: fadeIn }]}>
      {/* Background gradient subtle */}
      <LinearGradient
        colors={['#0A0A0A', '#0F0A05', '#0A0A0A']}
        locations={[0, 0.5, 1]}
        style={StyleSheet.absoluteFill}
      />

      {/* ─────────── HEADER (logo + título + subtítulo) ─────────── */}
      <View style={ss.header}>
        <Image
          source={require('../assets/images/logo.png')}
          style={ss.logoTop}
          resizeMode="contain"
        />
        <Text style={ss.brandTitle}>
          <Text style={ss.brandTitleThin}>Tom </Text>
          <Text style={ss.brandTitleBold}>Certo</Text>
        </Text>
        <Text style={ss.brandSub}>DETECTOR DE TONALIDADE</Text>
      </View>

      {/* ─────────── MIC SECTION (centro, com ondas + pulsos + partículas) ─────────── */}
      <View style={ss.micSection}>
        <SideWaves side="left" active={isRunning} />
        <SideWaves side="right" active={isRunning} />
        <Particles active={isRunning} />
        <PulseRings stage={stage} />
        <MicButton
          stage={stage}
          confirmedKey={confirmedKey}
          audioLevel={audioLevel}
          onPress={handleMicPress}
        />
      </View>

      {/* ─────────── STATUS + KEY DETECTED INFO ─────────── */}
      <View style={ss.statusArea}>
        {stage === 'confirmed' && confirmedKey ? (
          <ConfirmedStatus
            confirmedKey={confirmedKey}
            confidence={lockedKeyRef.current?.confidence ?? 0}
            onRestart={restartDetection}
            onStop={handleStop}
          />
        ) : (
          <Text style={[
            ss.statusBig,
            stage === 'idle' && ss.statusBigIdle,
            stage === 'needs_more' && ss.statusBigAmber,
          ]}>
            {statusBig}
          </Text>
        )}
      </View>

      {/* ─────────── BOTTOM (frase + linha decorativa) ─────────── */}
      <View style={ss.bottomBlock}>
        <View style={ss.goldLine} />
        <Text style={ss.tagline}>
          <Text style={ss.taglineWhite}>Detecção inteligente. </Text>
          <Text style={ss.taglineGold}>Resultado preciso.</Text>
        </Text>
      </View>

      {/* ─────────── FOOTER ICONS (settings + info) ─────────── */}
      <View style={ss.footerIcons}>
        <TouchableOpacity
          testID="settings-btn"
          onPress={() => setSettingsOpen(true)}
          style={ss.footerIconBtn}
          activeOpacity={0.6}
        >
          <Ionicons name="options-outline" size={20} color={C.amber} />
        </TouchableOpacity>
        <TouchableOpacity
          testID="info-btn"
          onPress={() => setInfoOpen(true)}
          style={ss.footerIconBtn}
          activeOpacity={0.6}
        >
          <Ionicons name="information-circle-outline" size={22} color={C.amber} />
        </TouchableOpacity>
      </View>

      {/* Erro de mic (modal) */}
      <MicNoticeModal
        visible={errorModalVisible}
        onClose={() => setErrorModalVisible(false)}
        onRetry={() => { setErrorModalVisible(false); det.start(); }}
        reason={errorReason}
        message={errorMessage}
      />

      {/* Settings Modal */}
      <SettingsModal
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onLogout={logout}
        onCheckUpdate={onCheckUpdate}
        checkingUpdate={checkingUpdate}
        customerName={session?.customer_name}
      />

      {/* Info Modal */}
      <InfoModal
        visible={infoOpen}
        onClose={() => setInfoOpen(false)}
      />
    </Animated.View>
  );
}

// ═════════════════════════════════════════════════════════════════════════
// MIC BUTTON — circular, dourado, glow + reage ao audioLevel
// ═════════════════════════════════════════════════════════════════════════
function MicButton({
  stage, confirmedKey, audioLevel, onPress,
}: {
  stage: 'idle' | 'listening' | 'analyzing' | 'needs_more' | 'confirmed';
  confirmedKey: { root: number; quality: 'major' | 'minor' } | null;
  audioLevel: number;
  onPress: () => void;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const breathe = useRef(new Animated.Value(0)).current;

  // Breathe loop (mais intenso quando ativo)
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(breathe, { toValue: 1, duration: 1800, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(breathe, { toValue: 0, duration: 1800, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);

  const breatheScale = breathe.interpolate({ inputRange: [0, 1], outputRange: [1, stage === 'idle' ? 1.04 : 1.07] });
  const audioBoost = 1 + Math.min(audioLevel * 0.18, 0.18);

  const onPressIn = () => Animated.spring(scale, { toValue: 0.93, useNativeDriver: true }).start();
  const onPressOut = () => Animated.spring(scale, { toValue: 1, friction: 4, useNativeDriver: true }).start();

  const isConfirmed = stage === 'confirmed' && confirmedKey;

  return (
    <Animated.View style={{ transform: [{ scale: Animated.multiply(scale, breatheScale) }] }}>
      {/* Outer glow halo */}
      <View style={ss.micGlow} pointerEvents="none">
        <LinearGradient
          colors={['rgba(255,176,32,0)', 'rgba(255,176,32,0.32)', 'rgba(255,176,32,0)']}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={StyleSheet.absoluteFill}
        />
      </View>
      <TouchableOpacity
        testID={isConfirmed ? 'mic-confirmed' : (stage === 'idle' ? 'start-btn' : 'mic-active')}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        onPress={onPress}
        activeOpacity={1}
        disabled={stage === 'confirmed'}
      >
        {/* Mic Outer Ring (golden border) */}
        <View style={[ss.micOuter, { transform: [{ scale: audioBoost }] }]}>
          {/* Inner Black Disk */}
          <LinearGradient
            colors={['#1A1209', '#0A0A0A']}
            style={ss.micInner}
          >
            {/* Conteúdo central muda por estado */}
            {isConfirmed && confirmedKey ? (
              <KeyLetterDisplay confirmedKey={confirmedKey} />
            ) : (
              <Ionicons
                name="mic"
                size={64}
                color={C.amber}
              />
            )}
          </LinearGradient>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

function KeyLetterDisplay({ confirmedKey }: { confirmedKey: { root: number; quality: 'major' | 'minor' } }) {
  const k = formatKeyDisplay(confirmedKey.root, confirmedKey.quality);
  return (
    <View style={{ alignItems: 'center' }}>
      <Text style={ss.keyLetter}>{k.noteIntl}</Text>
      <Text style={ss.keyQual}>{confirmedKey.quality === 'major' ? 'MAIOR' : 'MENOR'}</Text>
    </View>
  );
}

// ═════════════════════════════════════════════════════════════════════════
// PULSE RINGS — 3 anéis concêntricos expandindo continuamente
// ═════════════════════════════════════════════════════════════════════════
function PulseRings({ stage }: { stage: 'idle' | 'listening' | 'analyzing' | 'needs_more' | 'confirmed' }) {
  const r1 = useRef(new Animated.Value(0)).current;
  const r2 = useRef(new Animated.Value(0)).current;
  const r3 = useRef(new Animated.Value(0)).current;
  // Mais rápido quando ativo, mais lento quando idle, parado quando confirmado
  const dur = stage === 'confirmed' ? 0 : (stage === 'idle' ? 2400 : 1700);
  useEffect(() => {
    if (stage === 'confirmed') return;
    const make = (val: Animated.Value, delay: number) =>
      Animated.loop(Animated.sequence([
        Animated.delay(delay),
        Animated.timing(val, { toValue: 1, duration: dur, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(val, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]));
    const a1 = make(r1, 0), a2 = make(r2, dur / 3), a3 = make(r3, (dur * 2) / 3);
    a1.start(); a2.start(); a3.start();
    return () => { a1.stop(); a2.stop(); a3.stop(); };
  }, [stage, dur]);

  if (stage === 'confirmed') return null;
  const renderRing = (val: Animated.Value) => (
    <Animated.View style={[
      ss.pulseRing,
      {
        opacity: val.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0.6, 0.3, 0] }),
        transform: [{ scale: val.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }) }],
      },
    ]} />
  );
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={ss.pulseCenter}>
        {renderRing(r3)}
        {renderRing(r2)}
        {renderRing(r1)}
      </View>
    </View>
  );
}

// ═════════════════════════════════════════════════════════════════════════
// SIDE WAVES — barras animadas nas laterais (efeito de áudio)
// ═════════════════════════════════════════════════════════════════════════
const WAVE_BARS = 14;
function SideWaves({ side, active }: { side: 'left' | 'right'; active: boolean }) {
  const anims = useRef(Array.from({ length: WAVE_BARS }, () => new Animated.Value(Math.random()))).current;

  useEffect(() => {
    const loops = anims.map((val, i) => {
      const dur = 600 + Math.random() * 800;
      return Animated.loop(Animated.sequence([
        Animated.timing(val, { toValue: 1, duration: dur, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
        Animated.timing(val, { toValue: 0, duration: dur, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
      ]));
    });
    loops.forEach(l => l.start());
    return () => loops.forEach(l => l.stop());
  }, []);

  return (
    <View style={[ss.sideWaves, side === 'left' ? ss.sideWavesLeft : ss.sideWavesRight]} pointerEvents="none">
      {anims.map((val, i) => {
        // Onda senoidal de altura (mais alta no centro)
        const centerWeight = 1 - Math.abs((i - WAVE_BARS / 2) / (WAVE_BARS / 2));
        const height = val.interpolate({
          inputRange: [0, 1],
          outputRange: [3 + centerWeight * 8, 18 + centerWeight * 38],
        });
        const opacity = val.interpolate({
          inputRange: [0, 1],
          outputRange: [active ? 0.18 : 0.10, active ? 0.55 : 0.28],
        });
        return (
          <Animated.View
            key={i}
            style={[ss.waveBar, { height, opacity }]}
          />
        );
      })}
    </View>
  );
}

// ═════════════════════════════════════════════════════════════════════════
// PARTICLES — pontos luminosos que orbitam o mic button (efeito IA)
// ═════════════════════════════════════════════════════════════════════════
const PARTICLE_COUNT = 14;
function Particles({ active }: { active: boolean }) {
  const items = useRef(
    Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
      angle: (i / PARTICLE_COUNT) * Math.PI * 2 + Math.random() * 0.4,
      radius: 130 + Math.random() * 28,
      val: new Animated.Value(Math.random()),
      size: 2 + Math.random() * 2.5,
      dur: 1800 + Math.random() * 1600,
    }))
  ).current;

  useEffect(() => {
    const loops = items.map(p =>
      Animated.loop(Animated.sequence([
        Animated.timing(p.val, { toValue: 1, duration: p.dur, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(p.val, { toValue: 0, duration: p.dur, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]))
    );
    loops.forEach(l => l.start());
    return () => loops.forEach(l => l.stop());
  }, []);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={ss.particlesCenter}>
        {items.map((p, i) => {
          const x = Math.cos(p.angle) * p.radius;
          const y = Math.sin(p.angle) * p.radius;
          const opacity = p.val.interpolate({ inputRange: [0, 0.5, 1], outputRange: [active ? 0.2 : 0.12, active ? 0.85 : 0.45, active ? 0.2 : 0.12] });
          const tx = p.val.interpolate({ inputRange: [0, 1], outputRange: [x, x * 1.06] });
          const ty = p.val.interpolate({ inputRange: [0, 1], outputRange: [y, y * 1.06] });
          return (
            <Animated.View
              key={i}
              style={[
                ss.particle,
                { width: p.size, height: p.size, opacity, transform: [{ translateX: tx }, { translateY: ty }] },
              ]}
            />
          );
        })}
      </View>
    </View>
  );
}

// ═════════════════════════════════════════════════════════════════════════
// CONFIRMED STATUS — exibe quando tom é detectado (elegant, com botão de reset)
// ═════════════════════════════════════════════════════════════════════════
function ConfirmedStatus({
  confirmedKey, confidence, onRestart, onStop,
}: {
  confirmedKey: { root: number; quality: 'major' | 'minor' };
  confidence: number;
  onRestart: () => void;
  onStop: () => void;
}) {
  const k = formatKeyDisplay(confirmedKey.root, confirmedKey.quality);
  const pct = Math.round(confidence * 100);
  return (
    <View style={ss.confirmedBlock}>
      <View style={ss.confirmedKeyRow}>
        <View style={ss.confirmedDot} />
        <Text style={ss.confirmedLabel}>TOM DETECTADO</Text>
      </View>
      <Text style={ss.confirmedKeyName}>
        {k.noteBr} <Text style={ss.confirmedKeyQual}>{k.qualityLabel}</Text>
      </Text>
      <Text style={ss.confirmedConfidence}>Confiança: {pct}%</Text>
      <View style={ss.confirmedActions}>
        <TouchableOpacity
          testID="restart-detection-btn"
          style={ss.restartBtn}
          onPress={onRestart}
          activeOpacity={0.7}
        >
          <Ionicons name="refresh" size={16} color={C.amber} />
          <Text style={ss.restartBtnTxt}>Detectar Novo Tom</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="stop-detection-btn"
          style={ss.stopBtn}
          onPress={onStop}
          activeOpacity={0.7}
        >
          <Ionicons name="stop" size={14} color={C.text2} />
          <Text style={ss.stopBtnTxt}>Parar</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ═════════════════════════════════════════════════════════════════════════
// MIC NOTICE MODAL (permissões etc)
// ═════════════════════════════════════════════════════════════════════════
function MicNoticeModal({ visible, onClose, onRetry, reason, message }: {
  visible: boolean; onClose: () => void; onRetry: () => void;
  reason: string | null; message: string | null;
}) {
  const isBlocked = reason === 'permission_blocked';
  const isPerm = reason === 'permission_denied' || isBlocked;
  const isLimit = reason === 'platform_limit';
  const icon: any = isPerm ? 'mic-off' : isLimit ? 'construct-outline' : 'information-circle';
  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={ss.modalBg}>
        <View style={ss.modalCard}>
          <Ionicons name={icon} size={38} color={C.amber} style={{ marginBottom: 12 }} />
          <Text style={ss.modalTitle}>
            {isPerm ? 'Microfone bloqueado' : isLimit ? 'Recurso nativo' : 'Aviso'}
          </Text>
          <Text style={ss.modalMsg}>{message ?? 'Algo deu errado.'}</Text>
          <View style={{ height: 20 }} />
          {isBlocked && Platform.OS !== 'web' ? (
            <TouchableOpacity style={[ss.modalPrimary, { width: '100%', marginBottom: 8 }]}
              onPress={async () => { try { await Linking.openSettings(); } catch {} }}
              activeOpacity={0.85}>
              <Text style={ss.modalPrimaryTxt}>Abrir Configurações</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={[ss.modalPrimary, { width: '100%', marginBottom: 8 }]}
              onPress={onRetry} activeOpacity={0.85}>
              <Text style={ss.modalPrimaryTxt}>{isPerm ? 'Permitir Microfone' : 'Tentar novamente'}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={onClose} style={ss.modalSecondary}>
            <Text style={ss.modalSecondaryTxt}>Fechar</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ═════════════════════════════════════════════════════════════════════════
// SETTINGS MODAL — sair, buscar atualização
// ═════════════════════════════════════════════════════════════════════════
function SettingsModal({ visible, onClose, onLogout, onCheckUpdate, checkingUpdate, customerName }: {
  visible: boolean; onClose: () => void; onLogout: () => void;
  onCheckUpdate: () => void; checkingUpdate: boolean; customerName?: string;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={ss.modalBg}>
        <View style={ss.modalCard}>
          <Ionicons name="settings-sharp" size={36} color={C.amber} style={{ marginBottom: 8 }} />
          <Text style={ss.modalTitle}>Configurações</Text>
          {customerName ? <Text style={ss.modalSubName}>Logado como {customerName}</Text> : null}
          <View style={{ height: 16, width: '100%' }} />

          <TouchableOpacity onPress={onCheckUpdate} style={ss.settingsItem} activeOpacity={0.7}>
            {checkingUpdate
              ? <ActivityIndicator size={16} color={C.amber} />
              : <Ionicons name="refresh-outline" size={18} color={C.amber} />}
            <Text style={ss.settingsItemTxt}>{checkingUpdate ? 'Buscando...' : 'Buscar atualização'}</Text>
            <Ionicons name="chevron-forward" size={14} color={C.text3} />
          </TouchableOpacity>

          <TouchableOpacity
            testID="logout-btn"
            onPress={() => { onClose(); onLogout(); }}
            style={ss.settingsItem}
            activeOpacity={0.7}
          >
            <Ionicons name="log-out-outline" size={18} color={C.red} />
            <Text style={[ss.settingsItemTxt, { color: C.red }]}>Sair da conta</Text>
            <Ionicons name="chevron-forward" size={14} color={C.text3} />
          </TouchableOpacity>

          <View style={{ height: 12 }} />
          <TouchableOpacity onPress={onClose} style={ss.modalSecondary}>
            <Text style={ss.modalSecondaryTxt}>Fechar</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ═════════════════════════════════════════════════════════════════════════
// INFO MODAL — sobre o app, versão
// ═════════════════════════════════════════════════════════════════════════
function InfoModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const versionTag = `${(Updates.updateId ?? 'embedded').slice(0, 8)}`;
  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={ss.modalBg}>
        <View style={ss.modalCard}>
          <Ionicons name="musical-note" size={36} color={C.amber} style={{ marginBottom: 8 }} />
          <Text style={ss.modalTitle}>Tom Certo</Text>
          <Text style={ss.modalSubName}>Detector de Tonalidade Inteligente</Text>
          <View style={{ height: 14 }} />
          <Text style={ss.modalMsg}>
            Tecnologia de IA para identificar a tonalidade da sua voz em tempo real.
            Cante uma melodia ou um trecho da música — o app analisa o centro tonal
            com precisão profissional.
          </Text>
          <View style={{ height: 12 }} />
          <Text style={ss.versionTag}>Versão {versionTag}</Text>
          <View style={{ height: 14 }} />
          <TouchableOpacity onPress={onClose} style={[ss.modalPrimary, { width: '100%' }]}>
            <Text style={ss.modalPrimaryTxt}>Fechar</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────
const MIC_OUTER = 220;
const MIC_INNER = MIC_OUTER - 14;

const ss = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  root: { flex: 1, backgroundColor: C.bg },

  // HEADER
  header: {
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 4,
  },
  logoTop: {
    width: 92, height: 92,
    marginBottom: 6,
  },
  brandTitle: {
    fontSize: 36, letterSpacing: -0.8,
    color: C.white,
  },
  brandTitleThin: { fontFamily: 'Outfit_400Regular', fontWeight: '300', color: '#E0E0E0' },
  brandTitleBold: { fontFamily: 'Outfit_700Bold', fontWeight: '800', color: C.white },
  brandSub: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 11,
    letterSpacing: 4,
    color: C.amber,
    marginTop: 6,
    opacity: 0.85,
  },

  // MIC SECTION
  micSection: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  micGlow: {
    position: 'absolute',
    top: -40, bottom: -40, left: -100, right: -100,
    borderRadius: 200,
    overflow: 'hidden',
  },
  micOuter: {
    width: MIC_OUTER, height: MIC_OUTER,
    borderRadius: MIC_OUTER / 2,
    borderWidth: 3,
    borderColor: C.amber,
    alignItems: 'center', justifyContent: 'center',
    // Glow via shadow (iOS) e elevation (Android)
    shadowColor: C.amber,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 22,
    elevation: 18,
  },
  micInner: {
    width: MIC_INNER, height: MIC_INNER,
    borderRadius: MIC_INNER / 2,
    alignItems: 'center', justifyContent: 'center',
  },
  pulseCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseRing: {
    position: 'absolute',
    width: MIC_OUTER,
    height: MIC_OUTER,
    borderRadius: MIC_OUTER / 2,
    borderWidth: 1.5,
    borderColor: C.amber,
  },
  particlesCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  particle: {
    position: 'absolute',
    borderRadius: 4,
    backgroundColor: C.amberSoft,
    shadowColor: C.amber,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 4,
  },

  // SIDE WAVES
  sideWaves: {
    position: 'absolute',
    top: '50%',
    height: 80,
    width: SW * 0.42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    transform: [{ translateY: -40 }],
  },
  sideWavesLeft: { left: 0 },
  sideWavesRight: { right: 0 },
  waveBar: {
    width: 2,
    backgroundColor: C.amber,
    borderRadius: 1,
  },

  // CENTRAL KEY DISPLAY (when confirmed, inside mic button)
  keyLetter: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 84,
    color: C.amber,
    letterSpacing: -2,
    lineHeight: 86,
  },
  keyQual: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 11,
    letterSpacing: 4,
    color: C.amberSoft,
    marginTop: 4,
  },

  // STATUS AREA (below mic)
  statusArea: {
    minHeight: 100,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  statusBig: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 15,
    letterSpacing: 5,
    color: C.amber,
    textAlign: 'center',
  },
  statusBigIdle: { color: C.amberSoft },
  statusBigAmber: { color: C.amber, opacity: 0.9 },

  // CONFIRMED BLOCK
  confirmedBlock: {
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  confirmedKeyRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginBottom: 6,
  },
  confirmedDot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: C.green,
  },
  confirmedLabel: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 11, letterSpacing: 3,
    color: C.green,
  },
  confirmedKeyName: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 14,
    color: C.white,
    marginBottom: 4,
  },
  confirmedKeyQual: { color: C.amber, fontWeight: '500' },
  confirmedConfidence: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 11, letterSpacing: 1.2,
    color: C.text2,
    marginBottom: 14,
  },
  confirmedActions: {
    flexDirection: 'row',
    gap: 10,
  },
  restartBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 11, paddingHorizontal: 18,
    backgroundColor: 'rgba(255,176,32,0.12)',
    borderRadius: 10,
    borderWidth: 1, borderColor: C.amberBorder,
  },
  restartBtnTxt: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 13, letterSpacing: 0.4,
    color: C.amber,
  },
  stopBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 11, paddingHorizontal: 16,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 10,
    borderWidth: 1, borderColor: C.borderStrong,
  },
  stopBtnTxt: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 12, letterSpacing: 0.4,
    color: C.text2,
  },

  // BOTTOM TAGLINE
  bottomBlock: {
    alignItems: 'center',
    paddingBottom: 16,
    paddingHorizontal: 24,
  },
  goldLine: {
    width: 60, height: 1.5,
    backgroundColor: C.amber,
    opacity: 0.6,
    marginBottom: 12,
    borderRadius: 1,
  },
  tagline: {
    fontFamily: 'Outfit_400Regular',
    fontSize: 16,
    textAlign: 'center',
    letterSpacing: 0.1,
  },
  taglineWhite: { color: C.white, fontWeight: '300' },
  taglineGold: { color: C.amber, fontWeight: '500' },

  // FOOTER ICONS
  footerIcons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 28,
    paddingBottom: 18,
    paddingTop: 4,
  },
  footerIconBtn: {
    width: 44, height: 44,
    borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: C.amberBorder,
    backgroundColor: 'rgba(255,176,32,0.06)',
  },

  // MODAL
  modalBg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    alignItems: 'center', justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: C.surface,
    borderRadius: 20,
    padding: 22,
    alignItems: 'center',
    borderWidth: 1, borderColor: C.borderStrong,
  },
  modalTitle: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 20, color: C.white,
    marginBottom: 6,
  },
  modalSubName: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 12, color: C.amber,
    letterSpacing: 1,
  },
  modalMsg: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 14, color: C.text2,
    textAlign: 'center', lineHeight: 20,
  },
  modalPrimary: {
    backgroundColor: C.amber,
    paddingVertical: 14, paddingHorizontal: 22,
    borderRadius: 12,
    alignItems: 'center',
  },
  modalPrimaryTxt: {
    fontFamily: 'Manrope_700Bold',
    fontSize: 14, color: C.bg,
    letterSpacing: 0.4,
  },
  modalSecondary: {
    paddingVertical: 12,
  },
  modalSecondaryTxt: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 13, color: C.text2,
  },
  versionTag: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 11, letterSpacing: 1.5,
    color: C.text3,
  },

  // SETTINGS LIST
  settingsItem: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14, paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1, borderColor: C.border,
    backgroundColor: 'rgba(255,255,255,0.02)',
    marginBottom: 8,
  },
  settingsItemTxt: {
    flex: 1,
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 14, color: C.white,
  },
});
