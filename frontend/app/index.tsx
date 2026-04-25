import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated, Dimensions,
  Easing, Platform, Modal, ScrollView, Linking, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { useKeyDetection } from '../src/hooks/useKeyDetection';
import { NOTES_BR, NOTES_INTL, formatKeyDisplay, getHarmonicField } from '../src/utils/noteUtils';
import { Colors, Radius, Spacing, Typography } from '../src/theme/tokens';
import { StatusPill } from '../src/components/StatusPill';
import { GoldWaveform } from '../src/components/GoldWaveform';
import { HistoryChips } from '../src/components/HistoryChips';
import { AICard } from '../src/components/AICard';
import { HarmonicFieldChips } from '../src/components/HarmonicFieldChips';
import { BottomNav } from '../src/components/BottomNav';
import { BrainVortex } from '../src/components/BrainVortex';
import { BigMicButton } from '../src/components/BigMicButton';
import { AIStepsList } from '../src/components/AIStepsList';

interface AIStep { id: string; label: string; status: 'done' | 'active' | 'pending' }
import { pushHistory } from '../src/utils/historyStorage';

const { height: SH } = Dimensions.get('window');

export default function HomeScreen() {
  const det = useKeyDetection();
  const screen: 'initial' | 'active' = det.isRunning ? 'active' : 'initial';
  return (
    <SafeAreaView testID="home-screen" style={ss.safe} edges={['top']}>
      {screen === 'initial'
        ? <InitialScreen onStart={det.start} errorMessage={det.errorMessage} errorReason={det.errorReason} />
        : <ActiveScreen det={det} />
      }
      <BottomNav />
    </SafeAreaView>
  );
}

// ═════════════════════════════════════════════════════════════════════════
// INITIAL SCREEN — premium hero with logo + big mic
// ═════════════════════════════════════════════════════════════════════════
function InitialScreen({
  onStart, errorMessage, errorReason,
}: {
  onStart: () => void;
  errorMessage: string | null;
  errorReason: 'permission_denied' | 'permission_blocked' | 'platform_limit' | 'unknown' | null;
}) {
  const [modalVisible, setModalVisible] = useState(false);
  const prevErr = useRef<string | null>(null);

  useEffect(() => {
    if (errorMessage && errorMessage !== prevErr.current) setModalVisible(true);
    prevErr.current = errorMessage;
  }, [errorMessage]);

  const fadeIn = useRef(new Animated.Value(0)).current;
  const slideUp = useRef(new Animated.Value(20)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeIn, { toValue: 1, duration: 320, useNativeDriver: true }),
      Animated.timing(slideUp, { toValue: 0, duration: 380, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, []);

  return (
    <Animated.View testID="initial-screen" style={[ss.initialRoot, { opacity: fadeIn, transform: [{ translateY: slideUp }] }]}>
      {/* Brand Block */}
      <View style={ss.brandBlock}>
        <View style={ss.logoCircle}>
          <Image
            source={require('../assets/images/logo.png')}
            style={ss.logoImg}
            resizeMode="contain"
          />
        </View>
        <Text style={ss.brandTitle}>Tom Certo</Text>
        <Text style={ss.brandSub}>Detecção inteligente de tonalidade</Text>
        <View style={{ height: 18 }} />
        <StatusPill label="Pronto para detectar" variant="idle" />
      </View>

      {/* Mic Section */}
      <View style={ss.micSection}>
        <BigMicButton onPress={onStart} size={168} />
        <Text style={ss.micLabel}>Toque para começar</Text>
      </View>

      {/* Error pill */}
      {errorMessage && !modalVisible ? (
        <TouchableOpacity style={ss.errorBox} onPress={() => setModalVisible(true)} activeOpacity={0.7}>
          <Ionicons name="alert-circle" size={14} color={Colors.red} />
          <Text style={ss.errorTxt} numberOfLines={2}>{errorMessage}</Text>
        </TouchableOpacity>
      ) : <View style={{ height: 38 }} />}

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
// ACTIVE SCREEN — analyzing → identified
// ═════════════════════════════════════════════════════════════════════════
function ActiveScreen({ det }: { det: ReturnType<typeof useKeyDetection> }) {
  const {
    currentNote, recentNotes, audioLevel, isRunning,
    reset, mlResult,
  } = det;

  // ─── Hysteresis logic — preserved from v3.x ────────────────────────────
  const MIN_DISPLAY_CONF = 0.25;
  const MIN_CONFIRM_CONF = 0.55;
  const MIN_INDIVIDUAL_CONF = 0.50;
  const LOCK_REPLACE_MARGIN = 0.08;
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

    if (conf < MIN_INDIVIDUAL_CONF) return;

    lockWindowRef.current = [
      ...lockWindowRef.current.slice(-(LOCK_WINDOW_SIZE - 1)),
      { tonic, quality, confidence: conf },
    ];

    const counts = new Map<string, { count: number; sumConf: number; tonic: number; quality: 'major' | 'minor' }>();
    for (const r of lockWindowRef.current) {
      const k = `${r.tonic}-${r.quality}`;
      const e = counts.get(k) || { count: 0, sumConf: 0, tonic: r.tonic, quality: r.quality };
      e.count += 1;
      e.sumConf += r.confidence;
      counts.set(k, e);
    }

    let bestEntry: { count: number; sumConf: number; tonic: number; quality: 'major' | 'minor' } | null = null;
    for (const v of counts.values()) {
      if (!bestEntry || v.count > bestEntry.count ||
          (v.count === bestEntry.count && v.sumConf > bestEntry.sumConf)) {
        bestEntry = v;
      }
    }
    if (!bestEntry) return;
    const avgConf = bestEntry.sumConf / bestEntry.count;

    if (!lockedKeyRef.current) {
      if (bestEntry.count >= 2 && avgConf >= MIN_CONFIRM_CONF) {
        lockedKeyRef.current = {
          tonic: bestEntry.tonic, quality: bestEntry.quality, key_name: keyName,
          confidence: avgConf, at: Date.now(),
        };
        setLockedKeyTick(t => t + 1);
        // persist to history
        pushHistory({
          key_name: keyName,
          root: bestEntry.tonic,
          quality: bestEntry.quality,
          confidence: avgConf,
          at: Date.now(),
        });
      }
      return;
    }

    const cur = lockedKeyRef.current;
    if (cur.tonic === bestEntry.tonic && cur.quality === bestEntry.quality) {
      cur.confidence = Math.max(cur.confidence, avgConf);
      cur.at = Date.now();
      return;
    }
    if (bestEntry.count >= 2 && avgConf >= cur.confidence + LOCK_REPLACE_MARGIN && avgConf >= MIN_CONFIRM_CONF) {
      lockedKeyRef.current = {
        tonic: bestEntry.tonic, quality: bestEntry.quality, key_name: keyName,
        confidence: avgConf, at: Date.now(),
      };
      setLockedKeyTick(t => t + 1);
      pushHistory({
        key_name: keyName,
        root: bestEntry.tonic,
        quality: bestEntry.quality,
        confidence: avgConf,
        at: Date.now(),
      });
    }
  }, [mlResult?.confidence, mlResult?.tonic, mlResult?.quality, mlResult?.success]);

  useEffect(() => {
    if (!isRunning) {
      lockedKeyRef.current = null;
      lockWindowRef.current = [];
      setLockedKeyTick(t => t + 1);
    }
  }, [isRunning]);

  // Probable key tracking
  const recentResultsRef = useRef<Array<{ tonic: number; quality: 'major' | 'minor'; confidence: number }>>([]);
  const probableKeyRef = useRef<{ tonic: number; quality: 'major' | 'minor'; confidence: number } | null>(null);

  useEffect(() => {
    if (!mlResult?.success || mlResult.tonic === undefined || !mlResult.quality) return;
    const conf = mlResult.confidence ?? 0;
    if (conf < MIN_DISPLAY_CONF) return;
    const tonic = mlResult.tonic;
    const quality = mlResult.quality as 'major' | 'minor';
    recentResultsRef.current = [
      ...recentResultsRef.current.slice(-2),
      { tonic, quality, confidence: conf },
    ];
    const counts = new Map<string, { count: number; sumConf: number; tonic: number; quality: 'major' | 'minor' }>();
    for (const r of recentResultsRef.current) {
      const key = `${r.tonic}-${r.quality}`;
      const c = counts.get(key) || { count: 0, sumConf: 0, tonic: r.tonic, quality: r.quality };
      c.count += 1;
      c.sumConf += r.confidence;
      counts.set(key, c);
    }
    let winner: { tonic: number; quality: 'major' | 'minor'; confidence: number } | null = null;
    let bestScore = -1;
    for (const c of counts.values()) {
      const score = c.count * 1000 + (c.sumConf / c.count);
      if (score > bestScore) {
        bestScore = score;
        winner = { tonic: c.tonic, quality: c.quality, confidence: c.sumConf / c.count };
      }
    }
    if (winner) {
      const cur = probableKeyRef.current;
      if (!cur) {
        probableKeyRef.current = winner;
      } else if (cur.tonic === winner.tonic && cur.quality === winner.quality) {
        cur.confidence = winner.confidence;
      } else {
        const winnerKey = `${winner.tonic}-${winner.quality}`;
        const winnerCount = counts.get(winnerKey)?.count ?? 0;
        if (winnerCount >= 2) {
          probableKeyRef.current = winner;
        }
      }
    }
  }, [mlResult?.confidence, mlResult?.tonic, mlResult?.quality, mlResult?.success]);

  useEffect(() => {
    if (!isRunning) {
      recentResultsRef.current = [];
      probableKeyRef.current = null;
    }
  }, [isRunning]);

  const mlStage: 'none' | 'analyzing' | 'probable' | 'confirmed' = useMemo(() => {
    if (lockedKeyRef.current) return 'confirmed';
    if (probableKeyRef.current) return 'probable';
    if (!mlResult?.success || mlResult.tonic === undefined || !mlResult.quality) return 'none';
    return 'analyzing';
  }, [mlResult?.success, mlResult?.tonic, mlResult?.quality, mlResult?.confidence, lockedKeyTick]);

  const mlKey = useMemo(() => {
    if (lockedKeyRef.current) return { root: lockedKeyRef.current.tonic, quality: lockedKeyRef.current.quality };
    if (probableKeyRef.current) return { root: probableKeyRef.current.tonic, quality: probableKeyRef.current.quality };
    return null;
  }, [mlStage, lockedKeyTick]);

  const confirmedKey = mlStage === 'confirmed' ? mlKey : null;
  const provisionalKey = mlStage === 'probable' ? mlKey : null;

  const friendlyHint = useMemo(() => {
    if (!mlResult?.success || mlStage === 'confirmed') return null;
    const flags = mlResult.flags || [];
    if (flags.includes('ambiguous_third')) return 'Tonalidade ainda ambígua — continue cantando';
    if (flags.includes('no_third_evidence')) return 'Ainda analisando maior/menor…';
    if (flags.includes('few_notes')) return 'Cante por mais alguns segundos';
    if (flags.includes('single_phrase')) return 'Continue cantando para confirmar';
    if (flags.includes('relative_ambiguous')) return 'Ainda decidindo entre tons próximos';
    if (mlStage === 'analyzing') return 'Continue cantando…';
    if (mlStage === 'probable') return 'Confirmando o tom…';
    return null;
  }, [mlResult?.flags, mlStage, mlResult?.success]);

  const confPct = (() => {
    if (lockedKeyRef.current) return Math.round(lockedKeyRef.current.confidence * 100);
    if (mlResult?.success) return Math.round((mlResult.confidence ?? 0) * 100);
    return 0;
  })();

  const harmonicField = useMemo(
    () => confirmedKey ? getHarmonicField(confirmedKey.root, confirmedKey.quality) : [],
    [confirmedKey?.root, confirmedKey?.quality]
  );

  // Status label & variant
  const { statusLabel, statusVariant } = (() => {
    if (mlStage === 'confirmed') return { statusLabel: 'Tonalidade identificada', statusVariant: 'confirmed' as const };
    if (mlStage === 'probable') return { statusLabel: 'Modelando tonalidade…', statusVariant: 'probable' as const };
    if (mlResult?.success === false || !mlResult) return { statusLabel: 'Captando áudio…', statusVariant: 'analyzing' as const };
    if ((mlResult.flags || []).includes('few_notes')) return { statusLabel: 'IA analisando padrões…', statusVariant: 'analyzing' as const };
    return { statusLabel: 'Refinando análise…', statusVariant: 'analyzing' as const };
  })();

  // Steps for analyzing card
  const aiSteps: AIStep[] = useMemo(() => {
    const hasAudio = isRunning && (mlResult?.notes_count ?? 0) > 0;
    const hasNotes = (mlResult?.notes_count ?? 0) >= 4;
    const inAnalyze = mlStage !== 'none';
    const hasProbable = mlStage === 'probable' || mlStage === 'confirmed';
    const isConfirmed = mlStage === 'confirmed';
    return [
      { id: 'capture', label: 'Captando áudio…', status: hasAudio ? 'done' : 'active' },
      { id: 'extract', label: 'Extraindo frequências…', status: hasNotes ? 'done' : (hasAudio ? 'active' : 'pending') },
      { id: 'compare', label: 'Comparando padrões…', status: inAnalyze ? (hasProbable ? 'done' : 'active') : 'pending' },
      { id: 'identify', label: 'Identificando tonalidade…', status: hasProbable ? (isConfirmed ? 'done' : 'active') : 'pending' },
      { id: 'validate', label: 'Validando confiança…', status: isConfirmed ? 'done' : (hasProbable ? 'active' : 'pending') },
    ];
  }, [isRunning, mlResult?.notes_count, mlStage]);

  const fadeIn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 280, useNativeDriver: true }).start();
  }, []);

  const onDetectAgain = useCallback(() => {
    lockedKeyRef.current = null;
    lockWindowRef.current = [];
    recentResultsRef.current = [];
    probableKeyRef.current = null;
    setLockedKeyTick(t => t + 1);
    // reset() para o áudio totalmente; usuário toca de novo no botão
    reset();
  }, [reset]);

  // Decide qual layout renderizar:
  // - confirmed → resultado com campo harmônico
  // - probable / analyzing inicial → vortex+steps (modelando)
  // - default → live note + waveform + history + AICard
  const showResult = mlStage === 'confirmed';
  const showVortex = mlStage === 'probable' && (mlResult?.notes_count ?? 0) >= 4;

  return (
    <Animated.View testID="active-screen" style={[ss.activeRoot, { opacity: fadeIn }]}>
      {/* Top bar */}
      <View style={ss.topBar}>
        <View style={ss.miniLogoWrap}>
          <Image source={require('../assets/images/logo.png')} style={ss.miniLogo} resizeMode="contain" />
        </View>
        <View style={ss.statusPillSlot}>
          <StatusPill label={statusLabel} variant={statusVariant} />
        </View>
        <TouchableOpacity testID="stop-btn" onPress={reset} style={ss.iconBtn} activeOpacity={0.7}>
          <Ionicons name="close" size={20} color={Colors.textMuted} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={ss.scroll}
        showsVerticalScrollIndicator={false}
      >
        {showResult ? (
          <ResultBlock
            root={confirmedKey!.root}
            quality={confirmedKey!.quality}
            confPct={confPct}
            harmonicField={harmonicField}
            onAgain={onDetectAgain}
          />
        ) : showVortex ? (
          <AnalyzingBlock steps={aiSteps} />
        ) : (
          <DetectingBlock
            currentNote={currentNote}
            audioLevel={audioLevel}
            isRunning={isRunning}
            recentNotes={recentNotes}
            provisionalKey={provisionalKey}
            confPct={confPct}
            hint={friendlyHint}
          />
        )}
      </ScrollView>
    </Animated.View>
  );
}

// ─── DETECTING BLOCK (live note + history + AI card) ────────────────────
function DetectingBlock({
  currentNote, audioLevel, isRunning, recentNotes,
  provisionalKey, confPct, hint,
}: {
  currentNote: number | null;
  audioLevel: number;
  isRunning: boolean;
  recentNotes: number[];
  provisionalKey: { root: number; quality: 'major' | 'minor' } | null;
  confPct: number;
  hint: string | null;
}) {
  const noteOpacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(noteOpacity, {
      toValue: currentNote !== null ? 1 : 0.35,
      duration: 180, useNativeDriver: true,
    }).start();
  }, [currentNote]);

  return (
    <View style={{ gap: 28 }}>
      {/* Live note hero */}
      <View style={ss.heroBlock}>
        <View style={ss.heroLabelRow}>
          <Text style={ss.heroLabel}>NOTA EM TEMPO REAL</Text>
          <Ionicons name="pulse" size={16} color={Colors.gold} />
        </View>
        <Animated.View style={[ss.noteBox, { opacity: noteOpacity }]}>
          {currentNote !== null ? (
            <>
              <Text style={ss.noteBig} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>
                {NOTES_BR[currentNote]}
              </Text>
              <Text style={ss.noteIntl}>{NOTES_INTL[currentNote]}</Text>
            </>
          ) : (
            <View style={ss.listeningWrap}>
              <Text style={ss.listeningTitle}>Ouvindo…</Text>
              <Text style={ss.listeningSub}>Cante ou toque algumas notas</Text>
            </View>
          )}
        </Animated.View>
        <View style={ss.waveformWrap}>
          <GoldWaveform level={audioLevel} active={isRunning} height={50} bars={42} />
        </View>
      </View>

      {/* Histórico */}
      <View>
        <Text style={ss.sectionLabel}>HISTÓRICO RECENTE</Text>
        <HistoryChips notes={recentNotes} />
      </View>

      {/* AI Card */}
      <AICard
        root={provisionalKey?.root ?? null}
        quality={provisionalKey?.quality ?? null}
        confidence={confPct}
        hint={hint}
      />
    </View>
  );
}

// ─── ANALYZING BLOCK (brain vortex + steps) ─────────────────────────────
function AnalyzingBlock({ steps }: { steps: AIStep[] }) {
  return (
    <View style={{ alignItems: 'center', gap: 24, paddingTop: 12 }}>
      <BrainVortex size={240} />
      <View style={{ width: '100%', gap: 8 }}>
        <Text style={[ss.sectionLabel, { textAlign: 'center', marginBottom: 4 }]}>
          PROCESSAMENTO INTELIGENTE
        </Text>
        <AIStepsList steps={steps} />
      </View>
      <View style={ss.workingBox}>
        <Ionicons name="sparkles" size={14} color={Colors.gold} />
        <View style={{ flex: 1 }}>
          <Text style={ss.workingTitle}>IA trabalhando…</Text>
          <Text style={ss.workingSub}>Isso pode levar alguns segundos</Text>
        </View>
      </View>
    </View>
  );
}

// ─── RESULT BLOCK ───────────────────────────────────────────────────────
function ResultBlock({
  root, quality, confPct, harmonicField, onAgain,
}: {
  root: number;
  quality: 'major' | 'minor';
  confPct: number;
  harmonicField: ReturnType<typeof getHarmonicField>;
  onAgain: () => void;
}) {
  const k = formatKeyDisplay(root, quality);
  const widthAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(widthAnim, {
      toValue: confPct,
      duration: 700,
      useNativeDriver: false,
    }).start();
  }, [confPct]);

  const fade = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 400, useNativeDriver: true }).start();
  }, []);

  return (
    <Animated.View style={{ opacity: fade, gap: 24 }}>
      <View style={{ alignItems: 'center', gap: 6 }}>
        <Text style={ss.resultLabel}>RESULTADO</Text>
        <View style={ss.resultKeyRow}>
          <Text style={ss.resultNote} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>
            {k.noteBr}
          </Text>
          <Text style={ss.resultQual}>{k.qualityLabel}</Text>
        </View>
        <Text style={ss.resultIntl}>({k.noteIntl})</Text>
      </View>

      <View style={{ gap: 8 }}>
        <View style={ss.confLabelRow}>
          <Text style={ss.confLabel}>Confiança</Text>
          <Text style={ss.confPct}>{confPct}%</Text>
        </View>
        <View style={ss.confTrack}>
          <Animated.View
            style={[
              ss.confFill,
              {
                width: widthAnim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
              },
            ]}
          />
        </View>
      </View>

      <View>
        <Text style={ss.sectionLabel}>CAMPO HARMÔNICO</Text>
        <View style={{ height: 12 }} />
        <HarmonicFieldChips chords={harmonicField} quality={quality} />
      </View>

      <TouchableOpacity testID="detect-again-btn" onPress={onAgain} activeOpacity={0.85} style={ss.againBtn}>
        <Ionicons name="refresh" size={18} color={Colors.bg} />
        <Text style={ss.againTxt}>Detectar novamente</Text>
      </TouchableOpacity>

      <View style={ss.footnoteBox}>
        <Ionicons name="sparkles-outline" size={13} color={Colors.gold} />
        <Text style={ss.footnoteTxt}>
          Resultado gerado por análise inteligente em tempo real
        </Text>
      </View>
    </Animated.View>
  );
}

// ═════════════════════════════════════════════════════════════════════════
// MIC NOTICE MODAL
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
          <Ionicons name={icon} size={36} color={Colors.gold} style={{ marginBottom: 12 }} />
          <Text style={ss.modalTitle}>
            {isPerm ? 'Microfone bloqueado' : isLimit ? 'Recurso nativo' : 'Aviso'}
          </Text>
          <Text style={ss.modalMsg}>{message ?? 'Algo deu errado.'}</Text>
          <View style={{ height: 18 }} />
          {isBlocked && Platform.OS !== 'web' ? (
            <TouchableOpacity
              testID="open-settings-btn"
              style={ss.modalPrimary}
              onPress={async () => { try { await Linking.openSettings(); } catch {} }}
              activeOpacity={0.85}
            >
              <Text style={ss.modalPrimaryTxt}>Abrir Configurações</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              testID="retry-btn"
              style={ss.modalPrimary}
              onPress={onRetry}
              activeOpacity={0.85}
            >
              <Text style={ss.modalPrimaryTxt}>{isPerm ? 'Permitir Microfone' : 'Tentar novamente'}</Text>
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

// ═════════════════════════════════════════════════════════════════════════
// STYLES
// ═════════════════════════════════════════════════════════════════════════
const ss = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },

  // INITIAL
  initialRoot: {
    flex: 1, alignItems: 'center', justifyContent: 'space-between',
    paddingTop: SH * 0.05, paddingHorizontal: 24, paddingBottom: 8,
  },
  brandBlock: {
    alignItems: 'center', gap: 8, marginTop: 24,
  },
  logoCircle: {
    width: 96, height: 96, borderRadius: 48,
    backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.goldBorder,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: Colors.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.45, shadowRadius: 24, elevation: 10,
    marginBottom: 8,
  },
  logoImg: { width: 64, height: 64 },
  brandTitle: {
    color: Colors.white,
    fontFamily: Typography.bold,
    fontSize: 32,
    letterSpacing: 0.5,
  },
  brandSub: {
    color: Colors.text2,
    fontFamily: Typography.regular,
    fontSize: 13,
    letterSpacing: 0.3,
  },
  micSection: {
    alignItems: 'center', gap: 20,
  },
  micLabel: {
    color: Colors.textMuted,
    fontFamily: Typography.medium,
    fontSize: 14,
    letterSpacing: 0.5,
  },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 9,
    backgroundColor: Colors.redSoft,
    borderRadius: Radius.pill,
    borderWidth: 1, borderColor: 'rgba(239,68,68,0.30)',
    maxWidth: '90%',
  },
  errorTxt: { color: Colors.red, fontFamily: Typography.medium, fontSize: 12 },

  // ACTIVE
  activeRoot: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingTop: 6,
    paddingBottom: 12,
    gap: 12,
  },
  miniLogoWrap: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.goldBorderSoft,
    alignItems: 'center', justifyContent: 'center',
  },
  miniLogo: { width: 22, height: 22 },
  statusPillSlot: { flex: 1, alignItems: 'center' },
  iconBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  scroll: {
    paddingHorizontal: Spacing.lg,
    paddingTop: 8,
    paddingBottom: 110, // espaço para BottomNav
  },

  // Hero / Live note
  heroBlock: { gap: 14 },
  heroLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  heroLabel: {
    color: Colors.text2,
    fontFamily: Typography.semi,
    fontSize: 11,
    letterSpacing: 1.6,
  },
  noteBox: { alignItems: 'center', paddingVertical: 8 },
  noteBig: {
    color: Colors.white,
    fontFamily: Typography.bold,
    fontSize: 96,
    lineHeight: 100,
    letterSpacing: -2,
  },
  noteIntl: {
    color: Colors.textMuted,
    fontFamily: Typography.medium,
    fontSize: 18,
    marginTop: -4,
  },
  listeningWrap: { alignItems: 'center', height: 110, justifyContent: 'center', gap: 4 },
  listeningTitle: { color: Colors.white, fontFamily: Typography.bold, fontSize: 32 },
  listeningSub: { color: Colors.text2, fontFamily: Typography.regular, fontSize: 13 },
  waveformWrap: {
    paddingHorizontal: 8,
  },
  sectionLabel: {
    color: Colors.text2,
    fontFamily: Typography.semi,
    fontSize: 11,
    letterSpacing: 1.6,
    marginBottom: 10,
  },

  // Analyzing
  workingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.goldBorderSoft,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 14,
    width: '100%',
  },
  workingTitle: { color: Colors.white, fontFamily: Typography.semi, fontSize: 14 },
  workingSub: { color: Colors.text2, fontFamily: Typography.regular, fontSize: 12, marginTop: 2 },

  // Result
  resultLabel: {
    color: Colors.text2,
    fontFamily: Typography.semi,
    fontSize: 11,
    letterSpacing: 1.6,
    marginTop: 8,
  },
  resultKeyRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
  },
  resultNote: {
    color: Colors.white,
    fontFamily: Typography.bold,
    fontSize: 78,
    lineHeight: 84,
    letterSpacing: -1.5,
  },
  resultQual: {
    color: Colors.textMuted,
    fontFamily: Typography.medium,
    fontSize: 26,
    marginBottom: 14,
  },
  resultIntl: {
    color: Colors.gold,
    fontFamily: Typography.semi,
    fontSize: 17,
    marginTop: -4,
  },
  confLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  confLabel: { color: Colors.textMuted, fontFamily: Typography.medium, fontSize: 13 },
  confPct: { color: Colors.green, fontFamily: Typography.bold, fontSize: 17 },
  confTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.surface3,
    overflow: 'hidden',
  },
  confFill: {
    height: '100%',
    borderRadius: 4,
    backgroundColor: Colors.green,
    shadowColor: Colors.green,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.45,
    shadowRadius: 6,
  },
  againBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: Colors.gold,
    borderRadius: Radius.pill,
    paddingVertical: 16,
    shadowColor: Colors.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.55,
    shadowRadius: 16,
    elevation: 8,
    borderWidth: 2,
    borderColor: Colors.goldLight,
  },
  againTxt: {
    color: Colors.bg,
    fontFamily: Typography.bold,
    fontSize: 15,
    letterSpacing: 0.3,
  },
  footnoteBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  footnoteTxt: {
    color: Colors.text2,
    fontFamily: Typography.regular,
    fontSize: 12,
    flex: 1,
    lineHeight: 17,
  },

  // Modal
  modalBg: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.78)',
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modalCard: {
    width: '100%', maxWidth: 360,
    backgroundColor: Colors.surface,
    borderRadius: Radius.xl,
    borderWidth: 1, borderColor: Colors.borderStrong,
    paddingHorizontal: 24, paddingVertical: 28,
    alignItems: 'center',
  },
  modalTitle: {
    color: Colors.white,
    fontFamily: Typography.bold,
    fontSize: 18,
    marginBottom: 8,
  },
  modalMsg: {
    color: Colors.textMuted,
    fontFamily: Typography.regular,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  modalPrimary: {
    backgroundColor: Colors.gold,
    borderRadius: Radius.pill,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 8,
    width: '100%',
  },
  modalPrimaryTxt: {
    color: Colors.bg,
    fontFamily: Typography.bold,
    fontSize: 14,
  },
  modalSecondary: {
    paddingVertical: 12,
    alignItems: 'center',
    width: '100%',
  },
  modalSecondaryTxt: {
    color: Colors.text2,
    fontFamily: Typography.medium,
    fontSize: 13,
  },
});
