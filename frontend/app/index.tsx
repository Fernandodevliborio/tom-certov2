import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated, Dimensions,
  Easing, Platform, Modal, ScrollView, Linking, Alert, ActivityIndicator, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Updates from 'expo-updates';
import { router } from 'expo-router';

import { useKeyDetection } from '../src/hooks/useKeyDetection';
import { NOTES_BR, NOTES_INTL, formatKeyDisplay, getHarmonicField } from '../src/utils/noteUtils';
import { useAuth } from '../src/auth/AuthContext';
import { APP_VERSION_LABEL } from '../src/constants/version';
import AudioVisualizer from '../src/components/AudioVisualizer';
import {
  StableKeyState,
  createStableKeyState,
  processAnalysis,
  resetStableKeyState,
  softResetStableKeyState,
  getUserVisibleState,
  shouldShowKey,
  getDisplayKey,
  hasRecentKeyChange,
  incrementVisualConfidence,
  STABLE_KEY_CONFIG,
} from '../src/utils/stableKeyEngine';

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

// ═══════════════════════════════════════════════════════════════════════════
// INITIAL SCREEN — REFATORADA COM HIERARQUIA CLARA
// ═══════════════════════════════════════════════════════════════════════════
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

  // OTA auto-check
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

  // Navegação segura para o afinador
  const goToTuner = () => {
    try {
      router.push('/tuner');
    } catch (err) {
      Alert.alert('Erro', 'Não foi possível abrir o afinador. Tente novamente.');
    }
  };

  useEffect(() => {
    if (errorMessage && errorMessage !== prevErr.current) setModalVisible(true);
    prevErr.current = errorMessage;
  }, [errorMessage]);

  // ═══════════════════════════════════════════════════════════════
  // ANIMAÇÕES PREMIUM - OTIMIZADAS: MAIS LENTAS E SUTIS
  // ═══════════════════════════════════════════════════════════════
  const fadeIn = useRef(new Animated.Value(0)).current;
  const slideUp = useRef(new Animated.Value(20)).current;
  const breathe = useRef(new Animated.Value(0)).current;
  const ring1 = useRef(new Animated.Value(0)).current;
  const micScale = useRef(new Animated.Value(1)).current;
  const logoGlow = useRef(new Animated.Value(0.8)).current; // Mais estável

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeIn, { toValue: 1, duration: 450, useNativeDriver: true }), // Aumentado
      Animated.timing(slideUp, { toValue: 0, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }), // Aumentado
    ]).start();

    // Logo glow - MUITO MAIS SUTIL E LENTO
    const logoLoop = Animated.loop(Animated.sequence([
      Animated.timing(logoGlow, { toValue: 1, duration: 4000, useNativeDriver: true }), // 4s vs 2.4s
      Animated.timing(logoGlow, { toValue: 0.8, duration: 4000, useNativeDriver: true }), // Range menor (0.8-1 vs 0.7-1)
    ]));

    // Respiração - MAIS LENTA E SUTIL
    const breatheLoop = Animated.loop(Animated.sequence([
      Animated.timing(breathe, { toValue: 1, duration: 3500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }), // 3.5s vs 2s
      Animated.timing(breathe, { toValue: 0, duration: 3500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));

    // Único anel pulsante - MAIS LENTO
    const ringLoop = Animated.loop(Animated.sequence([
      Animated.timing(ring1, { toValue: 1, duration: 4000, easing: Easing.out(Easing.ease), useNativeDriver: true }), // 4s vs 2.5s
      Animated.timing(ring1, { toValue: 0, duration: 0, useNativeDriver: true }),
    ]));

    logoLoop.start();
    breatheLoop.start();
    ringLoop.start();

    return () => {
      logoLoop.stop();
      breatheLoop.stop();
      ringLoop.stop();
    };
  }, []);

  return (
    <Animated.View testID="initial-screen" style={[ss.initialRoot, { opacity: fadeIn, transform: [{ translateY: slideUp }] }]}>
      
      {/* ═══ HEADER: Logo + Settings ═══ */}
      <View style={ss.header}>
        <TouchableOpacity
          onPress={() => setSettingsOpen(true)}
          style={ss.headerBtn}
          activeOpacity={0.6}
        >
          <Ionicons name="settings-outline" size={20} color={C.text2} />
        </TouchableOpacity>
        
        <View style={ss.headerCenter}>
          <Animated.View style={{ opacity: logoGlow }}>
            <Image
              source={require('../assets/images/logo.png')}
              style={ss.logoSmall}
              resizeMode="contain"
            />
          </Animated.View>
        </View>
        
        <TouchableOpacity
          onPress={onCheckUpdate}
          style={ss.headerBtn}
          activeOpacity={0.6}
          disabled={checkingUpdate}
        >
          {checkingUpdate
            ? <ActivityIndicator size={18} color={C.text2} />
            : <Ionicons name="sync-outline" size={20} color={C.text2} />}
        </TouchableOpacity>
      </View>

      {/* ═══ BRAND BLOCK ═══ */}
      <View style={ss.brandBlock}>
        <Text style={ss.brandTitle}>Tom Certo</Text>
        <Text style={ss.brandSub}>Detecção inteligente de tonalidade</Text>
      </View>

      {/* ═══ MIC SECTION — NÚCLEO DE DETECÇÃO LIMPO ═══ */}
      <View style={ss.micSection}>
        {/* Glow de fundo sutil */}
        <Animated.View 
          style={[
            ss.micBackgroundGlow,
            { opacity: breathe.interpolate({ inputRange: [0, 1], outputRange: [0.12, 0.25] }) } // Reduzido de 0.15-0.35
          ]} 
          pointerEvents="none"
        />
        
        {/* Anel pulsante único (sutil) - MAIS SUTIL */}
        <Animated.View 
          pointerEvents="none" 
          style={[
            ss.micPulseRing,
            {
              opacity: ring1.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.25, 0.1, 0] }), // Reduzido de 0.4-0.15-0
              transform: [{ scale: ring1.interpolate({ inputRange: [0, 1], outputRange: [1, 1.4] }) }], // Reduzido de 1.6
            },
          ]}
        />

        {/* Botão central do microfone - FOCO TOTAL */}
        <TouchableOpacity
          testID="start-btn"
          onPressIn={() => Animated.spring(micScale, { toValue: 0.92, useNativeDriver: true, tension: 300, friction: 10 }).start()}
          onPressOut={() => Animated.spring(micScale, { toValue: 1, useNativeDriver: true, tension: 200, friction: 8 }).start()}
          onPress={onStart}
          activeOpacity={1}
        >
          <Animated.View style={[
            ss.micButtonOuter,
            { 
              transform: [
                { scale: Animated.multiply(micScale, breathe.interpolate({ inputRange: [0, 1], outputRange: [0.995, 1.005] })) } // Quase imperceptível (0.995-1.005 vs 0.98-1.02)
              ] 
            },
          ]}>
            {/* Borda luminosa */}
            <Animated.View style={[
              ss.micGlowBorder,
              { opacity: breathe.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) }
            ]} />
            
            {/* Círculo interno com gradiente visual */}
            <View style={ss.micButtonInner}>
              <Ionicons name="mic" size={56} color={C.amber} />
            </View>
          </Animated.View>
        </TouchableOpacity>
      </View>

      {/* ═══ CALL TO ACTION ═══ */}
      <View style={ss.ctaBlock}>
        <Text style={ss.ctaMain}>Toque para detectar o tom</Text>
        <View style={ss.ctaSubRow}>
          <View style={ss.ctaDot} />
          <Text style={ss.ctaSub}>IA ouvindo em tempo real</Text>
        </View>
      </View>

      {/* ═══ FERRAMENTAS ═══ */}
      <View style={ss.toolsSection}>
        <Text style={ss.toolsLabel}>FERRAMENTAS</Text>
        <View style={ss.toolsRow}>
          <TouchableOpacity
            testID="detect-tool-btn"
            onPress={onStart}
            style={[ss.toolCard, ss.toolCardActive]}
            activeOpacity={0.8}
          >
            <View style={ss.toolIconWrap}>
              <Ionicons name="mic" size={24} color={C.amber} />
            </View>
            <Text style={ss.toolName}>Detectar Tom</Text>
            <Text style={ss.toolDesc}>Análise por IA</Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            testID="tuner-tool-btn"
            onPress={goToTuner}
            style={ss.toolCard}
            activeOpacity={0.8}
          >
            <View style={ss.toolIconWrap}>
              <Ionicons name="musical-note" size={24} color={C.amber} />
            </View>
            <Text style={ss.toolName}>Afinador</Text>
            <Text style={ss.toolDesc}>Afine seu instrumento</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ═══ ERRO INLINE ═══ */}
      {errorMessage && !modalVisible ? (
        <TouchableOpacity style={ss.errorBox} onPress={() => setModalVisible(true)} activeOpacity={0.7}>
          <Ionicons name="alert-circle" size={14} color={C.red} />
          <Text style={ss.errorTxt}>{errorMessage}</Text>
        </TouchableOpacity>
      ) : null}

      <MicNoticeModal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        onRetry={() => { setModalVisible(false); onStart(); }}
        reason={errorReason}
        message={errorMessage}
      />

      {/* Settings Modal */}
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

// ═══════════════════════════════════════════════════════════════════════════
// ACTIVE SCREEN — LÓGICA DE ESTABILIDADE v2.0
// ═══════════════════════════════════════════════════════════════════════════
function ActiveScreen({ det }: { det: ReturnType<typeof useKeyDetection> }) {
  const {
    detectionState, currentKey, keyTier, liveConfidence, changeSuggestion,
    currentNote, recentNotes, audioLevel, isRunning,
    softInfo, reset, phraseStage, phrasesAnalyzed,
    smartStatus, mlResult,
  } = det;

  // ═══════════════════════════════════════════════════════════════════════════
  // NOVO ENGINE DE ESTABILIDADE v2.0
  // ═══════════════════════════════════════════════════════════════════════════
  const [stableState, setStableState] = useState<StableKeyState>(createStableKeyState());
  const [recentKeyChange, setRecentKeyChange] = useState(false);
  
  // Processar novas análises ML
  useEffect(() => {
    if (!mlResult?.success || mlResult.tonic === undefined || !mlResult.quality) return;
    
    const conf = mlResult.confidence ?? 0;
    const tonic = mlResult.tonic;
    const quality = mlResult.quality as 'major' | 'minor';
    const keyName = mlResult.key_name || '';
    
    setStableState(prev => {
      const hadLockedKey = prev.lockedKey !== null;
      const newState = processAnalysis(prev, { tonic, quality, confidence: conf, keyName });
      
      // Detectar mudança de tom
      if (hadLockedKey && newState.lockedKey && 
          (prev.lockedKey!.tonic !== newState.lockedKey.tonic || 
           prev.lockedKey!.quality !== newState.lockedKey.quality)) {
        setRecentKeyChange(true);
        setTimeout(() => setRecentKeyChange(false), 3000);
      }
      
      return newState;
    });
  }, [mlResult?.confidence, mlResult?.tonic, mlResult?.quality, mlResult?.success]);

  // Incrementar confiança visual gradualmente
  useEffect(() => {
    if (!stableState.lockedKey || !isRunning) return;
    
    const timer = setInterval(() => {
      setStableState(prev => incrementVisualConfidence(prev));
    }, 2000);
    
    return () => clearInterval(timer);
  }, [stableState.lockedKey?.tonic, isRunning]);

  // Reset quando para de rodar
  useEffect(() => {
    if (!isRunning) {
      setStableState(createStableKeyState());
      setRecentKeyChange(false);
    }
  }, [isRunning]);

  // ═══════════════════════════════════════════════════════════════════════════
  // DERIVAR ESTADO VISUAL DO ENGINE
  // ═══════════════════════════════════════════════════════════════════════════
  const userVisibleState = getUserVisibleState(stableState);
  const displayKey = getDisplayKey(stableState);
  const showKey = shouldShowKey(stableState);
  
  // Contador de análises (para UI)
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

  // Mensagens dinâmicas para fase de escuta (mais inteligentes)
  const SMART_MESSAGES = [
    { icon: 'ear', label: 'OUVINDO', sub: 'Ouvindo com inteligência…' },
    { icon: 'analytics', label: 'ANALISANDO', sub: 'Analisando estabilidade do tom…' },
    { icon: 'pulse', label: 'VERIFICANDO', sub: 'Verificando consistência musical…' },
    { icon: 'musical-notes', label: 'CAPTANDO', sub: 'Captando mais notas…' },
  ];

  const [dynamicMsgIndex, setDynamicMsgIndex] = useState(0);
  useEffect(() => {
    if (!isRunning || userVisibleState === 'confirmed') {
      setDynamicMsgIndex(0);
      return;
    }
    const interval = setInterval(() => {
      setDynamicMsgIndex(prev => (prev + 1) % SMART_MESSAGES.length);
    }, 3000); // Mais lento (3s)
    return () => clearInterval(interval);
  }, [isRunning, userVisibleState]);

  const statusInfo = useMemo(() => {
    if (userVisibleState === 'confirmed') {
      return { 
        icon: recentKeyChange ? 'swap-horizontal' : 'checkmark-circle', 
        label: recentKeyChange ? 'ATUALIZADO' : 'DETECTADO', 
        sub: recentKeyChange ? 'Nova tonalidade confirmada' : 'Tom identificado com segurança!' 
      };
    }
    
    // Durante escuta/análise: mensagens inteligentes
    if (stableState.internalStage === 'listening') {
      return SMART_MESSAGES[0];
    }
    if (stableState.internalStage === 'candidate' || stableState.internalStage === 'stableCandidate') {
      return SMART_MESSAGES[dynamicMsgIndex];
    }
    return SMART_MESSAGES[dynamicMsgIndex];
  }, [userVisibleState, stableState.internalStage, dynamicMsgIndex, recentKeyChange]);

  // Confiança e cores (usa novo engine)
  const confPct = stableState.visualConfidence;
  const confColor = confPct >= 70 ? C.green : confPct >= 50 ? C.amber : C.text2;
  
  const confLabel = (() => {
    if (!stableState.lockedKey) return '';
    if (confPct >= 90) return 'Alta confiança';
    if (confPct >= 75) return 'Tom estável';
    if (confPct >= 60) return 'Tom confirmado';
    return 'Verificando...';
  })();

  // Status bar label
  const statusLabel = (() => {
    if (!isRunning) return 'TOQUE PARA COMEÇAR';
    if (userVisibleState === 'confirmed') {
      return recentKeyChange ? 'TONALIDADE ATUALIZADA' : 'TOM DETECTADO';
    }
    if (stableState.internalStage === 'candidate' || stableState.internalStage === 'stableCandidate') {
      return 'ANALISANDO ESTABILIDADE…';
    }
    return 'OUVINDO COM INTELIGÊNCIA…';
  })();

  const statusDotColor = (() => {
    if (!isRunning) return C.text3;
    if (userVisibleState === 'confirmed') return C.green;
    if (stableState.internalStage === 'candidate' || stableState.internalStage === 'stableCandidate') {
      return C.amber;
    }
    return C.text2;
  })();

  // Campo harmônico
  const harmonicField = useMemo(
    () => displayKey ? getHarmonicField(displayKey.tonic, displayKey.quality) : [],
    [displayKey?.tonic, displayKey?.quality]
  );

  // Animações
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
              v3.5.0 · {(Updates.updateId ?? 'embedded').slice(0, 8)}
            </Text>
          </View>
        </View>
        <TouchableOpacity testID="stop-btn" onPress={reset} style={ss.headerCloseBtn} activeOpacity={0.7}>
          <Ionicons name="close" size={18} color={C.text2} />
        </TouchableOpacity>
      </View>

      <View style={ss.statusBar}>
        <Animated.View style={[ss.statusDot, { backgroundColor: statusDotColor, opacity: statusDot }]} />
        <Text style={ss.statusBarTxt} numberOfLines={1}>{statusLabel}</Text>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={ss.scrollPad}>
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
                  {stableState.internalStage === 'listening' ? 'Ouvindo' : 'Analisando'}
                </Text>
                <Text style={ss.listeningSub}>
                  {stableState.internalStage === 'listening' 
                    ? 'Cante ou toque — o app está captando'
                    : 'Verificando estabilidade do tom…'}
                </Text>
              </View>
            )}
          </Animated.View>
        </View>

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

        <View style={ss.keyCardSlot}>
          {/* Só mostra tom quando TRAVADO (nunca mostra hipóteses fracas) */}
          {showKey && displayKey ? (
            <View testID="key-card" style={[ss.keyCard, ss.keyCardConfirmed]}>
              <View style={ss.keyCardHeader}>
                <View style={[ss.keyCardBadge, { borderColor: 'rgba(34,197,94,0.35)' }]}>
                  <Ionicons
                    name={recentKeyChange ? 'swap-horizontal' : 'checkmark-circle'}
                    size={11}
                    color={C.green}
                  />
                  <Text style={[ss.keyCardBadgeTxt, { color: C.green }]}>
                    {recentKeyChange ? 'NOVA TONALIDADE CONFIRMADA' : confLabel.toUpperCase()}
                  </Text>
                </View>
                <Text style={[ss.keyCardConfPct, { color: confColor }]}>{confPct}%</Text>
              </View>
              <KeyDisplay root={displayKey.tonic} quality={displayKey.quality} provisional={false} />
              <ConfidenceBar pct={confPct} color={confColor} />
            </View>
          ) : isRunning ? (
            // Card de "ouvindo/analisando" - SEM mostrar hipóteses fracas
            <View testID="analyzing-card" style={[ss.keyCard, ss.keyCardProv]}>
              <View style={ss.keyCardHeader}>
                <View style={[ss.keyCardBadge, { borderColor: C.amberBorder }]}>
                  <Ionicons name={statusInfo.icon as any} size={11} color={C.amber} />
                  <Text style={[ss.keyCardBadgeTxt, { color: C.amber }]}>{statusInfo.label}</Text>
                </View>
              </View>
              <Text style={ss.analyzingTitle}>{statusInfo.sub}</Text>
              <Text style={ss.analyzingSub}>
                {stableState.internalStage === 'listening'
                  ? 'Cante ou toque por alguns segundos.'
                  : stableState.internalStage === 'candidate'
                  ? 'Identificando padrão tonal…'
                  : 'Confirmando detecção…'}
              </Text>
              {/* Indicador de progresso discreto */}
              {(stableState.internalStage === 'candidate' || stableState.internalStage === 'stableCandidate') && (
                <View style={ss.analysisProgress}>
                  <View style={ss.analysisProgressBar}>
                    <View style={[
                      ss.analysisProgressFill, 
                      { width: `${Math.min(100, analysisCount * 25)}%` }
                    ]} />
                  </View>
                </View>
              )}
            </View>
          ) : null}
        </View>

        {/* NÃO mostra "possível mudança" - análise é silenciosa */}

        {showKey && displayKey && harmonicField.length > 0 && (
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
const MIC_SIZE = 156;
const CHORD_GAP = 8;
const CHORD_W = (SW - 32 - CHORD_GAP * 2) / 3;

const ss = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },

  // ═══ INITIAL SCREEN — REFATORADA ═══
  initialRoot: {
    flex: 1, 
    paddingTop: 8, 
    paddingBottom: 20, 
    paddingHorizontal: 20,
  },
  
  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  headerBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.surface,
    borderWidth: 1, borderColor: C.border,
  },
  headerCenter: {
    alignItems: 'center',
  },
  logoSmall: {
    width: 36, height: 36,
  },
  
  // Brand
  brandBlock: { 
    alignItems: 'center', 
    marginBottom: 12,
  },
  brandTitle: { 
    fontFamily: 'Outfit_700Bold', 
    fontSize: 28, 
    color: C.white, 
    letterSpacing: -0.5,
  },
  brandSub: { 
    fontFamily: 'Manrope_500Medium', 
    fontSize: 13, 
    color: C.text2, 
    marginTop: 4,
    letterSpacing: 0.3,
  },

  // Mic Section - LIMPO E FOCADO
  micSection: {
    alignItems: 'center', justifyContent: 'center',
    flex: 1,
    maxHeight: 280,
    position: 'relative',
  },
  
  // Glow de fundo sutil
  micBackgroundGlow: {
    position: 'absolute',
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: 'rgba(255,176,32,0.06)',
  },
  
  // Anel pulsante único
  micPulseRing: {
    position: 'absolute',
    width: MIC_SIZE + 40,
    height: MIC_SIZE + 40,
    borderRadius: (MIC_SIZE + 40) / 2,
    borderWidth: 2,
    borderColor: C.amber,
  },
  
  // Botão do microfone - exterior
  micButtonOuter: {
    width: MIC_SIZE,
    height: MIC_SIZE,
    borderRadius: MIC_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0A0A0A',
    ...Platform.select({
      ios: {
        shadowColor: C.amber,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.5,
        shadowRadius: 30,
      },
      android: { elevation: 16 },
      default: {},
    }),
  },
  
  // Borda luminosa
  micGlowBorder: {
    position: 'absolute',
    width: MIC_SIZE,
    height: MIC_SIZE,
    borderRadius: MIC_SIZE / 2,
    borderWidth: 2.5,
    borderColor: C.amber,
  },
  
  // Círculo interno
  micButtonInner: {
    width: MIC_SIZE - 24,
    height: MIC_SIZE - 24,
    borderRadius: (MIC_SIZE - 24) / 2,
    backgroundColor: '#0E0E0E',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,176,32,0.15)',
  },

  // CTA Block - Melhorado
  ctaBlock: { 
    alignItems: 'center', 
    paddingTop: 16,
    paddingBottom: 20,
  },
  ctaMain: {
    fontFamily: 'Manrope_700Bold',
    fontSize: 17,
    color: C.amber,
    letterSpacing: 0.3,
    marginBottom: 8,
  },
  ctaSubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  ctaDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: C.green,
  },
  ctaSub: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 13,
    color: C.text2,
  },

  // Tools Section
  toolsSection: {
    marginTop: 'auto',
  },
  toolsLabel: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 10,
    color: C.text3,
    letterSpacing: 2,
    marginBottom: 12,
    textAlign: 'center',
  },
  toolsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  toolCard: {
    flex: 1,
    backgroundColor: C.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
    alignItems: 'center',
  },
  toolCardActive: {
    borderColor: C.amberBorder,
    backgroundColor: 'rgba(255,176,32,0.04)',
  },
  toolIconWrap: {
    width: 48, height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,176,32,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  toolName: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 15,
    color: C.white,
    marginBottom: 2,
  },
  toolDesc: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 11,
    color: C.text3,
  },

  // Error
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: C.redMuted, borderWidth: 1, borderColor: 'rgba(239,68,68,0.25)',
    borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, 
    marginTop: 12,
  },
  errorTxt: { flex: 1, fontFamily: 'Manrope_500Medium', fontSize: 12, color: C.red, lineHeight: 16 },

  // Settings Modal
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

  // ═══ ACTIVE SCREEN ═══
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
  headerCloseBtn: {
    width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
  },
  scrollPad: { paddingBottom: 24, gap: 14 },

  noteHero: {
    backgroundColor: C.surface, borderRadius: 20, borderWidth: 1, borderColor: C.border,
    overflow: 'hidden',
    minHeight: 240,
  },
  noteHeroTopRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingTop: 16, paddingBottom: 4,
  },
  noteHeroLabel: { fontFamily: 'Manrope_600SemiBold', fontSize: 10, color: C.text3, letterSpacing: 2.4 },
  noteHeroBox: {
    alignItems: 'center', justifyContent: 'center',
    flex: 1,
    paddingHorizontal: 20, paddingBottom: 18, paddingTop: 4,
    minHeight: 175,
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

  // Barra de progresso de análise (discreta)
  analysisProgress: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.05)',
  },
  analysisProgressBar: {
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  analysisProgressFill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: C.amber,
    opacity: 0.6,
  },

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
});
