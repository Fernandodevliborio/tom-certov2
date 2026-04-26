import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated, Dimensions,
  Easing, Platform, Modal, ScrollView, Linking, Alert, ActivityIndicator, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Updates from 'expo-updates';

import { useKeyDetection } from '../src/hooks/useKeyDetection';
import { NOTES_BR, NOTES_INTL, formatKeyDisplay, getHarmonicField } from '../src/utils/noteUtils';
import { useAuth } from '../src/auth/AuthContext';
import { APP_VERSION_LABEL } from '../src/constants/version';
import AudioVisualizer from '../src/components/AudioVisualizer';

const { width: SW, height: SH } = Dimensions.get('window');

const C = {
  bg: '#000000', surface: '#0E0E0E', surface2: '#141414',
  border: '#1C1C1C', borderStrong: '#2A2A2A',
  amber: '#FFB020', amberGlow: 'rgba(255,176,32,0.38)',
  amberMuted: 'rgba(255,176,32,0.10)', amberBorder: 'rgba(255,176,32,0.28)',
  white: '#FFFFFF', text2: '#A0A0A0', text3: '#555555',
  red: '#EF4444', redMuted: 'rgba(239,68,68,0.12)',
  green: '#22C55E', blue: '#60A5FA',
};

export default function HomeScreen() {
  const det = useKeyDetection();
  const screen: 'initial' | 'active' = det.isRunning ? 'active' : 'initial';

  // Warmup silencioso: acorda o servidor Railway quando o usuário chega na tela
  // Reduz o cold-start delay quando ele pressionar o botão de detectar
  useEffect(() => {
    const base = (process.env.EXPO_PUBLIC_BACKEND_URL as string) ?? '';
    if (!base) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    fetch(`${base}/api/analyze-key/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
    }).catch(() => {}).finally(() => clearTimeout(t));
    return () => { ctrl.abort(); clearTimeout(t); };
  }, []);

  return (
    <SafeAreaView testID="home-screen" style={ss.safe}>
      {screen === 'initial'
        ? <InitialScreen onStart={det.start} errorMessage={det.errorMessage} errorReason={det.errorReason} />
        : <ActiveScreen det={det} />
      }
    </SafeAreaView>
  );
}

// ═════════════════════════════════════════════════════════════════════════
// INITIAL SCREEN
// ═════════════════════════════════════════════════════════════════════════
function InitialScreen({
  onStart, errorMessage, errorReason,
}: {
  onStart: () => void;
  errorMessage: string | null;
  errorReason: 'permission_denied' | 'permission_blocked' | 'platform_limit' | 'unknown' | null;
}) {
  const { logout, session } = useAuth();
  const [modalVisible, setModalVisible] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const prevErr = useRef<string | null>(null);

  // OTA auto-check no startup — garante que app sempre tem bundle mais recente
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

  useEffect(() => {
    if (errorMessage && errorMessage !== prevErr.current) setModalVisible(true);
    prevErr.current = errorMessage;
  }, [errorMessage]);

  // ═══════════════════════════════════════════════════════════════
  // ANIMAÇÕES PREMIUM — vivas mas elegantes (Apple/Tesla style)
  // ═══════════════════════════════════════════════════════════════
  const fadeIn = useRef(new Animated.Value(0)).current;
  const slideUp = useRef(new Animated.Value(20)).current;
  const breathe = useRef(new Animated.Value(0)).current;
  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  const ring3 = useRef(new Animated.Value(0)).current;
  const micScale = useRef(new Animated.Value(1)).current;
  const logoGlow = useRef(new Animated.Value(0.7)).current;

  // Side waves (16 barras cada lado)
  const WAVE_COUNT = 16;
  const waveLeft = useRef(Array.from({ length: WAVE_COUNT }, () => new Animated.Value(Math.random()))).current;
  const waveRight = useRef(Array.from({ length: WAVE_COUNT }, () => new Animated.Value(Math.random()))).current;
  // Particles douradas (12 ao redor)
  const PARTICLE_COUNT = 14;
  const particles = useRef(
    Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
      angle: (i / PARTICLE_COUNT) * Math.PI * 2 + Math.random() * 0.3,
      radius: 110 + Math.random() * 50,
      val: new Animated.Value(Math.random()),
      size: 2 + Math.random() * 2,
      dur: 2200 + Math.random() * 1800,
    }))
  ).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeIn, { toValue: 1, duration: 320, useNativeDriver: true }),
      Animated.timing(slideUp, { toValue: 0, duration: 380, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();

    // Logo glow loop (sutil)
    const logoLoop = Animated.loop(Animated.sequence([
      Animated.timing(logoGlow, { toValue: 1, duration: 2400, useNativeDriver: true }),
      Animated.timing(logoGlow, { toValue: 0.7, duration: 2400, useNativeDriver: true }),
    ]));

    // Breathe (scale 0.99-1.02 conforme pedido)
    const breatheLoop = Animated.loop(Animated.sequence([
      Animated.timing(breathe, { toValue: 1, duration: 2400, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(breathe, { toValue: 0, duration: 2400, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));

    // 3 anéis concêntricos (mais visíveis que antes mas elegantes)
    const makeRing = (val: Animated.Value, delay: number) =>
      Animated.loop(Animated.sequence([
        Animated.delay(delay),
        Animated.timing(val, { toValue: 1, duration: 3200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(val, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]));
    const r1 = makeRing(ring1, 0), r2 = makeRing(ring2, 1066), r3 = makeRing(ring3, 2133);

    // Side wave bars
    const waveLoops: Animated.CompositeAnimation[] = [];
    [waveLeft, waveRight].forEach(arr => {
      arr.forEach((val) => {
        const dur = 700 + Math.random() * 900;
        const loop = Animated.loop(Animated.sequence([
          Animated.timing(val, { toValue: 1, duration: dur, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
          Animated.timing(val, { toValue: 0, duration: dur, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
        ]));
        waveLoops.push(loop);
      });
    });

    // Particles
    const particleLoops = particles.map(p =>
      Animated.loop(Animated.sequence([
        Animated.timing(p.val, { toValue: 1, duration: p.dur, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(p.val, { toValue: 0, duration: p.dur, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]))
    );

    logoLoop.start(); breatheLoop.start(); r1.start(); r2.start(); r3.start();
    waveLoops.forEach(l => l.start());
    particleLoops.forEach(l => l.start());

    return () => {
      logoLoop.stop(); breatheLoop.stop(); r1.stop(); r2.stop(); r3.stop();
      waveLoops.forEach(l => l.stop());
      particleLoops.forEach(l => l.stop());
    };
  }, []);

  // scale 0.99 → 1.02 (vivo mas sutil)
  const breatheScale = breathe.interpolate({ inputRange: [0, 1], outputRange: [0.99, 1.02] });

  const renderRing = (val: Animated.Value, idx: number) => (
    <Animated.View pointerEvents="none" style={[
      ss.micRingPremium,
      {
        opacity: val.interpolate({
          inputRange: [0, 0.4, 1],
          outputRange: [0.45 - idx * 0.08, 0.22 - idx * 0.04, 0],
        }),
        transform: [{ scale: val.interpolate({ inputRange: [0, 1], outputRange: [1, 1.85 + idx * 0.15] }) }],
      },
    ]} />
  );

  return (
    <Animated.View testID="initial-screen" style={[ss.initialRoot, { opacity: fadeIn, transform: [{ translateY: slideUp }] }]}>
      {/* HEADER: logo com glow + título + subtítulo */}
      <View style={ss.brandBlock}>
        <Animated.View style={{ opacity: logoGlow }}>
          <Image
            source={require('../assets/images/logo.png')}
            style={ss.logoImgMain}
            resizeMode="contain"
          />
        </Animated.View>
        <Text style={ss.brandTitle}>
          <Text style={ss.brandTitleThin}>Tom </Text>
          <Text style={ss.brandTitleBold}>Certo</Text>
        </Text>
        <Text style={ss.brandSub}>DETECTOR DE TONALIDADE</Text>
      </View>

      {/* MIC SECTION — botão central, 3 anéis, partículas, ondas laterais */}
      <View style={ss.micSection}>
        {/* Side waves esquerda */}
        <View style={[ss.sideWaves, ss.sideWavesLeft]} pointerEvents="none">
          {waveLeft.map((val, i) => {
            const cw = 1 - Math.abs((i - WAVE_COUNT / 2) / (WAVE_COUNT / 2));
            return (
              <Animated.View key={`wl-${i}`} style={[
                ss.waveBar,
                {
                  height: val.interpolate({ inputRange: [0, 1], outputRange: [4 + cw * 8, 18 + cw * 42] }),
                  opacity: val.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.65] }),
                },
              ]} />
            );
          })}
        </View>
        {/* Side waves direita */}
        <View style={[ss.sideWaves, ss.sideWavesRight]} pointerEvents="none">
          {waveRight.map((val, i) => {
            const cw = 1 - Math.abs((i - WAVE_COUNT / 2) / (WAVE_COUNT / 2));
            return (
              <Animated.View key={`wr-${i}`} style={[
                ss.waveBar,
                {
                  height: val.interpolate({ inputRange: [0, 1], outputRange: [4 + cw * 8, 18 + cw * 42] }),
                  opacity: val.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.65] }),
                },
              ]} />
            );
          })}
        </View>

        {/* Partículas douradas orbitando */}
        <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
          <View style={ss.particlesCenter}>
            {particles.map((p, i) => {
              const x = Math.cos(p.angle) * p.radius;
              const y = Math.sin(p.angle) * p.radius;
              const opacity = p.val.interpolate({
                inputRange: [0, 0.5, 1],
                outputRange: [0.15, 0.65, 0.15],
              });
              return (
                <Animated.View
                  key={`p-${i}`}
                  style={[
                    ss.particle,
                    { width: p.size, height: p.size, opacity, transform: [{ translateX: x }, { translateY: y }] },
                  ]}
                />
              );
            })}
          </View>
        </View>

        {/* 3 anéis concêntricos pulsantes */}
        {renderRing(ring3, 2)}
        {renderRing(ring2, 1)}
        {renderRing(ring1, 0)}

        {/* Botão central */}
        <TouchableOpacity
          testID="start-btn"
          onPressIn={() => Animated.spring(micScale, { toValue: 0.94, useNativeDriver: true }).start()}
          onPressOut={() => Animated.spring(micScale, { toValue: 1, friction: 4, useNativeDriver: true }).start()}
          onPress={onStart}
          activeOpacity={1}
        >
          <Animated.View style={[
            ss.micBtnPremium,
            { transform: [{ scale: Animated.multiply(micScale, breatheScale) }] },
          ]}>
            <View style={ss.micInnerPremium}>
              <Ionicons name="mic" size={56} color={C.amber} />
            </View>
          </Animated.View>
        </TouchableOpacity>
      </View>

      {/* STATUS / CALL TO ACTION */}
      <View style={ss.statusBlock}>
        <Text style={ss.startLabel}>INICIAR DETECÇÃO</Text>
        <View style={ss.goldLine} />
        <Text style={ss.tagline}>
          <Text style={ss.taglineWhite}>Detecção inteligente. </Text>
          <Text style={ss.taglineGold}>Resultado preciso.</Text>
        </Text>
      </View>

      {/* ERRO INLINE (ainda discreto) */}
      {errorMessage && !modalVisible ? (
        <TouchableOpacity style={ss.errorBox} onPress={() => setModalVisible(true)} activeOpacity={0.7}>
          <Ionicons name="alert-circle" size={14} color={C.red} />
          <Text style={ss.errorTxt}>{errorMessage}</Text>
        </TouchableOpacity>
      ) : null}

      {/* FOOTER: 2 ícones com borda dourada circular */}
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
          onPress={onCheckUpdate}
          style={ss.footerIconBtn}
          activeOpacity={0.6}
          disabled={checkingUpdate}
        >
          {checkingUpdate
            ? <ActivityIndicator size={16} color={C.amber} />
            : <Ionicons name="time-outline" size={22} color={C.amber} />}
        </TouchableOpacity>
      </View>

      <MicNoticeModal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        onRetry={() => { setModalVisible(false); onStart(); }}
        reason={errorReason}
        message={errorMessage}
      />

      {/* Settings Modal: contém logout */}
      <Modal visible={settingsOpen} transparent animationType="fade">
        <View style={ss.modalBg}>
          <View style={ss.modalCard}>
            <Ionicons name="settings-sharp" size={32} color={C.amber} style={{ marginBottom: 8 }} />
            <Text style={ss.modalTitle}>Configurações</Text>
            {session?.customer_name
              ? <Text style={ss.modalSubName}>Logado como {session.customer_name}</Text>
              : null}
            <View style={{ height: 16, width: '100%' }} />

            <TouchableOpacity
              testID="logout-btn"
              onPress={() => { setSettingsOpen(false); logout(); }}
              style={ss.settingsItem}
              activeOpacity={0.7}
            >
              <Ionicons name="log-out-outline" size={18} color={C.red} />
              <Text style={[ss.settingsItemTxt, { color: C.red }]}>Sair da conta</Text>
              <Ionicons name="chevron-forward" size={14} color={C.text3} />
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => { setSettingsOpen(false); onCheckUpdate(); }}
              style={ss.settingsItem}
              activeOpacity={0.7}
            >
              <Ionicons name="refresh-outline" size={18} color={C.amber} />
              <Text style={ss.settingsItemTxt}>Buscar atualização</Text>
              <Ionicons name="chevron-forward" size={14} color={C.text3} />
            </TouchableOpacity>

            <View style={{ height: 8 }} />
            <Text style={ss.versionLabel}>{APP_VERSION_LABEL}</Text>
            <TouchableOpacity onPress={() => setSettingsOpen(false)} style={ss.modalSecondary}>
              <Text style={ss.modalSecondaryTxt}>Fechar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </Animated.View>
  );
}

// ═════════════════════════════════════════════════════════════════════════
// ACTIVE SCREEN
// ═════════════════════════════════════════════════════════════════════════
function ActiveScreen({ det }: { det: ReturnType<typeof useKeyDetection> }) {
  const {
    detectionState, currentKey, keyTier, liveConfidence, changeSuggestion,
    currentNote, recentNotes, audioLevel, isRunning,
    softInfo, reset, phraseStage, phrasesAnalyzed,
    smartStatus, mlResult,
  } = det;

  // ═══════════════════════════════════════════════════════════════
  // ESTRATÉGIA "TOM TURBO" — DETECÇÃO RÁPIDA EM < 15 SEGUNDOS
  // ═══════════════════════════════════════════════════════════════
  // Agora aceita QUALQUER resultado válido do backend (success: true)
  // A confiança é usada apenas para decidir quando "travar" definitivamente
  const MIN_CONFIRM_CONF = 0.20;   // Trava com 2 análises concordando
  const FAST_CONFIRM_CONF = 0.30;  // Trava imediato se conf >= 30%
  const LOCK_WINDOW_SIZE = 2;      // 2 análises iguais = lock

  const lockWindowRef = useRef<Array<{ tonic: number; quality: 'major' | 'minor'; confidence: number }>>([]);
  const lockedKeyRef = useRef<{
    tonic: number; quality: 'major' | 'minor'; key_name: string; confidence: number; at: number;
  } | null>(null);
  const [lockedKeyTick, setLockedKeyTick] = useState(0);

  useEffect(() => {
    if (!mlResult?.success || mlResult.tonic === undefined || !mlResult.quality) return;
    const conf = mlResult.confidence ?? 0;
    const tonic = mlResult.tonic;
    const quality = mlResult.quality as 'major' | 'minor';
    const keyName = mlResult.key_name || '';

    // 🔒 Já travado? Não muda mais até reset (regra do produto).
    if (lockedKeyRef.current) return;

    // ⚡ CAMINHO RÁPIDO: confiança alta → trava direto
    if (conf >= FAST_CONFIRM_CONF) {
      lockedKeyRef.current = {
        tonic, quality, key_name: keyName,
        confidence: conf, at: Date.now(),
      };
      setLockedKeyTick(t => t + 1);
      return;
    }

    // 🎯 SEMPRE adiciona à janela (qualquer resultado válido conta)
    lockWindowRef.current = [
      ...lockWindowRef.current.slice(-(LOCK_WINDOW_SIZE - 1)),
      { tonic, quality, confidence: conf },
    ];

    // Conta ocorrências de cada tom na janela
    const counts = new Map<string, { count: number; sumConf: number; tonic: number; quality: 'major' | 'minor' }>();
    for (const r of lockWindowRef.current) {
      const k = `${r.tonic}-${r.quality}`;
      const e = counts.get(k) || { count: 0, sumConf: 0, tonic: r.tonic, quality: r.quality };
      e.count += 1;
      e.sumConf += r.confidence;
      counts.set(k, e);
    }

    // Tom mais frequente (desempate por sumConf)
    let bestEntry: { count: number; sumConf: number; tonic: number; quality: 'major' | 'minor' } | null = null;
    for (const v of counts.values()) {
      if (!bestEntry || v.count > bestEntry.count ||
          (v.count === bestEntry.count && v.sumConf > bestEntry.sumConf)) {
        bestEntry = v;
      }
    }
    if (!bestEntry) return;

    // Trava se 2 análises concordam (independente da confiança - o backend já validou)
    if (bestEntry.count >= 2) {
      lockedKeyRef.current = {
        tonic: bestEntry.tonic, quality: bestEntry.quality, key_name: keyName,
        confidence: bestEntry.sumConf / bestEntry.count, at: Date.now(),
      };
      setLockedKeyTick(t => t + 1);
    }
  }, [mlResult?.confidence, mlResult?.tonic, mlResult?.quality, mlResult?.success]);

  // Reset quando para de gravar
  useEffect(() => {
    if (!isRunning) {
      lockedKeyRef.current = null;
      lockWindowRef.current = [];
      setLockedKeyTick(t => t + 1);
    }
  }, [isRunning]);

  // ═══════════════════════════════════════════════════════════════
  // MÁQUINA DE ESTADOS DE STATUS — só status, nunca tom provisório
  // ═══════════════════════════════════════════════════════════════
  // Estados visuais (antes do tom ser exibido):
  //   - 'idle'        : não está gravando
  //   - 'listening'   : gravando, sem nenhuma análise ainda
  //   - 'analyzing'   : backend processando, aguardando resultado
  //   - 'confirmed'   : tem resultado (provisório ou travado)
  type Stage = 'idle' | 'listening' | 'analyzing' | 'confirmed';

  // Conta análises recebidas na sessão (zera ao parar)
  const [analysisCount, setAnalysisCount] = useState(0);
  const [lastAnalysisAt, setLastAnalysisAt] = useState<number | null>(null);

  useEffect(() => {
    if (mlResult?.success) {
      setLastAnalysisAt(Date.now());
      setAnalysisCount(c => c + 1);
    }
  }, [mlResult]);

  useEffect(() => {
    if (!isRunning) {
      setAnalysisCount(0);
      setLastAnalysisAt(null);
    }
  }, [isRunning]);

  const mlStage: Stage = useMemo(() => {
    if (lockedKeyRef.current) return 'confirmed';
    if (!isRunning) return 'idle';
    // Tem resultado válido do backend → mostra imediatamente (independente da confiança)
    if (
      mlResult?.success &&
      mlResult.tonic !== undefined &&
      mlResult.quality
    ) return 'confirmed';
    if (analysisCount === 0) return 'listening';
    return 'analyzing';
  }, [isRunning, analysisCount, mlResult?.success, mlResult?.tonic, mlResult?.quality, lockedKeyTick]);

  const confirmedKey = lockedKeyRef.current
    ? { root: lockedKeyRef.current.tonic, quality: lockedKeyRef.current.quality }
    : null;

  // Tom provisório: exibe qualquer resultado válido do backend (sem filtro de confiança)
  // O usuário precisa ver feedback rápido - a UI já indica que é "provisório"
  const provisionalKey = (
    !lockedKeyRef.current &&
    mlResult?.success &&
    isRunning &&
    mlResult.tonic !== undefined &&
    mlResult.quality
  ) ? { root: mlResult.tonic!, quality: mlResult.quality as 'major' | 'minor' } : null;

  const displayKey = confirmedKey ?? provisionalKey;
  // isProvisional: tem chave para exibir mas ainda não travou no lock
  const isProvisional = displayKey !== null && confirmedKey === null;

  // Status text amigável (mostrado no card de análise quando sem displayKey)
  // Mensagens dinâmicas que rotacionam a cada 2.5s para dar sensação de progresso
  const DYNAMIC_MESSAGES = [
    { icon: 'mic', label: 'OUVINDO', sub: 'Cante ou toque — estamos captando o áudio…' },
    { icon: 'musical-notes', label: 'CAPTANDO', sub: 'Continue cantando ou tocando…' },
    { icon: 'ear', label: 'ANALISANDO', sub: 'Processando as notas que você tocou…' },
    { icon: 'pulse', label: 'DETECTANDO', sub: 'Identificando a tonalidade da música…' },
  ];

  const [dynamicMsgIndex, setDynamicMsgIndex] = useState(0);
  useEffect(() => {
    if (!isRunning || mlStage === 'confirmed') {
      setDynamicMsgIndex(0);
      return;
    }
    const interval = setInterval(() => {
      setDynamicMsgIndex(prev => (prev + 1) % DYNAMIC_MESSAGES.length);
    }, 2500);
    return () => clearInterval(interval);
  }, [isRunning, mlStage]);

  const statusInfo = useMemo(() => {
    if (mlStage === 'confirmed') {
      return { icon: 'checkmark-circle', label: 'DETECTADO', sub: 'Tom identificado!' };
    }
    return DYNAMIC_MESSAGES[dynamicMsgIndex];
  }, [mlStage, dynamicMsgIndex]);

  // (friendlyHint removido — agora a UI usa statusInfo da máquina de estados)

  // Confidence do ML result atual (para a barra visual)
  const confPct = (() => {
    if (lockedKeyRef.current) {
      return Math.round(lockedKeyRef.current.confidence * 100);
    }
    if (mlResult?.success) return Math.round((mlResult.confidence ?? 0) * 100);
    return 0;
  })();
  const confColor = confPct >= 60 ? C.green : confPct >= 35 ? C.amber : C.text2;

  // Log técnico (dev only)
  useEffect(() => {
    if (mlResult?.success && mlResult.key_name) {
      // eslint-disable-next-line no-console
      console.log(
        `[ML] ${mlResult.key_name} conf=${(mlResult.confidence ?? 0).toFixed(2)} ` +
        `rec=${mlResult.recommendation} flags=[${(mlResult.flags ?? []).join(',')}] ` +
        `locked=${lockedKeyRef.current?.key_name ?? 'null'}`
      );
    }
  }, [mlResult?.key_name, mlResult?.confidence, mlResult?.recommendation]);

  // Indicador de última análise — visível pro usuário ver que sistema está vivo
  // (reutiliza analysisCount/lastAnalysisAt definidos acima na máquina de estados)
  const [tickRefresh, setTickRefresh] = useState(0);
  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => setTickRefresh(x => x + 1), 1000);
    return () => clearInterval(t);
  }, [isRunning]);

  const lastAnalysisAgoTxt = useMemo(() => {
    void tickRefresh;
    if (!lastAnalysisAt) return null;
    const ago = Math.round((Date.now() - lastAnalysisAt) / 1000);
    if (ago < 5) return `análise há ${ago}s · ${analysisCount} análises`;
    if (ago < 60) return `análise há ${ago}s · ${analysisCount} análises`;
    return `última análise há ${Math.round(ago/60)}min · ${analysisCount} total`;
  }, [lastAnalysisAt, analysisCount, tickRefresh]);

  const statusLabel = (() => {
    if (!isRunning) return 'TOQUE PARA COMEÇAR';
    if (mlStage === 'confirmed') return lockedKeyRef.current ? 'TOM DETECTADO' : 'TOM PROVISÓRIO';
    if (mlStage === 'analyzing') return 'PROCESSANDO…';
    return 'OUVINDO…';
  })();

  const statusDotColor = (() => {
    if (!isRunning) return C.text3;
    if (mlStage === 'confirmed') return lockedKeyRef.current ? C.green : C.amber;
    if (mlStage === 'analyzing') return C.amber;
    return C.text2;
  })();

  const harmonicField = useMemo(
    () => displayKey ? getHarmonicField(displayKey.root, displayKey.quality) : [],
    [displayKey?.root, displayKey?.quality]
  );

  const statusDot = useRef(new Animated.Value(1)).current;
  const noteOpacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(statusDot, { toValue: 0.25, duration: 700, useNativeDriver: true }),
      Animated.timing(statusDot, { toValue: 1, duration: 700, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, []);
  useEffect(() => {
    Animated.timing(noteOpacity, {
      toValue: currentNote !== null ? 1 : 0.3,
      duration: 180, useNativeDriver: true,
    }).start();
  }, [currentNote]);

  return (
    <View testID="active-screen" style={ss.activeRoot}>
      {/* ───── Header: linha 1 (brand + close) ───── */}
      <View style={ss.activeHeader}>
        <View style={ss.brandRow}>
          <Image
            source={require('../assets/images/logo.png')}
            style={ss.headerLogo}
            resizeMode="contain"
          />
          <View style={ss.brandTextWrap}>
            <Text style={ss.headerBrand} numberOfLines={1}>Tom Certo</Text>
            <Text style={ss.headerVersion} numberOfLines={1}>
              v3.4.0 · {(Updates.updateId ?? 'embedded').slice(0, 8)}
            </Text>
          </View>
        </View>
        <TouchableOpacity testID="stop-btn" onPress={reset} style={ss.headerCloseBtn} activeOpacity={0.7}>
          <Ionicons name="close" size={18} color={C.text2} />
        </TouchableOpacity>
      </View>

      {/* ───── Header: linha 2 (status discreto) ───── */}
      <View style={ss.statusBar}>
        <Animated.View style={[ss.statusDot, { backgroundColor: statusDotColor, opacity: statusDot }]} />
        <Text style={ss.statusBarTxt} numberOfLines={1}>{statusLabel}</Text>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={ss.scrollPad}>
        {/* ───── Note Hero (altura fixa pra evitar reflow) ───── */}
        <View style={ss.noteHero}>
          <View style={ss.noteHeroTopRow}>
            <Text style={ss.noteHeroLabel}>NOTA EM TEMPO REAL</Text>
            <AudioVisualizer level={audioLevel} active={isRunning} height={24} bars={5} />
          </View>
          <Animated.View style={[ss.noteHeroBox, { opacity: noteOpacity }]}>
            {currentNote !== null ? (
              <>
                <Text
                  testID="current-note"
                  style={ss.noteHeroTxt}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.55}
                >
                  {NOTES_BR[currentNote]}
                </Text>
                <Text style={ss.noteHeroIntl}>{NOTES_INTL[currentNote]}</Text>
              </>
            ) : (
              <View style={ss.listeningHero}>
                <Text style={ss.listeningTitle}>
                  {detectionState === 'analyzing' ? 'Analisando' : 'Ouvindo'}
                </Text>
                <Text style={ss.listeningSub}>
                  Cante ou toque — o app já começou a captar
                </Text>
              </View>
            )}
          </Animated.View>
        </View>

        {/* ───── História (scroll horizontal — não muda altura) ───── */}
        <View style={ss.section}>
          <Text style={ss.sectionLabel}>HISTÓRICO</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={ss.historyRow}
            style={ss.historyScroll}
          >
            {recentNotes.length === 0
              ? <Text style={ss.historyEmpty}>— aguardando primeiras notas —</Text>
              : recentNotes.map((pc, i) => {
                  const latest = i === recentNotes.length - 1;
                  return (
                    <View key={i} style={[ss.historyChip, latest && ss.historyChipActive]}>
                      <Text style={[ss.historyChipTxt, latest && ss.historyChipTxtActive]}>
                        {NOTES_BR[pc]}
                      </Text>
                    </View>
                  );
                })
            }
          </ScrollView>
        </View>

        {/* ───── Key Card / Analyzing — minHeight reservado ───── */}
        <View style={ss.keyCardSlot}>
          {displayKey ? (
            <View testID="key-card" style={[ss.keyCard, isProvisional ? ss.keyCardProv : ss.keyCardConfirmed]}>
              <View style={ss.keyCardHeader}>
                <View style={[
                  ss.keyCardBadge,
                  { borderColor: isProvisional ? C.amberBorder : 'rgba(34,197,94,0.35)' },
                ]}>
                  <Ionicons
                    name={isProvisional ? 'time-outline' : 'checkmark-circle'}
                    size={11}
                    color={isProvisional ? C.amber : C.green}
                  />
                  <Text style={[ss.keyCardBadgeTxt, { color: isProvisional ? C.amber : C.green }]}>
                    {isProvisional
                      ? `PROVISÓRIO · ${analysisCount} análise${analysisCount !== 1 ? 's' : ''}`
                      : 'TOM DETECTADO'
                    }
                  </Text>
                </View>
                <Text style={[ss.keyCardConfPct, { color: confColor }]}>{confPct}%</Text>
              </View>
              <KeyDisplay root={displayKey.root} quality={displayKey.quality} provisional={isProvisional} />
              <ConfidenceBar pct={confPct} color={confColor} />
            </View>
          ) : isRunning ? (
            <View testID="analyzing-card" style={[ss.keyCard, ss.keyCardProv]}>
              <View style={ss.keyCardHeader}>
                <View style={[ss.keyCardBadge, { borderColor: C.amberBorder }]}>
                  <Ionicons name={statusInfo.icon as any} size={11} color={C.amber} />
                  <Text style={[ss.keyCardBadgeTxt, { color: C.amber }]}>{statusInfo.label}</Text>
                </View>
              </View>
              <Text style={ss.analyzingTitle}>{statusInfo.sub}</Text>
              <Text style={ss.analyzingSub}>
                {analysisCount > 0
                  ? 'Ouvindo mais… refinando o resultado.'
                  : 'Cante ou toque por alguns segundos.'}
              </Text>
            </View>
          ) : null}
        </View>

        {/* ───── Change Banner — escondido quando travado ───── */}
        {changeSuggestion && !confirmedKey && (
          <View style={ss.changeBanner}>
            <Ionicons name="swap-horizontal-outline" size={14} color={C.blue} />
            <Text style={ss.changeBannerTxt}>
              Possível mudança para{' '}
              <Text style={ss.changeBannerStrong}>
                {formatKeyDisplay(changeSuggestion.root, changeSuggestion.quality).noteBr}{' '}
                {formatKeyDisplay(changeSuggestion.root, changeSuggestion.quality).qualityLabel}
              </Text>
            </Text>
          </View>
        )}

        {/* ───── Campo Harmônico (provisional + confirmado) ───── */}
        {displayKey && harmonicField.length > 0 && (
          <View style={ss.section}>
            <Text style={ss.sectionLabel}>
              CAMPO HARMÔNICO{isProvisional ? ' (PROVISÓRIO)' : ''}
            </Text>
            <View style={ss.chordGrid}>
              {harmonicField.map((chord, i) => (
                <View key={i} style={[ss.chordCard, chord.isTonic && ss.chordCardTonic]}>
                  <Text style={ss.chordDegree}>{degreeLabel(i, displayKey.quality)}</Text>
                  <Text style={[ss.chordName, chord.isTonic && ss.chordNameTonic]}>{chord.label}</Text>
                  <Text style={ss.chordIntl}>{chordIntlLabel(chord.root, chord.quality)}</Text>
                </View>
              ))}
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function KeyDisplay({ root, quality, provisional }: {
  root: number; quality: 'major' | 'minor'; provisional?: boolean;
}) {
  const k = formatKeyDisplay(root, quality);
  return (
    <View>
      <View style={ss.keyDisplayRow}>
        <Text style={ss.keyDisplayNote}>{k.noteBr}</Text>
        <Text style={ss.keyDisplayQual}>{k.qualityLabel}</Text>
      </View>
      <Text style={ss.keyDisplayIntl}>({k.noteIntl})</Text>
    </View>
  );
}

function ConfidenceBar({ pct, color }: { pct: number; color: string }) {
  return (
    <View style={ss.confBarBg}>
      <View style={[ss.confBarFill, { width: `${pct}%` as any, backgroundColor: color }]} />
    </View>
  );
}

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
            <TouchableOpacity
              testID="open-settings-btn"
              style={[ss.modalPrimary, { width: '100%', marginBottom: 8 }]}
              onPress={async () => { try { await Linking.openSettings(); } catch {} }}
              activeOpacity={0.85}
            >
              <Text style={ss.modalPrimaryTxt}>Abrir Configurações</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              testID="retry-btn"
              style={[ss.modalPrimary, { width: '100%', marginBottom: 8 }]}
              onPress={onRetry}
              activeOpacity={0.85}
            >
              <Text style={ss.modalPrimaryTxt}>
                {isPerm ? 'Permitir Microfone' : 'Tentar novamente'}
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity testID="close-modal-btn" onPress={onClose} style={ss.modalSecondary}>
            <Text style={ss.modalSecondaryTxt}>Fechar</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function degreeLabel(i: number, _q: 'major' | 'minor') {
  return (['I', 'ii', 'iii', 'IV', 'V', 'vi'] as const)[i] ?? '';
}
function chordIntlLabel(root: number, q: 'major' | 'minor' | 'dim') {
  return NOTES_INTL[root] + (q === 'minor' ? 'm' : q === 'dim' ? '°' : '');
}

// ─── Styles ──────────────────────────────────────────────────────────────
const MIC_SIZE = 128;
const CHORD_GAP = 8;
const CHORD_W = (SW - 32 - CHORD_GAP * 2) / 3;

const ss = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },

  // INITIAL — PREMIUM (referência: visual rico mas elegante)
  initialRoot: {
    flex: 1, alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 24, paddingBottom: 22, paddingHorizontal: 24,
  },
  brandBlock: { alignItems: 'center' },
  logoWrapMain: { width: 80, height: 80, alignItems: 'center', justifyContent: 'center' },
  logoImgMain: {
    width: 80, height: 80, marginBottom: 14,
    ...Platform.select({
      ios: { shadowColor: C.amber, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.5, shadowRadius: 24 },
      android: { elevation: 12 },
      default: {},
    }),
  },
  headerLogoLanding: { width: 28, height: 28 },
  brandTitle: { fontSize: 36, color: C.white, letterSpacing: -0.6 },
  brandTitleThin: { fontFamily: 'Outfit_400Regular', fontWeight: '300', color: '#E8E8E8' },
  brandTitleBold: { fontFamily: 'Outfit_700Bold', fontWeight: '700', color: C.white },
  brandSub: {
    fontFamily: 'Manrope_500Medium', fontSize: 11.5, letterSpacing: 6,
    color: C.amber, marginTop: 8, opacity: 0.78,
  },

  micSection: {
    alignItems: 'center', justifyContent: 'center',
    width: '100%', height: 320, position: 'relative',
  },
  // 3 anéis pulsantes (mais visíveis que antes)
  micRingPremium: {
    position: 'absolute', width: 184, height: 184,
    borderRadius: 92,
    borderWidth: 1, borderColor: C.amber,
  },
  micBtnPremium: {
    width: 184, height: 184, borderRadius: 92,
    borderWidth: 2, borderColor: C.amber,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#0E0905',
    ...Platform.select({
      ios: { shadowColor: C.amber, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.45, shadowRadius: 24 },
      android: { elevation: 14 },
      default: {},
    }),
  },
  micInnerPremium: {
    width: 168, height: 168, borderRadius: 84,
    backgroundColor: '#0A0A0A',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,176,32,0.32)',
  },
  // Side waves (clearly visible like reference)
  sideWaves: {
    position: 'absolute', top: '50%',
    height: 80, width: SW * 0.32,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    transform: [{ translateY: -40 }],
  },
  sideWavesLeft: { left: -8 },
  sideWavesRight: { right: -8 },
  waveBar: {
    width: 1.5, backgroundColor: C.amber, borderRadius: 1,
  },
  // Particles (golden dust around button)
  particlesCenter: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
  },
  particle: {
    position: 'absolute',
    borderRadius: 3, backgroundColor: C.amberSoft,
    ...Platform.select({
      ios: { shadowColor: C.amber, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.7, shadowRadius: 4 },
      default: {},
    }),
  },
  // Mantém classes antigas para o ActiveScreen (NÃO MEXER)
  micRing: {
    position: 'absolute', width: MIC_SIZE, height: MIC_SIZE,
    borderRadius: MIC_SIZE / 2, borderWidth: 1.5, borderColor: C.amber,
  },
  micBtn: {
    width: MIC_SIZE, height: MIC_SIZE, borderRadius: MIC_SIZE / 2,
    backgroundColor: C.amber, alignItems: 'center', justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: C.amber, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.6, shadowRadius: 28 },
      android: { elevation: 10 },
      default: {},
    }),
  },
  micLabel: {
    position: 'absolute', bottom: 12,
    fontFamily: 'Manrope_500Medium', fontSize: 13, color: C.text3, letterSpacing: 0.5,
  },

  // Status / CTA (mais destaque, como na referência)
  statusBlock: { alignItems: 'center', paddingHorizontal: 16 },
  startLabel: {
    fontFamily: 'Manrope_500Medium', fontWeight: '500',
    fontSize: 15, letterSpacing: 9,
    color: C.amber, textAlign: 'center',
  },
  goldLine: {
    width: 36, height: 1.5, backgroundColor: C.amber,
    opacity: 0.6, marginVertical: 14, borderRadius: 1,
  },
  tagline: {
    fontFamily: 'Outfit_400Regular', fontSize: 14,
    textAlign: 'center', letterSpacing: 0.2,
  },
  taglineWhite: { color: '#D8D8D8', fontWeight: '300' },
  taglineGold: { color: C.amber, fontWeight: '500' },

  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: C.redMuted, borderWidth: 1, borderColor: 'rgba(239,68,68,0.25)',
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, width: '100%',
  },
  errorTxt: { flex: 1, fontFamily: 'Manrope_500Medium', fontSize: 12, color: C.red, lineHeight: 16 },

  // Footer com 2 ícones com borda dourada circular (como referência)
  footerIcons: {
    flexDirection: 'row', justifyContent: 'space-between',
    width: '100%', paddingHorizontal: 18,
  },
  footerIconBtn: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,176,32,0.45)',
    backgroundColor: 'rgba(255,176,32,0.04)',
  },

  // Settings list (modal)
  modalSubName: {
    fontFamily: 'Manrope_500Medium', fontSize: 12, color: C.amber, letterSpacing: 1,
  },
  modalSecondary: { paddingVertical: 12 },
  modalSecondaryTxt: {
    fontFamily: 'Manrope_500Medium', fontSize: 13, color: C.text2,
  },
  settingsItem: {
    width: '100%', flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 14, paddingHorizontal: 14, borderRadius: 10,
    borderWidth: 1, borderColor: C.border,
    backgroundColor: 'rgba(255,255,255,0.02)', marginBottom: 8,
  },
  settingsItemTxt: {
    flex: 1, fontFamily: 'Manrope_600SemiBold', fontSize: 14, color: C.white,
  },
  versionLabel: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 11,
    color: C.text3,
    letterSpacing: 1.2,
    textAlign: 'center',
    marginTop: 4,
    marginBottom: 4,
    opacity: 0.7,
  },

  // Footer antigo (mantido pra compat — não usado mais na InitialScreen)
  footerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 8, gap: 4 },
  footerBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 8, paddingHorizontal: 12 },
  footerDivider: { width: 1, height: 12, backgroundColor: C.borderStrong, marginHorizontal: 2 },
  logoutTxt: { fontFamily: 'Manrope_500Medium', fontSize: 11, color: C.text3, letterSpacing: 0.4 },

  // ACTIVE
  activeRoot: { flex: 1, paddingHorizontal: 16, paddingTop: 4 },
  activeHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 8, paddingBottom: 10,
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1 },
  headerLogo: { width: 32, height: 32 },
  brandTextWrap: { flexShrink: 1 },
  headerBrand: {
    fontFamily: 'Outfit_700Bold', fontSize: 18, color: C.white, letterSpacing: -0.4,
    includeFontPadding: false,
  },
  headerVersion: {
    fontFamily: 'Manrope_500Medium', fontSize: 9.5, color: C.text3,
    letterSpacing: 0.6, marginTop: 1, includeFontPadding: false,
  },
  statusBar: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingHorizontal: 11, paddingVertical: 7,
    backgroundColor: C.surface, borderRadius: 12, borderWidth: 1, borderColor: C.border,
    marginBottom: 12, alignSelf: 'flex-start',
  },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusBarTxt: {
    fontFamily: 'Manrope_600SemiBold', fontSize: 10.5, color: C.text2, letterSpacing: 1.6,
  },
  headerStatusRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: C.surface, borderRadius: 10, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 9, paddingVertical: 5,
  },
  headerStatusTxt: { fontFamily: 'Manrope_600SemiBold', fontSize: 10, color: C.text2, letterSpacing: 1.5 },
  headerCloseBtn: {
    width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
  scrollPad: { paddingBottom: 24, gap: 14 },

  // Note Hero — altura FIXA, evita reflow
  noteHero: {
    backgroundColor: C.surface, borderRadius: 20, borderWidth: 1, borderColor: C.border,
    overflow: 'hidden',
    minHeight: 240,                         // ← altura mínima fixa
  },
  noteHeroTopRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingTop: 16, paddingBottom: 4,
  },
  noteHeroLabel: { fontFamily: 'Manrope_600SemiBold', fontSize: 10, color: C.text3, letterSpacing: 2.4 },
  noteHeroBox: {
    alignItems: 'center', justifyContent: 'center',
    flex: 1,                                // ocupa o resto do hero
    paddingHorizontal: 20, paddingBottom: 18, paddingTop: 4,
    minHeight: 175,                         // garante altura mesmo sem nota
  },
  noteHeroTxt: {
    fontFamily: 'Outfit_800ExtraBold', fontSize: 96, color: C.white,
    letterSpacing: -3.5, lineHeight: 110, textAlign: 'center',
    includeFontPadding: false,
    ...Platform.select({
      ios: { textShadowColor: C.amberGlow, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 28 },
      default: {},
    }),
  },
  noteHeroIntl: {
    fontFamily: 'Manrope_500Medium', fontSize: 13, color: C.text2,
    letterSpacing: 1, marginTop: 4,
  },
  listeningHero: { alignItems: 'center', justifyContent: 'center', flex: 1, paddingHorizontal: 20 },
  listeningTitle: {
    fontFamily: 'Outfit_800ExtraBold', fontSize: 32, color: C.white, letterSpacing: -1, marginBottom: 6,
  },
  listeningSub: {
    fontFamily: 'Manrope_400Regular', fontSize: 13, color: C.text2, textAlign: 'center', maxWidth: 280,
  },

  section: { gap: 8 },
  sectionLabel: {
    fontFamily: 'Manrope_600SemiBold', fontSize: 10, color: C.text3, letterSpacing: 2.4, paddingHorizontal: 2,
  },
  // Histórico em scroll horizontal — altura fixa, sem wrap
  historyScroll: {
    backgroundColor: C.surface, borderRadius: 14, borderWidth: 1, borderColor: C.border,
    minHeight: 48, maxHeight: 48,
  },
  historyRow: {
    flexDirection: 'row', gap: 6,
    paddingVertical: 9, paddingHorizontal: 12,
    alignItems: 'center',
  },
  historyEmpty: { fontFamily: 'Manrope_400Regular', fontSize: 11, color: C.text3, fontStyle: 'italic' },
  historyChip: {
    paddingHorizontal: 11, paddingVertical: 5, borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    minWidth: 38, alignItems: 'center',
  },
  historyChipActive: { backgroundColor: 'rgba(255,176,32,0.14)', borderColor: 'rgba(255,176,32,0.50)' },
  historyChipTxt: { fontFamily: 'Outfit_700Bold', fontSize: 13, color: C.text2, letterSpacing: 0.3 },
  historyChipTxtActive: { color: C.amber },

  // Slot reservado pro key card — minHeight evita pulos
  keyCardSlot: { minHeight: 168 },

  keyCard: {
    backgroundColor: C.surface, borderRadius: 16, borderWidth: 1, padding: 14, gap: 10,
  },
  keyCardProv: { borderColor: C.amberBorder },
  keyCardConfirmed: { borderColor: 'rgba(34,197,94,0.30)' },
  keyCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  keyCardBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 9, paddingVertical: 4, borderRadius: 99, borderWidth: 1,
  },
  keyCardBadgeTxt: { fontFamily: 'Manrope_600SemiBold', fontSize: 9.5, letterSpacing: 1.8 },
  keyCardConfPct: { fontFamily: 'Outfit_700Bold', fontSize: 13, color: C.text2, letterSpacing: -0.3 },
  hintRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: 10, paddingTop: 10,
    borderTopWidth: 1, borderTopColor: 'rgba(255,176,32,0.15)',
  },
  hintTxt: {
    flex: 1,
    fontFamily: 'Manrope_500Medium', fontSize: 12.5, color: C.amber,
    letterSpacing: 0.1,
  },
  analyzingTitle: {
    fontFamily: 'Outfit_700Bold', fontSize: 22, color: C.white,
    letterSpacing: -0.5, marginTop: 6,
  },
  analyzingSub: {
    fontFamily: 'Manrope_400Regular', fontSize: 13, color: C.text2,
    marginTop: 4, lineHeight: 18,
  },
  keyDisplayRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  keyDisplayNote: { fontFamily: 'Outfit_800ExtraBold', fontSize: 40, color: C.white, lineHeight: 44, letterSpacing: -1.2 },
  keyDisplayQual: { fontFamily: 'Outfit_700Bold', fontSize: 22, color: C.white, letterSpacing: -0.5 },
  keyDisplayIntl: { fontFamily: 'Manrope_400Regular', fontSize: 13, color: C.text3 },
  confBarBg: { height: 4, borderRadius: 99, backgroundColor: 'rgba(255,255,255,0.06)', overflow: 'hidden' },
  confBarFill: { height: '100%', borderRadius: 99 },

  changeBanner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 10, paddingHorizontal: 14, borderRadius: 12,
    backgroundColor: 'rgba(96,165,250,0.10)', borderWidth: 1, borderColor: 'rgba(96,165,250,0.35)',
  },
  changeBannerTxt: {
    fontFamily: 'Manrope_500Medium', fontSize: 12.5, color: C.text2, letterSpacing: 0.2, flexShrink: 1,
  },
  changeBannerStrong: { fontFamily: 'Outfit_700Bold', color: C.blue },

  chordGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: CHORD_GAP },
  chordCard: {
    width: CHORD_W, backgroundColor: C.surface, borderRadius: 12,
    paddingVertical: 10, paddingHorizontal: 6,
    alignItems: 'center', borderWidth: 1, borderColor: C.border,
  },
  chordCardTonic: { backgroundColor: C.amberMuted, borderColor: C.amberBorder },
  chordDegree: { fontFamily: 'Manrope_600SemiBold', fontSize: 10, color: C.text3, letterSpacing: 1, marginBottom: 2 },
  chordName: { fontFamily: 'Outfit_700Bold', fontSize: 16, color: C.white, letterSpacing: -0.3 },
  chordNameTonic: { color: C.amber },
  chordIntl: { fontFamily: 'Manrope_400Regular', fontSize: 10, color: C.text3, marginTop: 1 },

  softBar: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: C.amberMuted, borderWidth: 1, borderColor: C.amberBorder,
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10,
  },
  softBarTxt: { flex: 1, fontFamily: 'Manrope_500Medium', fontSize: 12, color: C.amber, lineHeight: 16 },

  modalBg: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.82)',
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28,
  },
  modalCard: {
    backgroundColor: C.surface, borderRadius: 24, borderWidth: 1, borderColor: C.border,
    padding: 28, width: '100%', alignItems: 'center',
  },
  modalTitle: { fontFamily: 'Outfit_700Bold', fontSize: 20, color: C.white, marginBottom: 8, letterSpacing: -0.3 },
  modalMsg: { fontFamily: 'Manrope_400Regular', fontSize: 14, color: C.text2, textAlign: 'center', lineHeight: 20 },
  modalPrimary: {
    height: 48, borderRadius: 99, backgroundColor: C.amber, alignItems: 'center', justifyContent: 'center',
  },
  modalPrimaryTxt: { fontFamily: 'Manrope_600SemiBold', fontSize: 15, color: C.bg, letterSpacing: 0.4 },
  modalSecondary: { height: 40, alignItems: 'center', justifyContent: 'center' },
  modalSecondaryTxt: { fontFamily: 'Manrope_500Medium', fontSize: 13, color: C.text2 },
});
