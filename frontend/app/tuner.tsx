import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated,
  Dimensions, Platform,
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

export default function TunerScreen() {
  const [instrument, setInstrument] = useState<InstrumentKey>('violao');
  const [hasError, setHasError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const tuner = useTuner();
  const arcAnim = useRef(new Animated.Value(0)).current;
  
  const currentInstrument = INSTRUMENTS[instrument];
  
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
    const cents = 1200 * Math.log2(tuner.frequency / closestString.freq);
    return Math.round(cents);
  }, [tuner.frequency, closestString]);
  
  const cents = getCents();
  
  // Status da afinação
  const getTuningStatus = () => {
    if (hasError) return { status: 'error', message: 'Erro ao iniciar. Tente novamente.', color: C.red };
    if (!tuner.isActive) return { status: 'idle', message: 'Toque uma corda para começar', color: C.text2 };
    if (!tuner.frequency || tuner.frequency < 30) return { status: 'waiting', message: 'Aproxime o instrumento do microfone', color: C.text2 };
    if (tuner.noiseLevel > 0.7) return { status: 'noise', message: 'Ambiente com muito ruído. Tente novamente.', color: C.red };
    
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
  
  // Inicia o tuner ao montar COM TRATAMENTO DE ERROS
  useEffect(() => {
    let mounted = true;
    
    const initTuner = async () => {
      try {
        setIsLoading(true);
        setHasError(false);
        await tuner.start();
        if (mounted) setIsLoading(false);
      } catch (err) {
        console.error('[Tuner] Erro ao iniciar:', err);
        if (mounted) {
          setHasError(true);
          setIsLoading(false);
        }
      }
    };
    
    // Pequeno delay para garantir que a tela montou
    const timeout = setTimeout(initTuner, 100);
    
    return () => {
      mounted = false;
      clearTimeout(timeout);
      tuner.stop().catch(() => {});
    };
  }, []);
  
  // Handler para tentar novamente
  const handleRetry = async () => {
    try {
      setIsLoading(true);
      setHasError(false);
      await tuner.start();
      setIsLoading(false);
    } catch (err) {
      console.error('[Tuner] Erro ao reiniciar:', err);
      setHasError(true);
      setIsLoading(false);
    }
  };
  
  const arcRotation = arcAnim.interpolate({
    inputRange: [-1, 1],
    outputRange: ['-45deg', '45deg'],
  });
  
  return (
    <SafeAreaView style={ss.safe}>
      {/* Header */}
      <View style={ss.header}>
        <TouchableOpacity onPress={() => router.back()} style={ss.backBtn}>
          <Ionicons name="arrow-back" size={22} color={C.white} />
        </TouchableOpacity>
        <Text style={ss.headerTitle}>Afinador Inteligente</Text>
        <View style={{ width: 44 }} />
      </View>
      
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
        {/* Arco/Medidor */}
        <View style={ss.arcContainer}>
          {/* Background do arco */}
          <View style={ss.arcBg}>
            <View style={[ss.arcSegment, ss.arcLeft]} />
            <View style={[ss.arcSegment, ss.arcCenter]} />
            <View style={[ss.arcSegment, ss.arcRight]} />
          </View>
          
          {/* Ponteiro */}
          <Animated.View style={[ss.needle, { transform: [{ rotate: arcRotation }] }]}>
            <View style={[ss.needleInner, { backgroundColor: tuningStatus.color }]} />
          </Animated.View>
          
          {/* Centro */}
          <View style={ss.arcCenter}>
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
        
        {/* Mensagem Inteligente */}
        <View style={[ss.messageBox, { borderColor: tuningStatus.color }]}>
          <Ionicons
            name={
              tuningStatus.status === 'perfect' ? 'checkmark-circle' :
              tuningStatus.status === 'almost' ? 'ellipse' :
              tuningStatus.status === 'low' ? 'arrow-up' :
              tuningStatus.status === 'high' ? 'arrow-down' :
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
      </View>
      
      {/* Lista de Cordas */}
      <View style={ss.stringsContainer}>
        <Text style={ss.stringsLabel}>CORDAS DO {currentInstrument.name.toUpperCase()}</Text>
        <View style={ss.stringsRow}>
          {currentInstrument.strings.map((str, idx) => {
            const isActive = closestString?.note === str.note && tuner.frequency && tuner.frequency > 30;
            const isPerfect = isActive && Math.abs(cents) <= 5;
            
            return (
              <View
                key={idx}
                style={[
                  ss.stringChip,
                  isActive && ss.stringChipActive,
                  isPerfect && ss.stringChipPerfect,
                ]}
              >
                <Text style={[
                  ss.stringChipNote,
                  isActive && ss.stringChipNoteActive,
                  isPerfect && ss.stringChipNotePerfect,
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
  arcCenter: {
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
  centerDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    position: 'absolute',
    bottom: -10,
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
    marginBottom: 24,
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
