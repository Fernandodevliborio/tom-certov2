import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated,
  Dimensions, Platform, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTuner } from '../src/hooks/useTuner';

const { width: SW } = Dimensions.get('window');

const C = {
  bg: '#0A0A0A',
  surface: '#111111',
  border: '#1C1C1C',
  amber: '#FFB020',
  amberGlow: 'rgba(255,176,32,0.38)',
  amberMuted: 'rgba(255,176,32,0.10)',
  white: '#FFFFFF',
  text2: '#A0A0A0',
  text3: '#555555',
  red: '#EF4444',
  green: '#22C55E',
  blue: '#60A5FA',
  orange: '#F97316',
};

// Instrumentos e suas afinações padrão
const INSTRUMENTS = {
  violao: {
    name: 'Violão',
    icon: 'musical-notes',
    strings: [
      { note: 'E2', freq: 82.41, name: 'Mi grave' },
      { note: 'A2', freq: 110.00, name: 'Lá' },
      { note: 'D3', freq: 146.83, name: 'Ré' },
      { note: 'G3', freq: 196.00, name: 'Sol' },
      { note: 'B3', freq: 246.94, name: 'Si' },
      { note: 'E4', freq: 329.63, name: 'Mi agudo' },
    ],
  },
  guitarra: {
    name: 'Guitarra',
    icon: 'flash',
    strings: [
      { note: 'E2', freq: 82.41, name: 'Mi grave' },
      { note: 'A2', freq: 110.00, name: 'Lá' },
      { note: 'D3', freq: 146.83, name: 'Ré' },
      { note: 'G3', freq: 196.00, name: 'Sol' },
      { note: 'B3', freq: 246.94, name: 'Si' },
      { note: 'E4', freq: 329.63, name: 'Mi agudo' },
    ],
  },
  baixo: {
    name: 'Baixo',
    icon: 'radio',
    strings: [
      { note: 'E1', freq: 41.20, name: 'Mi' },
      { note: 'A1', freq: 55.00, name: 'Lá' },
      { note: 'D2', freq: 73.42, name: 'Ré' },
      { note: 'G2', freq: 98.00, name: 'Sol' },
    ],
  },
  ukulele: {
    name: 'Ukulele',
    icon: 'sunny',
    strings: [
      { note: 'G4', freq: 392.00, name: 'Sol' },
      { note: 'C4', freq: 261.63, name: 'Dó' },
      { note: 'E4', freq: 329.63, name: 'Mi' },
      { note: 'A4', freq: 440.00, name: 'Lá' },
    ],
  },
};

type InstrumentKey = 'violao' | 'guitarra' | 'baixo' | 'ukulele';

// Error Boundary Component
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
    console.error('[TunerErrorBoundary] Caught error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <SafeAreaView style={ss.safe}>
          <View style={ss.errorContainer}>
            <Ionicons name="warning" size={64} color={C.amber} />
            <Text style={ss.errorTitle}>Algo deu errado</Text>
            <Text style={ss.errorMessage}>
              {this.state.errorMsg || 'O afinador encontrou um problema.'}
            </Text>
            <TouchableOpacity
              style={ss.errorButton}
              onPress={() => router.back()}
              activeOpacity={0.8}
            >
              <Text style={ss.errorButtonText}>Voltar</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      );
    }

    return this.props.children;
  }
}

// Main Tuner Screen wrapped in Error Boundary
export default function TunerScreenWrapper() {
  return (
    <TunerErrorBoundary>
      <TunerScreen />
    </TunerErrorBoundary>
  );
}

function TunerScreen() {
  const [instrument, setInstrument] = useState<InstrumentKey>('violao');
  const [hasError, setHasError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [initAttempts, setInitAttempts] = useState(0);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Safely call useTuner
  const tuner = useTuner();
  
  const arcAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  
  const currentInstrument = INSTRUMENTS[instrument];
  
  // Pulse animation for the beta badge
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.05,
          duration: 1500,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1500,
          useNativeDriver: true,
        }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, []);
  
  // Encontra a corda mais próxima da frequência detectada
  const getClosestString = useCallback(() => {
    if (!tuner.frequency || tuner.frequency < 30) return null;
    
    let closest = currentInstrument.strings[0];
    let minDiff = Math.abs(tuner.frequency - closest.freq);
    
    for (const str of currentInstrument.strings) {
      const diff = Math.abs(tuner.frequency - str.freq);
      if (diff < minDiff) {
        minDiff = diff;
        closest = str;
      }
    }
    
    return closest;
  }, [tuner.frequency, currentInstrument]);
  
  const closestString = getClosestString();
  
  // Calcula diferença em cents (1 semitom = 100 cents)
  const getCents = useCallback(() => {
    if (!closestString || !tuner.frequency) return 0;
    const ratio = tuner.frequency / closestString.freq;
    if (ratio <= 0) return 0;
    const cents = 1200 * Math.log2(ratio);
    return Math.round(cents);
  }, [tuner.frequency, closestString]);
  
  const cents = getCents();
  
  // Status da afinação
  const getTuningStatus = () => {
    if (hasError || tuner.error) {
      return { 
        status: 'error', 
        message: tuner.error || 'Erro ao iniciar. Toque para tentar novamente.', 
        color: C.red 
      };
    }
    if (isLoading) {
      return { status: 'loading', message: 'Iniciando microfone...', color: C.text2 };
    }
    if (!tuner.isActive) {
      return { status: 'idle', message: 'Toque para iniciar', color: C.text2 };
    }
    
    // Check if native pitch detection is not supported
    if (Platform.OS !== 'web' && !tuner.isNativeSupported) {
      return { 
        status: 'native_limited', 
        message: 'Modo de visualização de áudio ativo', 
        color: C.amber 
      };
    }
    
    if (!tuner.frequency || tuner.frequency < 30) {
      return { status: 'waiting', message: 'Aproxime o instrumento do microfone', color: C.text2 };
    }
    if (tuner.noiseLevel > 0.7) {
      return { status: 'noise', message: 'Ambiente com muito ruído', color: C.orange };
    }
    
    const absCents = Math.abs(cents);
    
    if (absCents <= 5) {
      return { status: 'perfect', message: 'Perfeito!', color: C.green };
    } else if (absCents <= 15) {
      return { status: 'almost', message: 'Quase lá!', color: C.amber };
    } else if (cents < -15) {
      return { status: 'low', message: 'Aperte um pouco a corda', color: C.blue };
    } else {
      return { status: 'high', message: 'Afrouxe um pouco a corda', color: C.red };
    }
  };
  
  const tuningStatus = getTuningStatus();
  
  // Animação do arco
  useEffect(() => {
    const normalizedCents = Math.max(-50, Math.min(50, cents)) / 50; // -1 a 1
    Animated.spring(arcAnim, {
      toValue: normalizedCents,
      friction: 8,
      tension: 40,
      useNativeDriver: true,
    }).start();
  }, [cents]);
  
  // Inicia o tuner ao montar COM TRATAMENTO DE ERROS ROBUSTO
  useEffect(() => {
    let mounted = true;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    
    const initTuner = async () => {
      if (!mounted) return;
      
      try {
        console.log('[TunerScreen] Initializing tuner, attempt:', initAttempts + 1);
        setIsLoading(true);
        setHasError(false);
        
        // Small delay to ensure component is fully mounted
        await new Promise(resolve => setTimeout(resolve, 150));
        
        if (!mounted) return;
        
        await tuner.start();
        
        if (mounted) {
          setIsLoading(false);
          console.log('[TunerScreen] Tuner started successfully');
        }
      } catch (err: any) {
        console.error('[TunerScreen] Error starting tuner:', err);
        if (mounted) {
          setHasError(true);
          setIsLoading(false);
          
          // Auto-retry once after 1 second if first attempt fails
          if (initAttempts < 1) {
            retryTimeout = setTimeout(() => {
              if (mounted) {
                setInitAttempts(a => a + 1);
              }
            }, 1000);
          }
        }
      }
    };
    
    initTuner();
    
    return () => {
      mounted = false;
      if (retryTimeout) clearTimeout(retryTimeout);
      tuner.stop().catch(() => {});
    };
  }, [initAttempts]);
  
  // Handler para tentar novamente
  const handleRetry = async () => {
    try {
      console.log('[TunerScreen] Manual retry initiated');
      setIsLoading(true);
      setHasError(false);
      await tuner.stop();
      await new Promise(resolve => setTimeout(resolve, 200));
      await tuner.start();
      setIsLoading(false);
    } catch (err) {
      console.error('[TunerScreen] Retry error:', err);
      setHasError(true);
      setIsLoading(false);
    }
  };
  
  // Handle back navigation safely
  const handleBack = useCallback(() => {
    try {
      tuner.stop().catch(() => {});
      router.back();
    } catch (err) {
      console.error('[TunerScreen] Navigation error:', err);
      // Fallback: try replace instead
      try {
        router.replace('/');
      } catch {
        // Last resort - do nothing, let user handle
      }
    }
  }, [tuner]);
  
  const arcRotation = arcAnim.interpolate({
    inputRange: [-1, 1],
    outputRange: ['-45deg', '45deg'],
  });
  
  // Determine if we should show the "limited mode" banner
  const showLimitedBanner = Platform.OS !== 'web' && tuner.isActive && !tuner.isNativeSupported;
  
  return (
    <SafeAreaView style={ss.safe}>
      {/* Header with BETA Badge */}
      <View style={ss.header}>
        <TouchableOpacity onPress={handleBack} style={ss.backBtn} activeOpacity={0.7}>
          <Ionicons name="arrow-back" size={22} color={C.white} />
        </TouchableOpacity>
        
        <View style={ss.headerCenter}>
          <Text style={ss.headerTitle}>Afinador</Text>
          <Animated.View style={[ss.betaBadge, { transform: [{ scale: pulseAnim }] }]}>
            <Text style={ss.betaText}>BETA</Text>
          </Animated.View>
        </View>
        
        <View style={{ width: 44 }} />
      </View>
      
      {/* Beta Notice */}
      <View style={ss.betaNotice}>
        <Ionicons name="flask-outline" size={14} color={C.amber} />
        <Text style={ss.betaNoticeText}>Em testes — melhorias em andamento</Text>
      </View>
      
      {/* Limited Mode Banner for Native */}
      {showLimitedBanner && (
        <View style={ss.limitedBanner}>
          <Ionicons name="information-circle" size={16} color={C.orange} />
          <Text style={ss.limitedBannerText}>
            Detecção de pitch completa disponível na versão web. 
            No app, mostramos o nível de áudio.
          </Text>
        </View>
      )}
      
      {/* Seletor de Instrumento */}
      <View style={ss.instrumentSelector}>
        {(['violao', 'guitarra', 'baixo', 'ukulele'] as InstrumentKey[]).map((key) => (
          <TouchableOpacity
            key={key}
            onPress={() => setInstrument(key)}
            style={[
              ss.instrumentBtn,
              instrument === key && ss.instrumentBtnActive,
            ]}
            activeOpacity={0.7}
          >
            <Ionicons
              name={INSTRUMENTS[key].icon as any}
              size={18}
              color={instrument === key ? C.amber : C.text2}
            />
            <Text style={[
              ss.instrumentBtnText,
              instrument === key && ss.instrumentBtnTextActive,
            ]}>
              {INSTRUMENTS[key].name}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      
      {/* Área Principal do Afinador */}
      <View style={ss.tunerMain}>
        {/* Loading State */}
        {isLoading && (
          <View style={ss.loadingOverlay}>
            <ActivityIndicator size="large" color={C.amber} />
            <Text style={ss.loadingText}>Iniciando microfone...</Text>
          </View>
        )}
        
        {/* Error State with Retry */}
        {!isLoading && (hasError || tuner.error) && (
          <View style={ss.errorOverlay}>
            <Ionicons name="mic-off" size={48} color={C.red} />
            <Text style={ss.errorText}>{tuner.error || 'Erro ao iniciar afinador'}</Text>
            <TouchableOpacity style={ss.retryButton} onPress={handleRetry} activeOpacity={0.8}>
              <Ionicons name="refresh" size={18} color={C.bg} />
              <Text style={ss.retryButtonText}>Tentar novamente</Text>
            </TouchableOpacity>
            {tuner.permissionStatus === 'blocked' && (
              <Text style={ss.permissionHint}>
                Vá em Configurações {'>'} Tom Certo {'>'} Permissões {'>'} Microfone
              </Text>
            )}
          </View>
        )}
        
        {/* Active Tuner UI */}
        {!isLoading && !hasError && !tuner.error && (
          <>
            {/* Arco/Medidor */}
            <View style={ss.arcContainer}>
              {/* Background do arco */}
              <View style={ss.arcBg}>
                <View style={[ss.arcSegment, ss.arcLeft]} />
                <View style={[ss.arcSegment, ss.arcCenterSeg]} />
                <View style={[ss.arcSegment, ss.arcRight]} />
              </View>
              
              {/* Ponteiro */}
              <Animated.View style={[ss.needle, { transform: [{ rotate: arcRotation }] }]}>
                <View style={[ss.needleInner, { backgroundColor: tuningStatus.color }]} />
              </Animated.View>
              
              {/* Centro */}
              <View style={ss.arcCenterDot}>
                <View style={[ss.centerDot, { backgroundColor: tuningStatus.color }]} />
              </View>
            </View>
            
            {/* Nota Grande Central */}
            <View style={ss.noteDisplay}>
              <Text style={[ss.noteText, { color: closestString ? C.white : C.text3 }]}>
                {closestString?.note.slice(0, -1) || '—'}
              </Text>
              {closestString && (
                <Text style={ss.noteOctave}>{closestString.note.slice(-1)}</Text>
              )}
            </View>
            
            {/* Frequência (discreta) */}
            {tuner.frequency && tuner.frequency > 30 && (
              <Text style={ss.freqText}>{tuner.frequency.toFixed(1)} Hz</Text>
            )}
            
            {/* Audio Level Indicator (for native) */}
            {Platform.OS !== 'web' && tuner.isActive && (
              <View style={ss.audioLevelContainer}>
                <Text style={ss.audioLevelLabel}>NÍVEL DE ÁUDIO</Text>
                <View style={ss.audioLevelBar}>
                  <View 
                    style={[
                      ss.audioLevelFill, 
                      { 
                        width: `${Math.min(100, tuner.noiseLevel * 100)}%`,
                        backgroundColor: tuner.noiseLevel > 0.7 ? C.red : tuner.noiseLevel > 0.3 ? C.amber : C.green,
                      }
                    ]} 
                  />
                </View>
              </View>
            )}
            
            {/* Mensagem Inteligente */}
            <View style={[ss.messageBox, { borderColor: tuningStatus.color }]}>
              <Ionicons
                name={
                  tuningStatus.status === 'perfect' ? 'checkmark-circle' :
                  tuningStatus.status === 'almost' ? 'ellipse' :
                  tuningStatus.status === 'low' ? 'arrow-up' :
                  tuningStatus.status === 'high' ? 'arrow-down' :
                  tuningStatus.status === 'loading' ? 'hourglass' :
                  tuningStatus.status === 'native_limited' ? 'pulse' :
                  'mic'
                }
                size={24}
                color={tuningStatus.color}
              />
              <Text style={[ss.messageText, { color: tuningStatus.color }]}>
                {tuningStatus.message}
              </Text>
            </View>
            
            {/* Corda detectada */}
            {closestString && tuner.frequency && tuner.frequency > 30 && (
              <Text style={ss.stringName}>
                Corda {closestString.name} ({closestString.note})
              </Text>
            )}
          </>
        )}
      </View>
      
      {/* Lista de Cordas */}
      <View style={ss.stringsContainer}>
        <Text style={ss.stringsLabel}>CORDAS DO {currentInstrument.name.toUpperCase()}</Text>
        <View style={ss.stringsRow}>
          {currentInstrument.strings.map((str, idx) => {
            const isActive = closestString?.note === str.note && !!tuner.frequency && tuner.frequency > 30;
            const isPerfect = isActive && Math.abs(cents) <= 5;
            
            return (
              <View
                key={idx}
                style={[
                  ss.stringChip,
                  isActive ? ss.stringChipActive : null,
                  isPerfect ? ss.stringChipPerfect : null,
                ]}
              >
                <Text style={[
                  ss.stringChipNote,
                  isActive ? ss.stringChipNoteActive : null,
                  isPerfect ? ss.stringChipNotePerfect : null,
                ]}>
                  {str.note.slice(0, -1)}
                </Text>
                <Text style={ss.stringChipFreq}>
                  {str.freq.toFixed(0)}Hz
                </Text>
              </View>
            );
          })}
        </View>
      </View>
    </SafeAreaView>
  );
}

const ss = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  backBtn: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.surface,
  },
  headerTitle: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 18,
    color: C.white,
    letterSpacing: -0.3,
  },
  
  // Beta Badge Styles
  betaBadge: {
    backgroundColor: 'rgba(255, 176, 32, 0.15)',
    borderWidth: 1,
    borderColor: C.amber,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  betaText: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 10,
    color: C.amber,
    letterSpacing: 1.5,
  },
  
  // Beta Notice
  betaNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    backgroundColor: 'rgba(255, 176, 32, 0.06)',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: 'rgba(255, 176, 32, 0.15)',
  },
  betaNoticeText: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 11,
    color: C.text2,
    letterSpacing: 0.3,
  },
  
  // Limited Mode Banner
  limitedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 8,
    padding: 12,
    backgroundColor: 'rgba(249, 115, 22, 0.1)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(249, 115, 22, 0.3)',
  },
  limitedBannerText: {
    flex: 1,
    fontFamily: 'Manrope_400Regular',
    fontSize: 11,
    color: C.text2,
    lineHeight: 16,
  },
  
  instrumentSelector: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  instrumentBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  instrumentBtnActive: {
    backgroundColor: 'rgba(255,176,32,0.12)',
    borderColor: C.amber,
  },
  instrumentBtnText: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 12,
    color: C.text2,
  },
  instrumentBtnTextActive: {
    color: C.amber,
  },
  
  tunerMain: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  
  // Loading & Error States
  loadingOverlay: {
    alignItems: 'center',
    gap: 16,
  },
  loadingText: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 14,
    color: C.text2,
  },
  errorOverlay: {
    alignItems: 'center',
    gap: 12,
    padding: 24,
  },
  errorText: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 14,
    color: C.text2,
    textAlign: 'center',
    maxWidth: 280,
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: C.amber,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 25,
    marginTop: 8,
  },
  retryButtonText: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 14,
    color: C.bg,
  },
  permissionHint: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 11,
    color: C.text3,
    textAlign: 'center',
    marginTop: 8,
    maxWidth: 260,
  },
  
  // Error Container (for ErrorBoundary)
  errorContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 16,
  },
  errorTitle: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 24,
    color: C.white,
  },
  errorMessage: {
    fontFamily: 'Manrope_400Regular',
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
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 15,
    color: C.bg,
  },
  
  arcContainer: {
    width: 240,
    height: 140,
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginBottom: 20,
  },
  arcBg: {
    position: 'absolute',
    bottom: 0,
    width: 240,
    height: 120,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'flex-end',
    gap: 4,
  },
  arcSegment: {
    height: 8,
    borderRadius: 4,
    opacity: 0.3,
  },
  arcLeft: {
    width: 60,
    backgroundColor: C.blue,
  },
  arcCenterSeg: {
    width: 30,
    backgroundColor: C.green,
  },
  arcRight: {
    width: 60,
    backgroundColor: C.red,
  },
  needle: {
    position: 'absolute',
    bottom: 0,
    width: 4,
    height: 100,
    alignItems: 'center',
  },
  needleInner: {
    width: 4,
    height: 80,
    borderRadius: 2,
  },
  arcCenterDot: {
    position: 'absolute',
    bottom: 0,
    alignItems: 'center',
  },
  centerDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
  },
  
  noteDisplay: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: 8,
  },
  noteText: {
    fontFamily: 'Outfit_800ExtraBold',
    fontSize: 96,
    letterSpacing: -4,
    lineHeight: 100,
    ...Platform.select({
      ios: { textShadowColor: C.amberGlow, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 20 },
      default: {},
    }),
  },
  noteOctave: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 32,
    color: C.text2,
    marginLeft: 4,
  },
  
  freqText: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 14,
    color: C.text3,
    marginBottom: 16,
  },
  
  // Audio Level Indicator
  audioLevelContainer: {
    alignItems: 'center',
    marginBottom: 16,
    width: '80%',
  },
  audioLevelLabel: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 9,
    color: C.text3,
    letterSpacing: 1.5,
    marginBottom: 6,
  },
  audioLevelBar: {
    width: '100%',
    height: 6,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 3,
    overflow: 'hidden',
  },
  audioLevelFill: {
    height: '100%',
    borderRadius: 3,
  },
  
  messageBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderRadius: 16,
    backgroundColor: C.surface,
    borderWidth: 2,
    minWidth: 260,
    justifyContent: 'center',
  },
  messageText: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 16,
    letterSpacing: 0.3,
  },
  
  stringName: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 14,
    color: C.amber,
    marginTop: 16,
  },
  
  stringsContainer: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  stringsLabel: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 10,
    color: C.text3,
    letterSpacing: 2,
    marginBottom: 12,
    textAlign: 'center',
  },
  stringsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  stringChip: {
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    minWidth: 56,
  },
  stringChipActive: {
    borderColor: C.amber,
    backgroundColor: 'rgba(255,176,32,0.08)',
  },
  stringChipPerfect: {
    borderColor: C.green,
    backgroundColor: 'rgba(34,197,94,0.12)',
  },
  stringChipNote: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 18,
    color: C.text2,
  },
  stringChipNoteActive: {
    color: C.amber,
  },
  stringChipNotePerfect: {
    color: C.green,
  },
  stringChipFreq: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 10,
    color: C.text3,
    marginTop: 2,
  },
});
