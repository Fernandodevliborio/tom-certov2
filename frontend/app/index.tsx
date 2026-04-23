import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated, Dimensions,
  Easing, Platform, Modal, ScrollView, Linking, Alert, ActivityIndicator,
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
        <Animated.View style={{ opacity: logoGlow }}>
          <View style={ss.logoCircleMain}>
            <Ionicons name="musical-notes" size={88} color={C.amber} />
          </View>
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
    softInfo, reset, phraseStage, phrasesAnalyzed,
    smartStatus, mlResult,
  } = det;

  const mlKey = useMemo(() => {
    if (!mlResult?.success || mlResult.tonic === undefined || !mlResult.quality) return null;
    return { root: mlResult.tonic, quality: mlResult.quality as 'major' | 'minor' };
  }, [mlResult?.tonic, mlResult?.quality, mlResult?.success]);

  const confirmedKey = mlKey || (keyTier === 'confirmed' ? currentKey : null);
  const provisionalKey = mlKey ? null : (keyTier === 'provisional' ? currentKey : null);
  const displayKey = confirmedKey || provisionalKey;

  const confPct = mlResult?.success
    ? Math.round((mlResult.confidence ?? 0) * 100)
    : Math.round(Math.max(0, liveConfidence) * 100);
  const confColor = confPct >= 75 ? C.green : confPct >= 55 ? C.amber : C.text2;

  const statusLabel = (() => {
    if (!isRunning) return 'TOQUE PARA COMEÇAR';
    if (smartStatus === 'confirmed') return 'TOM IDENTIFICADO';
    if (smartStatus === 'analyzing') return 'ANALISANDO O TOM...';
    if (smartStatus === 'listening') return 'OUVINDO SUA VOZ...';
    if (smartStatus === 'warming') return 'OUVINDO SUA VOZ...';
    if (phraseStage === 'listening') return 'OUVINDO SUA VOZ...';
    if (phraseStage === 'probable') return 'IDENTIFICANDO TONALIDADE...';
    if (phraseStage === 'confirmed') return 'CONFIRMANDO TOM...';
    if (phraseStage === 'definitive') return 'TOM IDENTIFICADO';
    return 'PRONTO';
  })();

  const statusDotColor = (() => {
    if (!isRunning) return C.text3;
    if (smartStatus === 'confirmed' || phraseStage === 'definitive') return C.green;
    if (smartStatus === 'analyzing') return C.amber;
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
      {/* Header */}
      <View style={ss.activeHeader}>
        <Ionicons name="musical-notes" size={22} color={C.amber} />
        <Text style={ss.headerBrand}>Tom Certo</Text>
        <View style={ss.headerStatusRow}>
          <Animated.View style={[ss.statusDot, { backgroundColor: statusDotColor, opacity: statusDot }]} />
          <Text style={ss.headerStatusTxt}>{statusLabel}</Text>
        </View>
        <TouchableOpacity testID="stop-btn" onPress={reset} style={ss.headerCloseBtn}>
          <Ionicons name="close" size={16} color={C.text2} />
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={ss.scrollPad}>
        {/* Note Hero */}
        <View style={ss.noteHero}>
          <View style={ss.noteHeroTopRow}>
            <Text style={ss.noteHeroLabel}>NOTA EM TEMPO REAL</Text>
            <AudioVisualizer level={audioLevel} active={isRunning} height={28} bars={5} />
          </View>
          <Animated.View style={[ss.noteHeroBox, { opacity: noteOpacity }]}>
            {currentNote !== null ? (
              <>
                <Text testID="current-note" style={ss.noteHeroTxt}>{NOTES_BR[currentNote]}</Text>
                <Text style={ss.noteHeroIntl}>{NOTES_INTL[currentNote]}</Text>
              </>
            ) : (
              <View style={ss.listeningHero}>
                <Text style={ss.listeningTitle}>
                  {detectionState === 'analyzing' ? 'Analisando...' : 'Ouvindo'}
                </Text>
                <Text style={ss.listeningSub}>
                  Cante ou toque — o app já começou a captar
                </Text>
              </View>
            )}
          </Animated.View>
        </View>

        {/* History */}
        <View style={ss.section}>
          <Text style={ss.sectionLabel}>HISTÓRICO</Text>
          <View style={ss.historyRow}>
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
          </View>
        </View>

        {/* Key Card */}
        {displayKey && (
          <View testID="key-card" style={[ss.keyCard, confirmedKey ? ss.keyCardConfirmed : ss.keyCardProv]}>
            <View style={ss.keyCardHeader}>
              <View style={[
                ss.keyCardBadge,
                { borderColor: confirmedKey ? 'rgba(34,197,94,0.35)' : C.amberBorder },
              ]}>
                <Ionicons
                  name={confirmedKey ? 'checkmark-circle' : 'radio-button-on'}
                  size={11}
                  color={confirmedKey ? C.green : C.amber}
                />
                <Text style={[ss.keyCardBadgeTxt, { color: confirmedKey ? C.green : C.amber }]}>
                  {confirmedKey ? 'TOM IDENTIFICADO' : 'IDENTIFICANDO...'}
                </Text>
              </View>
              <Text style={[ss.keyCardConfPct, { color: confColor }]}>{confPct}%</Text>
            </View>
            <KeyDisplay root={displayKey.root} quality={displayKey.quality} provisional={!confirmedKey} />
            <ConfidenceBar pct={confPct} color={confColor} />
          </View>
        )}

        {/* Change Banner */}
        {changeSuggestion && (
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

        {/* Harmonic Field */}
        {displayKey && harmonicField.length > 0 && (
          <View style={ss.section}>
            <Text style={ss.sectionLabel}>CAMPO HARMÔNICO</Text>
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

        {/* Soft Info */}
        {softInfo ? (
          <View style={ss.softBar}>
            <Ionicons name="information-circle-outline" size={14} color={C.amber} />
            <Text style={ss.softBarTxt}>{softInfo}</Text>
          </View>
        ) : null}
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
  logoCircleMain: {
    width: 130, height: 130, borderRadius: 65,
    backgroundColor: 'rgba(255,176,32,0.10)',
    borderWidth: 1, borderColor: 'rgba(255,176,32,0.25)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 12,
  },
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
  activeRoot: { flex: 1, paddingHorizontal: 16, paddingTop: 6 },
  activeHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: C.border, marginBottom: 8,
  },
  headerBrand: { fontFamily: 'Outfit_700Bold', fontSize: 15, color: C.white, flex: 1, letterSpacing: -0.3 },
  headerStatusRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: C.surface, borderRadius: 10, borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 9, paddingVertical: 5,
  },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  headerStatusTxt: { fontFamily: 'Manrope_600SemiBold', fontSize: 10, color: C.text2, letterSpacing: 1.5 },
  headerCloseBtn: {
    width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, marginLeft: 4,
  },
  scrollPad: { paddingBottom: 24, gap: 14 },

  noteHero: {
    backgroundColor: C.surface, borderRadius: 18, borderWidth: 1, borderColor: C.border,
    overflow: 'hidden',
  },
  noteHeroTopRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingTop: 14, paddingBottom: 2,
  },
  noteHeroLabel: { fontFamily: 'Manrope_600SemiBold', fontSize: 10, color: C.text3, letterSpacing: 2.5 },
  noteHeroBox: { alignItems: 'center', paddingBottom: 16 },
  noteHeroTxt: {
    fontFamily: 'Outfit_800ExtraBold', fontSize: 112, color: C.white,
    letterSpacing: -5, lineHeight: 120,
    ...Platform.select({
      ios: { textShadowColor: C.amberGlow, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 32 },
      default: {},
    }),
  },
  noteHeroIntl: {
    fontFamily: 'Manrope_500Medium', fontSize: 14, color: C.text2, letterSpacing: 1, marginTop: -8,
  },
  listeningHero: { alignItems: 'center', paddingVertical: 30, paddingHorizontal: 20 },
  listeningTitle: {
    fontFamily: 'Outfit_800ExtraBold', fontSize: 30, color: C.white, letterSpacing: -1, marginBottom: 4,
  },
  listeningSub: {
    fontFamily: 'Manrope_400Regular', fontSize: 13, color: C.text2, textAlign: 'center', maxWidth: 260,
  },

  section: { gap: 8 },
  sectionLabel: {
    fontFamily: 'Manrope_600SemiBold', fontSize: 10, color: C.text3, letterSpacing: 2.5, paddingHorizontal: 2,
  },
  historyRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 6,
    paddingVertical: 10, paddingHorizontal: 12,
    backgroundColor: C.surface, borderRadius: 12, borderWidth: 1, borderColor: C.border,
    minHeight: 44, alignItems: 'center',
  },
  historyEmpty: { fontFamily: 'Manrope_400Regular', fontSize: 11, color: C.text3, fontStyle: 'italic' },
  historyChip: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    minWidth: 32, alignItems: 'center',
  },
  historyChipActive: { backgroundColor: 'rgba(255,176,32,0.14)', borderColor: 'rgba(255,176,32,0.50)' },
  historyChipTxt: { fontFamily: 'Outfit_700Bold', fontSize: 12, color: C.text2, letterSpacing: 0.3 },
  historyChipTxtActive: { color: C.amber },

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
