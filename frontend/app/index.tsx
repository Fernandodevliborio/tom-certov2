import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated, Dimensions,
  Easing, Platform, Modal, ScrollView, Linking, Alert, ActivityIndicator, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Updates from 'expo-updates';
import { router } from 'expo-router';
import { useKeepAwake, activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import { useKeyDetection } from '../src/hooks/useKeyDetection';
import { NOTES_BR, NOTES_INTL, formatKeyDisplay, getHarmonicField } from '../src/utils/noteUtils';
import { useAuth, PlanFeatures } from '../src/auth/AuthContext';
import { APP_VERSION_LABEL } from '../src/constants/version';
import AudioVisualizer from '../src/components/AudioVisualizer';
import SmartChordsMode from '../src/components/SmartChordsMode';
import UpgradeModal from '../src/components/UpgradeModal';
import { WrongKeyFeedback } from '../src/components/WrongKeyFeedback';
import { getDeviceId } from '../src/auth/deviceId';
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
    noiseStage, noiseDisplay,
  } = det;

  // v3.17 — device ID para feedback de tom errado
  const [deviceId, setDeviceId] = useState<string>('');
  useEffect(() => {
    getDeviceId().then(setDeviceId).catch(() => setDeviceId('anon'));
  }, []);

  // ═══════════════════════════════════════════════════════════════════════════
  // FEATURES DO PLANO — Controle de acesso
  // ═══════════════════════════════════════════════════════════════════════════
  const { session } = useAuth();
  const features = session?.features || { 
    key_detection: true, 
    harmonic_field: true, 
    real_time_chord: false, // Bloqueado por padrão
    smart_chords: false 
  };
  const canShowRealTimeChord = features.real_time_chord;
  const canShowSmartChords = features.smart_chords;
  
  // Modal de upgrade
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);

  // ═══════════════════════════════════════════════════════════════════════════
  // KEEP AWAKE — Manter tela ligada durante detecção
  // ═══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (isRunning) {
      activateKeepAwakeAsync('detection-active').catch(() => {});
    } else {
      deactivateKeepAwake('detection-active');
    }
    
    return () => {
      deactivateKeepAwake('detection-active');
    };
  }, [isRunning]);

  // ═══════════════════════════════════════════════════════════════════════════
  // MODO ACORDES INTELIGENTES
  // ═══════════════════════════════════════════════════════════════════════════
  const [showSmartChords, setShowSmartChords] = useState(false);

  // ═══════════════════════════════════════════════════════════════════════════
  // ESTADO DE "NOVA DETECÇÃO"
  // ═══════════════════════════════════════════════════════════════════════════
  const [isResetting, setIsResetting] = useState(false);

  // ═══════════════════════════════════════════════════════════════════════════
  // NOVO ENGINE DE ESTABILIDADE v2.0
  // ═══════════════════════════════════════════════════════════════════════════
  const [stableState, setStableState] = useState<StableKeyState>(createStableKeyState());
  const [recentKeyChange, setRecentKeyChange] = useState(false);
  
  // ═══════════════════════════════════════════════════════════════════════════
  // FUNÇÃO: NOVA DETECÇÃO (Reset completo da sessão)
  // ═══════════════════════════════════════════════════════════════════════════
  const resetDetectionSession = useCallback(async () => {
    if (isResetting) return;
    
    setIsResetting(true);
    
    try {
      // 1. Limpar estado visual local
      setStableState(createStableKeyState());
      setRecentKeyChange(false);
      setShowSmartChords(false);
      
      // 2. Chamar reset do hook useKeyDetection (limpa buffers, notas, etc)
      reset();
      
      // 3. Chamar endpoint do backend para limpar sessão
      try {
        const backendUrl = process.env.EXPO_PUBLIC_BACKEND_URL || '';
        await fetch(`${backendUrl}/api/analyze-key/reset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        // Ignorar erros de rede — o reset local já foi feito
        console.log('[NovaDetecção] Backend reset opcional falhou:', err);
      }
      
      // 4. Feedback visual
      setTimeout(() => {
        setIsResetting(false);
      }, 1500);
      
    } catch (err) {
      console.error('[NovaDetecção] Erro:', err);
      setIsResetting(false);
    }
  }, [reset, isResetting]);
  
  // Processar novas análises ML — v13: backend controla stage via tempo decorrido
  useEffect(() => {
    if (!mlResult?.success) return;
    
    // v13: backend agora decide quando é seguro mostrar o tom.
    // Só avançamos a engine cliente quando o backend diz show_key === true
    // e o stage é 'probable' ou 'confirmed'. Isso previne lock prematuro.
    const stage = (mlResult as any).stage as string | undefined;
    const showKey = (mlResult as any).show_key as boolean | undefined;
    const backendLocked = (mlResult as any).locked as boolean | undefined;
    
    if (stage && !showKey) {
      // Backend diz para não mostrar nada ainda (listening/analyzing/needs_more)
      return;
    }
    
    if (mlResult.tonic === undefined || !mlResult.quality) return;
    
    const conf = mlResult.confidence ?? 0;
    const tonic = mlResult.tonic;
    const quality = mlResult.quality as 'major' | 'minor';
    const keyName = mlResult.key_name || '';
    
    // Se backend confirmou (stage='confirmed' + locked=true), aplicar lock imediato.
    // Se é apenas 'probable', passar pela engine que pode mostrar como preview.
    if (stage === 'confirmed' && backendLocked) {
      setStableState(prev => {
        // Ignorar se já está travado no mesmo tom
        if (prev.lockedKey && prev.lockedKey.tonic === tonic && prev.lockedKey.quality === quality) {
          return prev;
        }
        const hadLockedKey = prev.lockedKey !== null;
        if (hadLockedKey) {
          setRecentKeyChange(true);
          setTimeout(() => setRecentKeyChange(false), 3000);
        }
        return {
          ...prev,
          internalStage: 'locked',
          currentCandidate: null,
          hiddenCandidate: null,
          lockedKey: {
            tonic, quality, keyName,
            lockedAt: Date.now(),
            confidence: conf,
            totalAnalyses: (prev.totalAnalysesCount || 0) + 1,
            stabilityScore: 0,
          },
          visualConfidence: Math.round(conf * 100),
        };
      });
      return;
    }
    
    // Stage 'probable': passar pela engine mas ela não vai travar antes do backend
    setStableState(prev => {
      const hadLockedKey = prev.lockedKey !== null;
      const newState = processAnalysis(prev, { tonic, quality, confidence: conf, keyName });
      if (hadLockedKey && newState.lockedKey && 
          (prev.lockedKey!.tonic !== newState.lockedKey.tonic || 
           prev.lockedKey!.quality !== newState.lockedKey.quality)) {
        setRecentKeyChange(true);
        setTimeout(() => setRecentKeyChange(false), 3000);
      }
      return newState;
    });
  }, [mlResult?.confidence, mlResult?.tonic, mlResult?.quality, mlResult?.success, (mlResult as any)?.stage, (mlResult as any)?.show_key, (mlResult as any)?.locked]);

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
      setShowSmartChords(false);
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

  // v14 — Mensagens musicais rotativas (trocam a cada 3s durante análise)
  // Premium, humano, confiante — nunca técnico
  const SMART_MESSAGES = [
    { icon: 'ear', label: 'OUVINDO', sub: 'Ouvindo sua voz…' },
    { icon: 'musical-note', label: 'ANALISANDO', sub: 'Identificando o centro tonal…' },
    { icon: 'pulse', label: 'ANALISANDO', sub: 'Percebendo onde a música repousa…' },
    { icon: 'musical-notes', label: 'ANALISANDO', sub: 'Analisando as notas mais importantes…' },
    { icon: 'shield-checkmark', label: 'CONFIRMANDO', sub: 'Confirmando o tom com mais segurança…' },
    { icon: 'sparkles', label: 'QUASE LÁ', sub: 'Quase lá… buscando o tom mais provável' },
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
    // v13: se backend mandou stage_label, usar ele diretamente (fonte única da verdade)
    const backendStage = (mlResult as any)?.stage as string | undefined;
    const backendLabel = (mlResult as any)?.stage_label as string | undefined;
    const backendHint = (mlResult as any)?.stage_hint as string | undefined;
    if (isRunning && backendStage && backendLabel) {
      if (backendStage === 'confirmed') {
        const ds = (mlResult as any)?.detection_duration_s;
        const secs = typeof ds === 'number' ? Math.round(ds) : null;
        return {
          icon: recentKeyChange ? 'swap-horizontal' : 'checkmark-circle',
          label: recentKeyChange ? 'ATUALIZADO' : 'TOM DETECTADO',
          sub: secs != null
            ? `Identificado com segurança em ${secs} segundos.`
            : (backendHint || 'A IA confirmou o centro tonal da música.'),
        };
      }
      if (backendStage === 'uncertain' || backendStage === 'needs_more') {
        return {
          icon: 'musical-notes',
          label: 'MAIS UM POUCO',
          sub: backendLabel || 'Continue cantando — estou confirmando.',
        };
      }
      if (backendStage === 'listening') {
        // Durante "ouvindo": mensagem fixa humana
        return { icon: 'ear', label: 'OUVINDO', sub: backendLabel || 'Ouvindo sua voz…' };
      }
      // analyzing → rotacionar mensagens musicais a cada 3s (sem repetir 'OUVINDO')
      const rotIdx = 1 + (dynamicMsgIndex % (SMART_MESSAGES.length - 1));
      return SMART_MESSAGES[rotIdx];
    }
    
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
  }, [userVisibleState, stableState.internalStage, dynamicMsgIndex, recentKeyChange, mlResult, isRunning]);

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
      {/* ═══ HEADER: Logo, Nome, Status ═══ */}
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
              {APP_VERSION_LABEL}
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
        
        {/* ═══ 1. ACORDE EM TEMPO REAL (com bloqueio estratégico) ═══ */}
        <View style={ss.chordHero}>
          <View style={ss.chordHeroTopRow}>
            <Text style={ss.chordHeroLabel}>ACORDE EM TEMPO REAL</Text>
            <AudioVisualizer level={audioLevel} active={isRunning} height={20} bars={4} />
          </View>
          <Animated.View style={[ss.chordHeroBox, { opacity: noteOpacity }]}>
            {/* ═══ BLOQUEIO ESTRATÉGICO: Mostra cadeado se plano não tem acesso ═══ */}
            {!canShowRealTimeChord ? (
              <TouchableOpacity 
                style={ss.lockedChordBox} 
                onPress={() => setShowUpgradeModal(true)}
                activeOpacity={0.8}
              >
                <View style={ss.lockedIconWrap}>
                  <Ionicons name="lock-closed" size={32} color={C.amber} />
                </View>
                <Text style={ss.lockedChordLabel}>🎸 Acorde atual:</Text>
                <Text style={ss.lockedChordValue}>🔒</Text>
                <View style={ss.lockedCta}>
                  <Text style={ss.lockedCtaTxt}>Desbloqueie os acordes em tempo real</Text>
                  <Ionicons name="chevron-forward" size={14} color={C.amber} />
                </View>
              </TouchableOpacity>
            ) : showKey && displayKey && currentNote !== null ? (
              (() => {
                // Encontrar o acorde do campo harmônico que corresponde à nota
                const chordMatch = harmonicField.find(c => c.root === currentNote);
                const degrees = displayKey.quality === 'major' 
                  ? ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°']
                  : ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'];
                const chordIndex = harmonicField.findIndex(c => c.root === currentNote);
                const degree = chordIndex >= 0 ? degrees[chordIndex] : null;
                
                if (chordMatch) {
                  return (
                    <>
                      <Text style={ss.chordHeroTxt} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
                        {chordMatch.label}
                      </Text>
                      {degree && (
                        <View style={ss.chordHeroDegreeBox}>
                          <Text style={ss.chordHeroDegreeTxt}>Grau {degree}</Text>
                        </View>
                      )}
                    </>
                  );
                }
                // Nota fora do campo harmônico
                return (
                  <>
                    <Text style={[ss.chordHeroTxt, ss.chordHeroTxtMuted]} numberOfLines={1}>
                      {NOTES_BR[currentNote]}
                    </Text>
                    <Text style={ss.chordHeroOutside}>Fora do campo</Text>
                  </>
                );
              })()
            ) : (
              <View style={ss.listeningHero}>
                <Text style={ss.listeningTitle}>
                  {stableState.internalStage === 'listening' ? 'Ouvindo…' : 
                   showKey ? 'Aguardando nota…' : 'Analisando…'}
                </Text>
                <Text style={ss.listeningSub}>
                  {showKey 
                    ? 'Toque ou cante para ver o acorde'
                    : 'Identificando a tonalidade…'}
                </Text>
              </View>
            )}
          </Animated.View>
        </View>

        {/* ═══ 2. TOM DETECTADO / CONFIANÇA ═══ */}
        <View style={ss.keyCardSlot}>
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
                    {recentKeyChange ? 'NOVA TONALIDADE' : confLabel.toUpperCase()}
                  </Text>
                </View>
                <Text style={[ss.keyCardConfPct, { color: confColor }]}>{confPct}%</Text>
              </View>
              <KeyDisplay root={displayKey.tonic} quality={displayKey.quality} provisional={false} />
              <ConfidenceBar pct={confPct} color={confColor} />
              {(() => {
                // v14: exibir "Tom confirmado em X segundos" — tempo de detecção
                const ds = (mlResult as any)?.detection_duration_s;
                const secs = typeof ds === 'number' ? Math.round(ds) : null;
                if (secs == null) return null;
                return (
                  <Text
                    testID="detection-duration"
                    style={{
                      fontFamily: 'Manrope_500Medium',
                      fontSize: 12,
                      color: C.text3,
                      textAlign: 'center',
                      marginTop: 6,
                      letterSpacing: 0.3,
                    }}
                  >
                    Tom confirmado em {secs} segundos
                  </Text>
                );
              })()}
              <WrongKeyFeedback
                apiBaseUrl={process.env.EXPO_PUBLIC_BACKEND_URL || ''}
                deviceId={deviceId}
                detectedKeyName={`${NOTES_BR[displayKey.tonic]} ${displayKey.quality === 'major' ? 'Maior' : 'menor'}`}
                confidencePct={confPct}
              />
            </View>
          ) : isRunning ? (
            <View testID="analyzing-card" style={[ss.keyCard, ss.keyCardProv]}>
              <View style={ss.keyCardHeader}>
                <View style={[ss.keyCardBadge, { borderColor: C.amberBorder }]}>
                  <Ionicons name={statusInfo.icon as any} size={11} color={C.amber} />
                  <Text style={[ss.keyCardBadgeTxt, { color: C.amber }]}>{statusInfo.label}</Text>
                </View>
                {(() => {
                  // v14: preferir window_progress do backend (0..1 na janela de 30s)
                  const wp = (mlResult as any)?.window_progress;
                  const elapsed = (mlResult as any)?.elapsed_s;
                  const windowS = (mlResult as any)?.window_s || 30;
                  if (typeof wp === 'number') {
                    const secs = Math.min(windowS, Math.round(elapsed || 0));
                    return (
                      <Text
                        testID="warmup-progress-counter"
                        style={[ss.keyCardConfPct, { color: C.amber }]}
                      >
                        {secs}/{windowS}s
                      </Text>
                    );
                  }
                  const legacy = (mlResult as any)?.warmup_progress;
                  if (legacy && legacy.is_warming_up) {
                    return (
                      <Text
                        testID="warmup-progress-counter"
                        style={[ss.keyCardConfPct, { color: C.amber }]}
                      >
                        {legacy.current}/{legacy.target}
                      </Text>
                    );
                  }
                  return null;
                })()}
              </View>
              <Text style={ss.analyzingTitle}>{statusInfo.sub}</Text>
              <Text style={ss.analyzingSub}>
                {stableState.internalStage === 'listening'
                  ? 'Cante ou toque por alguns segundos.'
                  : 'Confirmando detecção…'}
              </Text>
              {/* ── Indicador de qualidade de áudio (vocal_focus) ── */}
              {/* Só aparece quando há ruído detectado (debounciado >1.5s).        */}
              {/* É puramente informativo — a decisão real continua no backend.    */}
              {isRunning && noiseStage !== 'clean' && (
                <View
                  testID={`noise-indicator-${noiseStage}`}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    alignSelf: 'center',
                    marginTop: 10,
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 999,
                    backgroundColor: 'rgba(245, 158, 11, 0.12)',
                    borderWidth: 1,
                    borderColor: 'rgba(245, 158, 11, 0.35)',
                    gap: 6,
                  }}
                >
                  <Ionicons
                    name={
                      noiseStage === 'percussion' ? 'pulse' :
                      noiseStage === 'silence' ? 'mic-off' :
                      'volume-high'
                    }
                    size={12}
                    color={C.amber}
                  />
                  <Text
                    testID="noise-indicator-label"
                    style={{
                      fontFamily: 'Manrope_600SemiBold',
                      fontSize: 11,
                      letterSpacing: 0.3,
                      color: C.amber,
                    }}
                  >
                    {noiseDisplay.label}
                  </Text>
                </View>
              )}
              {(() => {
                // v14: barra de progresso baseada em window_progress do backend
                const wp = (mlResult as any)?.window_progress;
                const elapsed = (mlResult as any)?.elapsed_s;
                const windowS = (mlResult as any)?.window_s || 30;
                if (typeof wp === 'number') {
                  const pct = Math.min(100, wp * 100);
                  const secs = Math.min(windowS, Math.round(elapsed || 0));
                  return (
                    <View testID="warmup-progress-bar" style={ss.analysisProgress}>
                      <View style={ss.analysisProgressBar}>
                        <View
                          style={[
                            ss.analysisProgressFill,
                            { width: `${pct}%` as any },
                          ]}
                        />
                      </View>
                      <Text
                        style={{
                          fontFamily: 'Manrope_500Medium',
                          fontSize: 11,
                          color: C.text3,
                          letterSpacing: 0.4,
                          marginTop: 6,
                          textAlign: 'center',
                        }}
                      >
                        Janela de análise · {secs}s / {windowS}s
                      </Text>
                    </View>
                  );
                }
                const legacy = (mlResult as any)?.warmup_progress;
                if (legacy && legacy.is_warming_up) {
                  const pct = Math.min(100, (legacy.current / Math.max(1, legacy.target)) * 100);
                  return (
                    <View testID="warmup-progress-bar" style={ss.analysisProgress}>
                      <View style={ss.analysisProgressBar}>
                        <View
                          style={[
                            ss.analysisProgressFill,
                            { width: `${pct}%` as any },
                          ]}
                        />
                      </View>
                      <Text
                        style={{
                          fontFamily: 'Manrope_500Medium',
                          fontSize: 11,
                          color: C.text3,
                          letterSpacing: 0.4,
                          marginTop: 6,
                          textAlign: 'center',
                        }}
                      >
                        Coletando contexto musical · {legacy.current}/{legacy.target}
                      </Text>
                    </View>
                  );
                }
                return null;
              })()}
            </View>
          ) : null}
        </View>

        {/* ═══ 3. BOTÃO NOVA DETECÇÃO ═══ */}
        <TouchableOpacity
          testID="new-detection-btn"
          style={ss.newDetectionBtn}
          onPress={resetDetectionSession}
          activeOpacity={0.7}
          disabled={isResetting}
        >
          {isResetting ? (
            <>
              <ActivityIndicator size="small" color={C.amber} style={{ marginRight: 8 }} />
              <Text style={ss.newDetectionTxt}>Reiniciando…</Text>
            </>
          ) : (
            <>
              <Ionicons name="refresh" size={16} color={C.amber} style={{ marginRight: 6 }} />
              <Text style={[ss.newDetectionTxt, { color: C.amber }]}>Nova Detecção</Text>
            </>
          )}
        </TouchableOpacity>

        {/* ═══ 4. CAMPO HARMÔNICO COMPLETO (GRID 2 LINHAS, SEM SCROLL) ═══ */}
        {showKey && displayKey && harmonicField.length > 0 && (
          <View style={ss.harmonicGrid}>
            <View style={ss.harmonicGridHeader}>
              <Text style={ss.harmonicGridTitle}>CAMPO HARMÔNICO</Text>
              <TouchableOpacity 
                style={ss.diagramsBtn}
                onPress={() => setShowSmartChords(!showSmartChords)}
                activeOpacity={0.7}
              >
                <Ionicons 
                  name={showSmartChords ? 'chevron-up' : 'apps-outline'} 
                  size={13} 
                  color={C.amber} 
                />
                <Text style={ss.diagramsBtnTxt}>
                  {showSmartChords ? 'Ocultar' : 'Diagramas'}
                </Text>
              </TouchableOpacity>
            </View>
            
            {/* Linha 1: I, ii, iii, IV */}
            <View style={ss.harmonicRow}>
              {harmonicField.slice(0, 4).map((chord, i) => {
                const isActive = currentNote !== null && chord.root === currentNote;
                return (
                  <View 
                    key={i} 
                    style={[
                      ss.harmonicCell, 
                      chord.isTonic && ss.harmonicCellTonic,
                      isActive && ss.harmonicCellActive,
                    ]}
                  >
                    <Text style={[ss.harmonicDegree, isActive && ss.harmonicDegreeActive]}>
                      {degreeLabel(i, displayKey.quality)}
                    </Text>
                    <Text style={[
                      ss.harmonicName, 
                      chord.isTonic && ss.harmonicNameTonic,
                      isActive && ss.harmonicNameActive,
                    ]}>
                      {chord.label}
                    </Text>
                  </View>
                );
              })}
            </View>
            
            {/* Linha 2: V, vi, vii° */}
            <View style={ss.harmonicRow}>
              {harmonicField.slice(4, 7).map((chord, i) => {
                const realIndex = i + 4;
                const isActive = currentNote !== null && chord.root === currentNote;
                return (
                  <View 
                    key={realIndex} 
                    style={[
                      ss.harmonicCell, 
                      ss.harmonicCellSmaller,
                      isActive && ss.harmonicCellActive,
                    ]}
                  >
                    <Text style={[ss.harmonicDegree, isActive && ss.harmonicDegreeActive]}>
                      {degreeLabel(realIndex, displayKey.quality)}
                    </Text>
                    <Text style={[ss.harmonicName, isActive && ss.harmonicNameActive]}>
                      {chord.label}
                    </Text>
                  </View>
                );
              })}
            </View>
          </View>
        )}

        {/* ═══ 5. ACORDES INTELIGENTES (COMPACTO) — com bloqueio se necessário ═══ */}
        {showKey && displayKey && showSmartChords && (
          canShowSmartChords ? (
            <SmartChordsMode
              tonic={displayKey.tonic}
              quality={displayKey.quality}
              currentNote={currentNote}
              expanded={showSmartChords}
              compact={true}
            />
          ) : (
            <TouchableOpacity 
              style={ss.lockedSmartChordsBox}
              onPress={() => setShowUpgradeModal(true)}
              activeOpacity={0.8}
            >
              <Ionicons name="lock-closed" size={20} color={C.amber} />
              <Text style={ss.lockedSmartChordsTxt}>Diagramas de acordes</Text>
              <View style={ss.lockedSmartChordsCta}>
                <Text style={ss.lockedSmartChordsCtaTxt}>🔒 PRO</Text>
              </View>
            </TouchableOpacity>
          )
        )}

      </ScrollView>
      
      {/* ═══ MODAL DE UPGRADE ═══ */}
      <UpgradeModal 
        visible={showUpgradeModal} 
        onClose={() => setShowUpgradeModal(false)} 
      />
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

  // ═══ ACORDES INTELIGENTES — Toggle ═══
  smartChordsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: C.surface,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginHorizontal: 0,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: C.border,
  },
  smartChordsToggleLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  smartChordsToggleText: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 12,
    color: C.text2,
    letterSpacing: 0.8,
  },
  smartChordsToggleTextActive: {
    color: C.amber,
  },
  smartChordsToggleRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  smartChordsToggleHint: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 11,
    color: C.text3,
  },

  // ═══ BOTÃO NOVA DETECÇÃO ═══
  newDetectionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,176,32,0.08)',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginTop: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,176,32,0.25)',
  },
  newDetectionTxt: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 13,
    color: C.text2,
    letterSpacing: 0.3,
  },

  // ═══ FAIXA COMPACTA: Campo Harmônico ═══
  harmonicStrip: {
    backgroundColor: C.surface,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: C.border,
  },
  harmonicStripHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  harmonicStripTitle: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 11,
    color: C.text3,
    letterSpacing: 1,
  },
  diagramsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    backgroundColor: 'rgba(255,176,32,0.1)',
  },
  diagramsBtnTxt: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 11,
    color: C.amber,
  },
  harmonicChipsRow: {
    flexDirection: 'row',
    gap: 8,
  },
  harmonicChip: {
    backgroundColor: C.bg,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: C.border,
    minWidth: 48,
  },
  harmonicChipTonic: {
    backgroundColor: C.amberMuted,
    borderColor: C.amberBorder,
  },
  harmonicChipActive: {
    backgroundColor: 'rgba(16,185,129,0.15)',
    borderColor: 'rgba(16,185,129,0.4)',
  },
  harmonicChipDegree: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 9,
    color: C.text3,
    letterSpacing: 0.5,
  },
  harmonicChipName: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 14,
    color: C.white,
    marginTop: 2,
  },
  harmonicChipNameTonic: {
    color: C.amber,
  },
  harmonicChipNameActive: {
    color: C.green,
  },

  // ═══ NOTAS INTELIGENTES EM TEMPO REAL ═══
  liveNotesSection: {
    backgroundColor: C.surface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: C.border,
  },
  liveNotesHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  liveNotesTitle: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 11,
    color: C.text3,
    letterSpacing: 1,
  },
  liveNoteDisplay: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 80,
  },
  liveNoteActive: {
    alignItems: 'center',
  },
  liveNoteMain: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 48,
    color: C.white,
    letterSpacing: -1,
  },
  liveNoteIntl: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 14,
    color: C.text2,
    marginTop: 2,
  },
  liveNoteEmpty: {
    alignItems: 'center',
    gap: 6,
  },
  liveNoteEmptyTxt: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 13,
    color: C.text3,
  },
  recentNotesRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.05)',
  },
  recentNoteChip: {
    backgroundColor: C.bg,
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: C.border,
  },
  recentNoteChipLatest: {
    backgroundColor: 'rgba(255,176,32,0.12)',
    borderColor: 'rgba(255,176,32,0.3)',
  },
  recentNoteTxt: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 12,
    color: C.text3,
  },
  recentNoteTxtLatest: {
    color: C.amber,
  },

  // ═══ ACORDE EM TEMPO REAL (novo) ═══
  chordHero: {
    backgroundColor: C.surface, borderRadius: 16, borderWidth: 1, borderColor: C.border,
    overflow: 'hidden',
    minHeight: 140,
  },
  chordHeroTopRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingTop: 12, paddingBottom: 4,
  },
  chordHeroLabel: { fontFamily: 'Manrope_600SemiBold', fontSize: 9, color: C.text3, letterSpacing: 2 },
  chordHeroBox: {
    alignItems: 'center', justifyContent: 'center',
    flex: 1,
    paddingHorizontal: 16, paddingBottom: 14, paddingTop: 0,
    minHeight: 100,
  },
  chordHeroTxt: {
    fontFamily: 'Outfit_800ExtraBold', fontSize: 52, color: C.white,
    letterSpacing: -2, lineHeight: 58, textAlign: 'center',
    includeFontPadding: false,
  },
  chordHeroTxtMuted: {
    color: C.text2,
    fontSize: 44,
  },
  chordHeroDegreeBox: {
    backgroundColor: 'rgba(255,176,32,0.12)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginTop: 6,
  },
  chordHeroDegreeTxt: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 12,
    color: C.amber,
    letterSpacing: 0.5,
  },
  chordHeroOutside: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 11,
    color: C.text3,
    marginTop: 4,
  },

  // ═══ CAMPO HARMÔNICO GRID (2 linhas, sem scroll) ═══
  harmonicGrid: {
    backgroundColor: C.surface,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: C.border,
  },
  harmonicGridHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  harmonicGridTitle: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 10,
    color: C.text3,
    letterSpacing: 1,
  },
  harmonicRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 6,
    marginBottom: 6,
  },
  harmonicCell: {
    flex: 1,
    backgroundColor: C.bg,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 4,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: C.border,
  },
  harmonicCellSmaller: {
    flex: 1,
    maxWidth: '32%',
  },
  harmonicCellTonic: {
    backgroundColor: 'rgba(255,176,32,0.08)',
    borderColor: 'rgba(255,176,32,0.3)',
  },
  harmonicCellActive: {
    backgroundColor: 'rgba(16,185,129,0.15)',
    borderColor: 'rgba(16,185,129,0.5)',
  },
  harmonicDegree: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 9,
    color: C.text3,
    letterSpacing: 0.3,
    marginBottom: 2,
  },
  harmonicDegreeActive: {
    color: C.green,
  },
  harmonicName: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 15,
    color: C.white,
  },
  harmonicNameTonic: {
    color: C.amber,
  },
  harmonicNameActive: {
    color: C.green,
  },
  
  // ═══ ESTILOS PARA BLOQUEIO ESTRATÉGICO ═══
  lockedChordBox: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  lockedIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(255,176,32,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  lockedChordLabel: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 14,
    color: C.text2,
    marginBottom: 4,
  },
  lockedChordValue: {
    fontFamily: 'Outfit_800ExtraBold',
    fontSize: 48,
    color: C.amber,
    letterSpacing: -1,
    marginBottom: 8,
  },
  lockedCta: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,176,32,0.12)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,176,32,0.3)',
    gap: 6,
  },
  lockedCtaTxt: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 12,
    color: C.amber,
  },
  lockedSmartChordsBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    paddingVertical: 16,
    paddingHorizontal: 20,
    gap: 10,
  },
  lockedSmartChordsTxt: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 14,
    color: C.text2,
    flex: 1,
  },
  lockedSmartChordsCta: {
    backgroundColor: 'rgba(255,176,32,0.15)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  lockedSmartChordsCtaTxt: {
    fontFamily: 'Manrope_700Bold',
    fontSize: 11,
    color: C.amber,
  },
});
