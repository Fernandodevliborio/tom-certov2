import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
      } catch {
        // silencioso — não incomoda o usuário
      }
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
        Alert.alert(
          'Atualização baixada',
          'Nova versão baixada! O app vai reiniciar agora.',
          [{ text: 'Reiniciar', onPress: () => Updates.reloadAsync().catch(() => {}) }]
        );
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

  const fadeIn = useRef(new Animated.Value(0)).current;
  const slideUp = useRef(new Animated.Value(30)).current;
  const logoGlow = useRef(new Animated.Value(0.6)).current;
  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  const ring3 = useRef(new Animated.Value(0)).current;
  const micScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeIn, { toValue: 1, duration: 280, useNativeDriver: true }),
      Animated.timing(slideUp, { toValue: 0, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
    const logoLoop = Animated.loop(Animated.sequence([
      Animated.timing(logoGlow, { toValue: 1, duration: 2000, useNativeDriver: true }),
      Animated.timing(logoGlow, { toValue: 0.6, duration: 2000, useNativeDriver: true }),
    ]));
    logoLoop.start();
    const makeRing = (val: Animated.Value, delay: number) =>
      Animated.loop(Animated.sequence([
        Animated.delay(delay),
        Animated.timing(val, { toValue: 1, duration: 2200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(val, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]));
    const r1 = makeRing(ring1, 0), r2 = makeRing(ring2, 700), r3 = makeRing(ring3, 1400);
    r1.start(); r2.start(); r3.start();
    return () => { logoLoop.stop(); r1.stop(); r2.stop(); r3.stop(); };
  }, []);

  const renderRing = (val: Animated.Value) => (
    <Animated.View style={[
      ss.micRing,
      {
        opacity: val.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0.7, 0.4, 0] }),
        transform: [{ scale: val.interpolate({ inputRange: [0, 1], outputRange: [1, 2.8] }) }],
      }
    ]} />
  );

  return (
    <Animated.View testID="initial-screen" style={[ss.initialRoot, { opacity: fadeIn, transform: [{ translateY: slideUp }] }]}>
      {/* Brand Block */}
      <View style={ss.brandBlock}>
        <Animated.View style={[ss.logoWrapMain, { opacity: logoGlow }]}>
          <Image
            source={require('../assets/images/logo.png')}
            style={ss.logoImgMain}
            resizeMode="contain"
          />
        </Animated.View>
        <Text style={ss.brandTitle}>Tom Certo</Text>
        <Text style={ss.brandSub}>DETECTOR DE TONALIDADE</Text>
      </View>

      {/* Mic Section */}
      <View style={ss.micSection}>
        {renderRing(ring3)}
        {renderRing(ring2)}
        {renderRing(ring1)}
        <TouchableOpacity
          testID="start-btn"
          onPressIn={() => Animated.spring(micScale, { toValue: 0.92, useNativeDriver: true }).start()}
          onPressOut={() => Animated.spring(micScale, { toValue: 1, friction: 4, useNativeDriver: true }).start()}
          onPress={onStart}
          activeOpacity={1}
        >
          <Animated.View style={[ss.micBtn, { transform: [{ scale: micScale }] }]}>
            <Ionicons name="mic" size={52} color={C.bg} />
          </Animated.View>
        </TouchableOpacity>
        <Text style={ss.micLabel}>Toque para detectar</Text>
      </View>

      {/* Error Box */}
      {errorMessage && !modalVisible ? (
        <TouchableOpacity style={ss.errorBox} onPress={() => setModalVisible(true)} activeOpacity={0.7}>
          <Ionicons name="alert-circle" size={16} color={C.red} />
          <Text style={ss.errorTxt}>{errorMessage}</Text>
        </TouchableOpacity>
      ) : null}

      {/* Footer */}
      <View style={ss.footerRow}>
        <TouchableOpacity testID="logout-btn" onPress={logout} style={ss.footerBtn}>
          <Ionicons name="log-out-outline" size={13} color={C.text3} />
          <Text style={ss.logoutTxt}>
            Sair{session?.customer_name ? ` · ${session.customer_name}` : ''}
          </Text>
        </TouchableOpacity>
        <View style={ss.footerDivider} />
        <TouchableOpacity testID="update-btn" onPress={onCheckUpdate} style={ss.footerBtn}>
          {checkingUpdate ? (
            <ActivityIndicator size={12} color={C.text3} />
          ) : (
            <Ionicons name="refresh-outline" size={13} color={C.text3} />
          )}
          <Text style={ss.logoutTxt}>{checkingUpdate ? 'Buscando...' : 'Buscar atualização'}</Text>
        </TouchableOpacity>
      </View>

      <MicNoticeModal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        onRetry={() => { setModalVisible(false); onStart(); }}
        reason={errorReason}
        message={errorMessage}
      />
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
    softInfo, reset, softReset, phraseStage, phrasesAnalyzed,
    smartStatus, mlResult,
  } = det;

  // ═══════════════════════════════════════════════════════════════
  // ESTRATÉGIA "TOM SEGURO" v6 — só mostra tom quando há ALTA confiança
  // ═══════════════════════════════════════════════════════════════
  // - NUNCA exibe tom provisório (eliminado o flicker de "Lá menor → Sol menor")
  // - Caminho RÁPIDO: 1 análise muito confiante (conf ≥ FAST_CONFIRM_CONF) → trava
  // - Caminho NORMAL: 2 de 3 análises mesmo tom + conf média ≥ MIN_CONFIRM_CONF
  // - Uma vez TRAVADO, o tom NÃO muda mais até o usuário parar/reiniciar
  // - Antes de travar: só status ("Ouvindo...", "Analisando...", "Cante mais...")
  const MIN_INDIVIDUAL_CONF = 0.60; // entrada na janela
  const MIN_CONFIRM_CONF = 0.70;    // confirma com 2 de 3
  const FAST_CONFIRM_CONF = 0.80;   // confirma com 1 análise super confiante
  const LOCK_WINDOW_SIZE = 3;

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

    // ⚡ CAMINHO RÁPIDO: 1 análise super confiante → trava direto (~4s)
    if (conf >= FAST_CONFIRM_CONF) {
      lockedKeyRef.current = {
        tonic, quality, key_name: keyName,
        confidence: conf, at: Date.now(),
      };
      setLockedKeyTick(t => t + 1);
      return;
    }

    // 🐢 CAMINHO NORMAL: só entra na janela se passou do mínimo individual
    if (conf < MIN_INDIVIDUAL_CONF) return;

    // Adiciona à janela (mantém últimas N)
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
    const avgConf = bestEntry.sumConf / bestEntry.count;

    // Trava se 2 de 3 análises concordam E a média de confiança é alta
    if (bestEntry.count >= 2 && avgConf >= MIN_CONFIRM_CONF) {
      lockedKeyRef.current = {
        tonic: bestEntry.tonic, quality: bestEntry.quality, key_name: keyName,
        confidence: avgConf, at: Date.now(),
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

  // 🔄 Restart Detection — limpa o estado de análise SEM parar o microfone.
  // O usuário aperta esse botão pra detectar um novo tom (ex: música mudou)
  // sem precisar parar a gravação. Volta direto ao estado "🎤 OUVINDO...".
  const restartDetection = useCallback(async () => {
    // 1) Limpa refs locais de trava
    lockedKeyRef.current = null;
    lockWindowRef.current = [];
    setLockedKeyTick(t => t + 1);
    // 2) Soft reset no hook (limpa mlResult + zera PCP no backend)
    try { await softReset(); } catch { /* tolerado */ }
  }, [softReset]);

  // ═══════════════════════════════════════════════════════════════
  // MÁQUINA DE ESTADOS DE STATUS — só status, nunca tom provisório
  // ═══════════════════════════════════════════════════════════════
  // Estados visuais (antes do tom ser exibido):
  //   - 'idle'        : não está gravando
  //   - 'listening'   : gravando, sem nenhuma análise ainda
  //   - 'analyzing'   : tem análises, mas confiança ainda baixa
  //   - 'needs_more'  : backend sinaliza few_notes/single_phrase
  //   - 'confirmed'   : tom travado (único caso onde tom é exibido)
  type Stage = 'idle' | 'listening' | 'analyzing' | 'needs_more' | 'confirmed';

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
    // Backend sinaliza poucas notas / frase única → "Cante mais..."
    const flags = mlResult?.flags || [];
    if (flags.includes('few_notes') || flags.includes('single_phrase')) return 'needs_more';
    if (analysisCount === 0) return 'listening';
    return 'analyzing';
  }, [isRunning, analysisCount, mlResult?.flags, lockedKeyTick]);

  const confirmedKey = lockedKeyRef.current
    ? { root: lockedKeyRef.current.tonic, quality: lockedKeyRef.current.quality }
    : null;

  // ⚠️ NUNCA exibir tom provisório — eliminada a fonte do "tom errado intermediário"
  const displayKey = confirmedKey;

  // Status text amigável (mostrado no card de análise)
  const statusInfo = useMemo(() => {
    switch (mlStage) {
      case 'listening':
        return { icon: 'mic', label: 'OUVINDO', sub: 'Cante uma melodia ou um trecho da música…' };
      case 'analyzing':
        return { icon: 'pulse', label: 'ANALISANDO TOM', sub: 'Procurando o centro tonal com segurança…' };
      case 'needs_more':
        return { icon: 'musical-notes', label: 'CANTE MAIS', sub: 'Cante mais alguns segundos para confirmar o tom.' };
      default:
        return { icon: 'mic', label: 'OUVINDO', sub: 'Cante uma melodia ou um trecho da música…' };
    }
  }, [mlStage]);

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
    if (mlStage === 'confirmed') return 'TOM IDENTIFICADO';
    if (mlStage === 'needs_more') return 'CANTE MAIS UM POUCO…';
    if (mlStage === 'analyzing') return 'ANALISANDO TOM…';
    return 'OUVINDO…';
  })();

  const statusDotColor = (() => {
    if (!isRunning) return C.text3;
    if (mlStage === 'confirmed') return C.green;
    if (mlStage === 'needs_more') return C.amber;
    return C.text2;
  })();

  const harmonicField = useMemo(
    () => confirmedKey ? getHarmonicField(confirmedKey.root, confirmedKey.quality) : [],
    [confirmedKey?.root, confirmedKey?.quality]
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
            <View testID="key-card" style={[ss.keyCard, confirmedKey ? ss.keyCardConfirmed : ss.keyCardProv]}>
              <View style={ss.keyCardHeader}>
                <View style={[
                  ss.keyCardBadge,
                  { borderColor: 'rgba(34,197,94,0.35)' },
                ]}>
                  <Ionicons
                    name="checkmark-circle"
                    size={11}
                    color={C.green}
                  />
                  <Text style={[ss.keyCardBadgeTxt, { color: C.green }]}>
                    TOM DETECTADO
                  </Text>
                </View>
                <Text style={[ss.keyCardConfPct, { color: confColor }]}>{confPct}%</Text>
              </View>
              <KeyDisplay root={displayKey.root} quality={displayKey.quality} provisional={false} />
              <ConfidenceBar pct={confPct} color={confColor} />
              {/* 🔄 Botão de Reiniciar Detecção — só aparece quando tom está travado */}
              <TouchableOpacity
                testID="restart-detection-btn"
                style={ss.restartBtn}
                onPress={restartDetection}
                activeOpacity={0.7}
              >
                <Ionicons name="refresh" size={16} color={C.amber} />
                <Text style={ss.restartBtnTxt}>Detectar Novo Tom</Text>
              </TouchableOpacity>
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
                Aguarde — só vou exibir o tom quando tiver certeza.
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

        {/* ───── Campo Harmônico (só quando confirmado) ───── */}
        {confirmedKey && harmonicField.length > 0 && (
          <View style={ss.section}>
            <Text style={ss.sectionLabel}>CAMPO HARMÔNICO</Text>
            <View style={ss.chordGrid}>
              {harmonicField.map((chord, i) => (
                <View key={i} style={[ss.chordCard, chord.isTonic && ss.chordCardTonic]}>
                  <Text style={ss.chordDegree}>{degreeLabel(i, confirmedKey.quality)}</Text>
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

  // INITIAL
  initialRoot: {
    flex: 1, alignItems: 'center', justifyContent: 'space-between',
    paddingTop: SH * 0.08, paddingBottom: 36, paddingHorizontal: 24,
  },
  brandBlock: { alignItems: 'center', gap: 6 },
  logoWrapMain: {
    width: 170, height: 170,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 10,
    ...Platform.select({
      ios: { shadowColor: C.amber, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.55, shadowRadius: 36 },
      android: { elevation: 14 },
      default: {},
    }),
  },
  logoImgMain: { width: 170, height: 170 },
  headerLogoLanding: { width: 28, height: 28 },
  brandTitle: { fontFamily: 'Outfit_800ExtraBold', fontSize: 28, color: C.white, letterSpacing: -0.8 },
  brandSub: { fontFamily: 'Manrope_500Medium', fontSize: 10, color: C.text3, letterSpacing: 3 },

  micSection: {
    alignItems: 'center', justifyContent: 'center',
    width: MIC_SIZE * 3, height: MIC_SIZE * 3,
  },
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
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: C.redMuted, borderWidth: 1, borderColor: 'rgba(239,68,68,0.25)',
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, width: '100%',
  },
  errorTxt: { flex: 1, fontFamily: 'Manrope_500Medium', fontSize: 12, color: C.red, lineHeight: 16 },
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
  restartBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, marginTop: 14, paddingVertical: 11, paddingHorizontal: 16,
    backgroundColor: 'rgba(255,176,32,0.10)',
    borderRadius: 10,
    borderWidth: 1, borderColor: 'rgba(255,176,32,0.28)',
  },
  restartBtnTxt: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 13.5,
    letterSpacing: 0.3,
    color: C.amber,
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
