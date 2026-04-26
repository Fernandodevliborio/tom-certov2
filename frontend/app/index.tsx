import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated, Dimensions,
  Easing, Platform, Modal, ScrollView, Linking, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';

import { useKeyDetection } from '../src/hooks/useKeyDetection';
import { NOTES_BR, NOTES_INTL, formatKeyDisplay, getHarmonicField } from '../src/utils/noteUtils';
import { Colors, Radius, Spacing, Typography } from '../src/theme/tokens';
import { GoldWaveform } from '../src/components/GoldWaveform';
import { HarmonicFieldChips } from '../src/components/HarmonicFieldChips';

const { height: SH } = Dimensions.get('window');

export default function HomeScreen() {
  const det = useKeyDetection();
  const screen: 'initial' | 'active' = det.isRunning ? 'active' : 'initial';
  return (
    <SafeAreaView testID="home-screen" style={ss.safe} edges={['top', 'bottom']}>
      {screen === 'initial'
        ? <InitialScreen onStart={det.start} errorMessage={det.errorMessage} errorReason={det.errorReason} />
        : <ActiveScreen det={det} />
      }
    </SafeAreaView>
  );
}

// ═════════════════════════════════════════════════════════════════════════
// INITIAL SCREEN — mínimo: logo pequena + mic + texto
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
  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 280, useNativeDriver: true }).start();
  }, []);

  return (
    <Animated.View testID="initial-screen" style={[ss.initialRoot, { opacity: fadeIn }]}>
      {/* Settings icon - canto superior direito */}
      <TouchableOpacity
        testID="settings-btn"
        style={ss.settingsBtn}
        onPress={() => router.push('/configuracoes')}
        activeOpacity={0.7}
      >
        <Ionicons name="settings-outline" size={20} color={Colors.text2} />
      </TouchableOpacity>

      {/* Logo + nome compacto */}
      <View style={ss.brandBlock}>
        <Image source={require('../assets/images/logo.png')} style={ss.logoSmall} resizeMode="contain" />
        <Text style={ss.brandTitle}>Tom Certo</Text>
      </View>

      {/* Mic central */}
      <View style={ss.micSection}>
        <SimpleMicButton onPress={onStart} />
        <Text style={ss.micLabel}>Toque para começar</Text>
      </View>

      {/* Espaço inferior */}
      <View style={{ height: 40 }} />

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

// ─── Botão de microfone simples ─────────────────────────────────────────
function SimpleMicButton({ onPress }: { onPress: () => void }) {
  const scale = useRef(new Animated.Value(1)).current;
  const breath = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const br = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(breath, { toValue: 0, duration: 1600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    br.start();
    return () => br.stop();
  }, []);

  const breathScale = breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1.04] });
  const breathOpacity = breath.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] });

  return (
    <TouchableOpacity
      testID="start-btn"
      onPress={onPress}
      onPressIn={() => Animated.spring(scale, { toValue: 0.94, useNativeDriver: true }).start()}
      onPressOut={() => Animated.spring(scale, { toValue: 1, friction: 5, useNativeDriver: true }).start()}
      activeOpacity={1}
    >
      <Animated.View
        style={[
          ssMic.btn,
          {
            opacity: breathOpacity,
            transform: [{ scale: Animated.multiply(scale, breathScale) }],
          },
        ]}
      >
        <Ionicons name="mic" size={56} color={Colors.bg} />
      </Animated.View>
    </TouchableOpacity>
  );
}

const ssMic = StyleSheet.create({
  btn: {
    width: 128,
    height: 128,
    borderRadius: 64,
    backgroundColor: Colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: Colors.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.40,
    shadowRadius: 18,
    elevation: 8,
  },
});

// ═════════════════════════════════════════════════════════════════════════
// ACTIVE SCREEN — direto: nota + waveform + tom (assim que houver)
// ═════════════════════════════════════════════════════════════════════════
function ActiveScreen({ det }: { det: ReturnType<typeof useKeyDetection> }) {
  const {
    currentNote, audioLevel, isRunning,
    reset, mlResult,
  } = det;

  // ─── Tracking probabilidades — mostra cedo, refina depois ─────────────
  const MIN_DISPLAY_CONF = 0.30;       // mostra com 30%+
  const MIN_REFINE_CONF = 0.55;        // refinando: laranja
  const MIN_LOCK_CONF = 0.85;          // confirmado: verde
  const LOCK_REPLACE_MARGIN = 0.10;
  const LOCK_WINDOW_SIZE = 3;

  const lockWindowRef = useRef<Array<{ tonic: number; quality: 'major' | 'minor'; confidence: number }>>([]);
  const lockedKeyRef = useRef<{
    tonic: number; quality: 'major' | 'minor'; key_name: string; confidence: number; at: number;
  } | null>(null);
  const [tick, setTick] = useState(0);

  // Probable key contínuo (mostra cedo)
  const probableKeyRef = useRef<{ tonic: number; quality: 'major' | 'minor'; confidence: number } | null>(null);

  useEffect(() => {
    if (!mlResult?.success || mlResult.tonic === undefined || !mlResult.quality) return;
    const conf = mlResult.confidence ?? 0;
    const tonic = mlResult.tonic;
    const quality = mlResult.quality as 'major' | 'minor';
    const keyName = mlResult.key_name || '';

    // ─── Probable (mostra com 30%+) ────────────────────────────
    if (conf >= MIN_DISPLAY_CONF) {
      const cur = probableKeyRef.current;
      if (!cur || (cur.tonic === tonic && cur.quality === quality)) {
        probableKeyRef.current = { tonic, quality, confidence: conf };
      } else if (conf >= cur.confidence + 0.05) {
        // Só troca se nova proposta tem confiança claramente maior
        probableKeyRef.current = { tonic, quality, confidence: conf };
      }
      setTick(t => t + 1);
    }

    // ─── Lock (confirma com 85%+ e janela estável) ────────────
    if (conf < MIN_LOCK_CONF * 0.65) return;   // 0.55+ entra na janela
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
    let best: { count: number; sumConf: number; tonic: number; quality: 'major' | 'minor' } | null = null;
    for (const v of counts.values()) {
      if (!best || v.count > best.count ||
          (v.count === best.count && v.sumConf > best.sumConf)) best = v;
    }
    if (!best) return;
    const avgConf = best.sumConf / best.count;

    if (!lockedKeyRef.current) {
      if (best.count >= 2 && avgConf >= MIN_LOCK_CONF) {
        lockedKeyRef.current = { tonic: best.tonic, quality: best.quality, key_name: keyName, confidence: avgConf, at: Date.now() };
        setTick(t => t + 1);
      }
      return;
    }
    const cur = lockedKeyRef.current;
    if (cur.tonic === best.tonic && cur.quality === best.quality) {
      cur.confidence = Math.max(cur.confidence, avgConf);
      cur.at = Date.now();
    } else if (best.count >= 2 && avgConf >= cur.confidence + LOCK_REPLACE_MARGIN && avgConf >= MIN_LOCK_CONF) {
      lockedKeyRef.current = { tonic: best.tonic, quality: best.quality, key_name: keyName, confidence: avgConf, at: Date.now() };
      setTick(t => t + 1);
    }
  }, [mlResult?.confidence, mlResult?.tonic, mlResult?.quality, mlResult?.success]);

  useEffect(() => {
    if (!isRunning) {
      lockedKeyRef.current = null;
      lockWindowRef.current = [];
      probableKeyRef.current = null;
      setTick(t => t + 1);
    }
  }, [isRunning]);

  // ─── Estado UI derivado ───────────────────────────────────────────────
  const stage: 'listening' | 'probable' | 'refining' | 'confirmed' = useMemo(() => {
    if (lockedKeyRef.current) return 'confirmed';
    const p = probableKeyRef.current;
    if (!p) return 'listening';
    if (p.confidence >= MIN_REFINE_CONF) return 'refining';
    return 'probable';
  }, [tick]);

  const displayKey = useMemo(() => {
    if (lockedKeyRef.current) return {
      root: lockedKeyRef.current.tonic,
      quality: lockedKeyRef.current.quality,
      confidence: lockedKeyRef.current.confidence,
    };
    if (probableKeyRef.current) return {
      root: probableKeyRef.current.tonic,
      quality: probableKeyRef.current.quality,
      confidence: probableKeyRef.current.confidence,
    };
    return null;
  }, [tick]);

  const onDetectAgain = useCallback(() => {
    lockedKeyRef.current = null;
    lockWindowRef.current = [];
    probableKeyRef.current = null;
    setTick(t => t + 1);
    reset();
  }, [reset]);

  const fadeIn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 220, useNativeDriver: true }).start();
  }, []);

  // ─── Renderização ─────────────────────────────────────────────────────
  return (
    <Animated.View testID="active-screen" style={[ss.activeRoot, { opacity: fadeIn }]}>
      {/* Top bar: mini-logo + close */}
      <View style={ss.topBar}>
        <Image source={require('../assets/images/logo.png')} style={ss.topLogo} resizeMode="contain" />
        <View style={{ flex: 1 }} />
        <TouchableOpacity testID="stop-btn" onPress={reset} style={ss.closeBtn} activeOpacity={0.7}>
          <Ionicons name="close" size={20} color={Colors.textMuted} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={ss.scroll}
        showsVerticalScrollIndicator={false}
      >
        {stage === 'confirmed' ? (
          <ResultBlock
            root={displayKey!.root}
            quality={displayKey!.quality}
            confPct={Math.round(displayKey!.confidence * 100)}
            onAgain={onDetectAgain}
          />
        ) : (
          <LiveBlock
            currentNote={currentNote}
            audioLevel={audioLevel}
            isRunning={isRunning}
            displayKey={displayKey}
            stage={stage}
          />
        )}
      </ScrollView>
    </Animated.View>
  );
}

// ─── LIVE BLOCK (nota + onda + tom progressivo) ─────────────────────────
function LiveBlock({
  currentNote, audioLevel, isRunning, displayKey, stage,
}: {
  currentNote: number | null;
  audioLevel: number;
  isRunning: boolean;
  displayKey: { root: number; quality: 'major' | 'minor'; confidence: number } | null;
  stage: 'listening' | 'probable' | 'refining';
}) {
  const noteOpacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(noteOpacity, {
      toValue: currentNote !== null ? 1 : 0.35,
      duration: 140, useNativeDriver: true,
    }).start();
  }, [currentNote]);

  const stageLabel = stage === 'listening'
    ? 'OUVINDO…'
    : stage === 'probable'
    ? 'TOM PROVÁVEL'
    : 'REFINANDO';

  const stageColor = stage === 'listening'
    ? Colors.text2
    : stage === 'probable'
    ? Colors.gold
    : Colors.goldLight;

  return (
    <View style={{ gap: 36 }}>
      {/* Nota grande */}
      <View style={ss.heroBlock}>
        <Animated.View style={[ss.noteBox, { opacity: noteOpacity }]}>
          {currentNote !== null ? (
            <>
              <Text style={ss.noteBig} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>
                {NOTES_BR[currentNote]}
              </Text>
              <Text style={ss.noteIntl}>{NOTES_INTL[currentNote]}</Text>
            </>
          ) : (
            <View style={ss.noteBoxPlaceholder}>
              <Text style={ss.notePlaceholder}>—</Text>
              <Text style={ss.notePlaceholderSub}>cante ou toque algumas notas</Text>
            </View>
          )}
        </Animated.View>
        <View style={ss.waveformWrap}>
          <GoldWaveform level={audioLevel} active={isRunning} height={44} bars={42} />
        </View>
      </View>

      {/* Card de tom — sempre visível, refina ao longo do tempo */}
      <View style={ss.keyCard}>
        <View style={ss.keyCardHeader}>
          <Text style={[ss.stageLabel, { color: stageColor }]}>{stageLabel}</Text>
          {displayKey ? (
            <View style={ss.confBadge}>
              <Text style={ss.confBadgeTxt}>{Math.round(displayKey.confidence * 100)}%</Text>
            </View>
          ) : null}
        </View>

        {displayKey ? (
          <KeyDisplay root={displayKey.root} quality={displayKey.quality} confidence={displayKey.confidence} />
        ) : (
          <Text style={ss.keyEmpty}>analisando…</Text>
        )}
      </View>
    </View>
  );
}

function KeyDisplay({ root, quality, confidence }: { root: number; quality: 'major' | 'minor'; confidence: number }) {
  const k = formatKeyDisplay(root, quality);
  const widthAnim = useRef(new Animated.Value(0)).current;
  const pct = Math.round(confidence * 100);

  useEffect(() => {
    Animated.timing(widthAnim, {
      toValue: pct,
      duration: 350, useNativeDriver: false,
    }).start();
  }, [pct]);

  const color = pct >= 85 ? Colors.green : pct >= 60 ? Colors.gold : Colors.text2;

  return (
    <View style={{ gap: 10 }}>
      <View style={ss.keyRow}>
        <Text style={ss.keyNote}>{k.noteBr}</Text>
        <Text style={ss.keyQual}>{k.qualityLabel}</Text>
      </View>
      <Text style={ss.keyIntl}>{k.noteIntl}</Text>
      <View style={ss.confBar}>
        <Animated.View
          style={[
            ss.confFill,
            {
              backgroundColor: color,
              width: widthAnim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
            },
          ]}
        />
      </View>
    </View>
  );
}

// ─── RESULT BLOCK ───────────────────────────────────────────────────────
function ResultBlock({
  root, quality, confPct, onAgain,
}: {
  root: number;
  quality: 'major' | 'minor';
  confPct: number;
  onAgain: () => void;
}) {
  const k = formatKeyDisplay(root, quality);
  const widthAnim = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const harmonicField = useMemo(() => getHarmonicField(root, quality), [root, quality]);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 360, useNativeDriver: true }),
      Animated.timing(widthAnim, { toValue: confPct, duration: 600, useNativeDriver: false }),
    ]).start();
  }, []);

  return (
    <Animated.View style={{ opacity: fade, gap: 28 }}>
      {/* Status verde */}
      <View style={ss.confirmedPill}>
        <Ionicons name="checkmark-circle" size={14} color={Colors.green} />
        <Text style={ss.confirmedTxt}>TONALIDADE IDENTIFICADA</Text>
      </View>

      {/* Tom grande */}
      <View style={{ alignItems: 'center', gap: 4 }}>
        <View style={ss.resultKeyRow}>
          <Text style={ss.resultNote} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>
            {k.noteBr}
          </Text>
          <Text style={ss.resultQual}>{k.qualityLabel}</Text>
        </View>
        <Text style={ss.resultIntl}>{k.noteIntl}</Text>
      </View>

      {/* Confiança */}
      <View style={{ gap: 8 }}>
        <View style={ss.confLabelRow}>
          <Text style={ss.confLabel}>Confiança</Text>
          <Text style={[ss.confPct, { color: Colors.green }]}>{confPct}%</Text>
        </View>
        <View style={ss.confTrack}>
          <Animated.View
            style={[
              ss.confTrackFill,
              {
                width: widthAnim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
              },
            ]}
          />
        </View>
      </View>

      {/* Campo harmônico */}
      <View>
        <Text style={ss.sectionLabel}>CAMPO HARMÔNICO</Text>
        <View style={{ height: 12 }} />
        <HarmonicFieldChips chords={harmonicField} quality={quality} />
      </View>

      {/* Botão Detectar Novamente */}
      <TouchableOpacity testID="detect-again-btn" onPress={onAgain} activeOpacity={0.85} style={ss.againBtn}>
        <Ionicons name="refresh" size={18} color={Colors.bg} />
        <Text style={ss.againTxt}>Detectar novamente</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ═════════════════════════════════════════════════════════════════════════
// MIC NOTICE MODAL (inalterado)
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
            <TouchableOpacity testID="retry-btn" style={ss.modalPrimary} onPress={onRetry} activeOpacity={0.85}>
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
    paddingTop: SH * 0.10, paddingHorizontal: 28, paddingBottom: 32,
  },
  settingsBtn: {
    position: 'absolute',
    top: 12,
    right: 16,
    width: 40, height: 40,
    alignItems: 'center', justifyContent: 'center',
  },
  brandBlock: {
    alignItems: 'center', gap: 10, marginTop: 8,
  },
  logoSmall: { width: 48, height: 48 },
  brandTitle: {
    color: Colors.white,
    fontFamily: Typography.bold,
    fontSize: 22,
    letterSpacing: 0.4,
  },
  micSection: {
    alignItems: 'center', gap: 26,
  },
  micLabel: {
    color: Colors.textMuted,
    fontFamily: Typography.medium,
    fontSize: 14,
    letterSpacing: 0.4,
  },

  // ACTIVE
  activeRoot: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingTop: 6,
    paddingBottom: 8,
    gap: 12,
  },
  topLogo: { width: 28, height: 28 },
  closeBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  scroll: {
    paddingHorizontal: Spacing.lg,
    paddingTop: 12,
    paddingBottom: 32,
  },

  // Live
  heroBlock: { gap: 14 },
  noteBox: { alignItems: 'center', paddingVertical: 12 },
  noteBoxPlaceholder: { alignItems: 'center', height: 110, justifyContent: 'center', gap: 4 },
  notePlaceholder: {
    color: Colors.text3,
    fontFamily: Typography.bold,
    fontSize: 80,
    lineHeight: 84,
  },
  notePlaceholderSub: {
    color: Colors.text2,
    fontFamily: Typography.regular,
    fontSize: 13,
  },
  noteBig: {
    color: Colors.white,
    fontFamily: Typography.bold,
    fontSize: 110,
    lineHeight: 114,
    letterSpacing: -3,
  },
  noteIntl: {
    color: Colors.textMuted,
    fontFamily: Typography.medium,
    fontSize: 18,
    marginTop: -4,
  },
  waveformWrap: {
    paddingHorizontal: 8,
  },

  // Key card
  keyCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
    gap: 12,
  },
  keyCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  stageLabel: {
    fontFamily: Typography.semi,
    fontSize: 11,
    letterSpacing: 1.5,
  },
  confBadge: {
    paddingHorizontal: 9,
    paddingVertical: 3,
    backgroundColor: Colors.goldMuted,
    borderRadius: Radius.pill,
    borderWidth: 1,
    borderColor: Colors.goldBorder,
  },
  confBadgeTxt: {
    color: Colors.gold,
    fontFamily: Typography.bold,
    fontSize: 11,
    letterSpacing: 0.3,
  },
  keyEmpty: {
    color: Colors.text2,
    fontFamily: Typography.medium,
    fontSize: 14,
    fontStyle: 'italic',
    paddingVertical: 12,
  },
  keyRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  keyNote: { color: Colors.white, fontFamily: Typography.bold, fontSize: 36, lineHeight: 40 },
  keyQual: { color: Colors.textMuted, fontFamily: Typography.medium, fontSize: 18, marginBottom: 6 },
  keyIntl: { color: Colors.text2, fontFamily: Typography.regular, fontSize: 13, marginTop: -4 },

  confBar: {
    height: 5,
    borderRadius: 3,
    backgroundColor: Colors.surface3,
    overflow: 'hidden',
    marginTop: 4,
  },
  confFill: { height: '100%', borderRadius: 3 },

  sectionLabel: {
    color: Colors.text2,
    fontFamily: Typography.semi,
    fontSize: 11,
    letterSpacing: 1.6,
  },

  // Result
  confirmedPill: {
    flexDirection: 'row', alignSelf: 'center',
    alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 7,
    backgroundColor: Colors.greenSoft,
    borderRadius: Radius.pill,
    borderWidth: 1, borderColor: Colors.greenBorder,
  },
  confirmedTxt: {
    color: Colors.green,
    fontFamily: Typography.semi,
    fontSize: 11,
    letterSpacing: 1.4,
  },
  resultKeyRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  resultNote: {
    color: Colors.white,
    fontFamily: Typography.bold,
    fontSize: 84,
    lineHeight: 88,
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
  },
  confLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  confLabel: { color: Colors.textMuted, fontFamily: Typography.medium, fontSize: 13 },
  confPct: { fontFamily: Typography.bold, fontSize: 17 },
  confTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.surface3,
    overflow: 'hidden',
  },
  confTrackFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: Colors.green,
  },
  againBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: Colors.gold,
    borderRadius: Radius.pill,
    paddingVertical: 16,
    marginTop: 4,
  },
  againTxt: {
    color: Colors.bg,
    fontFamily: Typography.bold,
    fontSize: 15,
    letterSpacing: 0.3,
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
