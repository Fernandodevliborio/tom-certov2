import { useState, useRef, useCallback, useEffect } from 'react';
import { Platform, PermissionsAndroid } from 'react-native';
import { Audio } from 'expo-av';

// YIN algorithm constants for web
const BUFFER_SIZE = 2048;
const SAMPLE_RATE = 44100;
const YIN_THRESHOLD = 0.15;

interface TunerState {
  isActive: boolean;
  frequency: number | null;
  smoothedFrequency: number | null;
  noiseLevel: number;
  error: string | null;
  permissionStatus: 'unknown' | 'granted' | 'denied' | 'blocked';
  isNativeSupported: boolean;
}

export function useTuner() {
  const [state, setState] = useState<TunerState>({
    isActive: false,
    frequency: null,
    smoothedFrequency: null,
    noiseLevel: 0,
    error: null,
    permissionStatus: 'unknown',
    isNativeSupported: Platform.OS !== 'web',
  });
  
  const isRunningRef = useRef(false);
  const frequencyHistoryRef = useRef<number[]>([]);
  const mountedRef = useRef(true);
  
  // Web-specific refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  
  // Native-specific refs
  const pitchySubscriptionRef = useRef<{ remove: () => void } | null>(null);
  const pitchyModuleRef = useRef<any>(null);
  
  // Cleanup ref on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  
  // Safe setState that checks if mounted
  const safeSetState = useCallback((updater: Partial<TunerState> | ((s: TunerState) => TunerState)) => {
    if (!mountedRef.current) return;
    if (typeof updater === 'function') {
      setState(updater);
    } else {
      setState(s => ({ ...s, ...updater }));
    }
  }, []);
  
  // Smoothing: média móvel das últimas 5 frequências
  const smoothFrequency = useCallback((newFreq: number): number => {
    const history = frequencyHistoryRef.current;
    history.push(newFreq);
    if (history.length > 5) history.shift();
    
    // Ignora outliers (diferença > 50% da média)
    const avg = history.reduce((a, b) => a + b, 0) / history.length;
    const filtered = history.filter(f => Math.abs(f - avg) / avg < 0.5);
    
    if (filtered.length === 0) return newFreq;
    return filtered.reduce((a, b) => a + b, 0) / filtered.length;
  }, []);
  
  // YIN pitch detection algorithm (for web)
  const detectPitchYIN = useCallback((buffer: Float32Array): number | null => {
    try {
      const bufferSize = buffer.length;
      const yinBuffer = new Float32Array(bufferSize / 2);
      
      let runningSum = 0;
      yinBuffer[0] = 1;
      
      for (let tau = 1; tau < bufferSize / 2; tau++) {
        yinBuffer[tau] = 0;
        for (let i = 0; i < bufferSize / 2; i++) {
          const delta = buffer[i] - buffer[i + tau];
          yinBuffer[tau] += delta * delta;
        }
        runningSum += yinBuffer[tau];
        if (runningSum > 0) {
          yinBuffer[tau] *= tau / runningSum;
        }
      }
      
      let tau = 2;
      while (tau < bufferSize / 2 && yinBuffer[tau] > YIN_THRESHOLD) {
        tau++;
      }
      
      if (tau === bufferSize / 2) return null;
      
      let betterTau = tau;
      if (tau > 0 && tau < bufferSize / 2 - 1) {
        const s0 = yinBuffer[tau - 1];
        const s1 = yinBuffer[tau];
        const s2 = yinBuffer[tau + 1];
        const denom = 2 * (2 * s1 - s2 - s0);
        if (Math.abs(denom) > 0.0001) {
          betterTau = tau + (s2 - s0) / denom;
        }
      }
      
      return SAMPLE_RATE / betterTau;
    } catch (err) {
      console.warn('[useTuner] YIN detection error:', err);
      return null;
    }
  }, []);
  
  // Calculate noise level from buffer
  const calculateNoiseLevel = useCallback((buffer: Float32Array): number => {
    try {
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) {
        sum += buffer[i] * buffer[i];
      }
      const rms = Math.sqrt(sum / buffer.length);
      return Math.min(1, rms * 10);
    } catch {
      return 0;
    }
  }, []);
  
  // Request microphone permission
  const requestMicPermission = useCallback(async (): Promise<'granted' | 'denied' | 'blocked'> => {
    try {
      if (Platform.OS === 'web') {
        return 'granted';
      }
      
      if (Platform.OS === 'android') {
        const result = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          {
            title: 'Permissão de Microfone',
            message: 'O afinador precisa acessar o microfone para detectar as notas do seu instrumento.',
            buttonPositive: 'Permitir',
            buttonNegative: 'Negar',
          }
        );
        
        if (result === PermissionsAndroid.RESULTS.GRANTED) {
          return 'granted';
        } else if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
          return 'blocked';
        }
        return 'denied';
      }
      
      // iOS: use expo-av permission
      const permission = await Audio.requestPermissionsAsync();
      if (permission.granted) return 'granted';
      if (permission.canAskAgain === false) return 'blocked';
      return 'denied';
      
    } catch (err) {
      console.error('[useTuner] Permission request error:', err);
      return 'denied';
    }
  }, []);
  
  // Start tuner for web platform (Web Audio API with YIN algorithm)
  const startWeb = useCallback(async () => {
    try {
      console.log('[useTuner] Starting Web Audio API...');
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      });
      streamRef.current = stream;
      
      const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      audioContextRef.current = audioContext;
      
      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;
      
      const analyzer = audioContext.createAnalyser();
      analyzer.fftSize = BUFFER_SIZE * 2;
      analyzerRef.current = analyzer;
      
      source.connect(analyzer);
      
      const processAudio = () => {
        if (!isRunningRef.current || !mountedRef.current) {
          return;
        }
        
        try {
          const buffer = new Float32Array(BUFFER_SIZE);
          analyzer.getFloatTimeDomainData(buffer);
          
          const noiseLevel = calculateNoiseLevel(buffer);
          
          if (noiseLevel > 0.01) {
            const pitch = detectPitchYIN(buffer);
            if (pitch && pitch > 30 && pitch < 1000) {
              const smoothed = smoothFrequency(pitch);
              safeSetState({
                frequency: smoothed,
                smoothedFrequency: smoothed,
                noiseLevel,
              });
            } else {
              safeSetState({ noiseLevel });
            }
          } else {
            safeSetState({ frequency: null, noiseLevel });
          }
        } catch (err) {
          console.warn('[useTuner] processAudio error:', err);
        }
        
        animFrameRef.current = requestAnimationFrame(processAudio);
      };
      
      isRunningRef.current = true;
      safeSetState({ isActive: true, error: null, permissionStatus: 'granted' });
      processAudio();
      
      console.log('[useTuner] Web Audio started successfully');
      
    } catch (err: any) {
      console.error('[useTuner] startWeb error:', err);
      const errMsg = err?.name === 'NotAllowedError' 
        ? 'Permissão de microfone negada'
        : err?.message || 'Erro ao acessar microfone';
      safeSetState({ 
        error: errMsg,
        permissionStatus: err?.name === 'NotAllowedError' ? 'denied' : 'unknown',
      });
      throw err;
    }
  }, [detectPitchYIN, smoothFrequency, calculateNoiseLevel, safeSetState]);
  
  // Start tuner for native platform (Android/iOS) using react-native-pitchy
  const startNative = useCallback(async () => {
    try {
      console.log('[useTuner] Starting Native Pitch Detection...');
      
      // First request permission explicitly
      const permStatus = await requestMicPermission();
      console.log('[useTuner] Permission status:', permStatus);
      
      safeSetState({ permissionStatus: permStatus });
      
      if (permStatus !== 'granted') {
        const errMsg = permStatus === 'blocked'
          ? 'Permissão de microfone bloqueada. Vá nas configurações do app para permitir.'
          : 'Permissão de microfone negada. Toque em "Permitir" quando solicitado.';
        safeSetState({ error: errMsg });
        throw new Error(errMsg);
      }
      
      // Dynamically import react-native-pitchy
      let Pitchy: any = null;
      try {
        Pitchy = require('react-native-pitchy').default;
        pitchyModuleRef.current = Pitchy;
        console.log('[useTuner] react-native-pitchy loaded');
      } catch (e) {
        console.warn('[useTuner] react-native-pitchy not available:', e);
        throw new Error('Biblioteca de detecção de pitch não disponível');
      }
      
      if (!Pitchy) {
        throw new Error('Módulo Pitchy não encontrado');
      }
      
      // 1. Initialize Pitchy with configuration
      const config = {
        bufferSize: 4096,  // Larger buffer = better accuracy
        minVolume: -60,    // dB threshold (more sensitive)
      };
      
      console.log('[useTuner] Initializing Pitchy with config:', config);
      Pitchy.init(config);
      
      // 2. Create the pitch handler callback BEFORE starting
      const handlePitch = (data: { pitch: number }) => {
        if (!mountedRef.current || !isRunningRef.current) return;
        
        try {
          const { pitch } = data;
          
          console.log('[useTuner] Pitch detected:', pitch);
          
          // Only process if pitch is valid (positive and in musical range)
          if (pitch && pitch > 30 && pitch < 1000) {
            const smoothed = smoothFrequency(pitch);
            safeSetState({
              frequency: smoothed,
              smoothedFrequency: smoothed,
              noiseLevel: 0.5, // Indicate sound is being detected
            });
          } else if (pitch === 0 || !pitch) {
            // No clear pitch detected
            safeSetState({ 
              noiseLevel: 0.1, 
            });
          }
        } catch (err) {
          console.warn('[useTuner] Pitch callback error:', err);
        }
      };
      
      // 3. Add listener BEFORE starting (correct order according to docs)
      console.log('[useTuner] Adding pitch listener...');
      pitchySubscriptionRef.current = Pitchy.addListener(handlePitch);
      
      // 4. Start pitch detection
      console.log('[useTuner] Starting Pitchy...');
      await Pitchy.start();
      
      // 5. Verify it's recording
      const isRecording = await Pitchy.isRecording();
      console.log('[useTuner] Pitchy isRecording:', isRecording);
      
      if (!isRecording) {
        throw new Error('Falha ao iniciar gravação de áudio');
      }
      
      isRunningRef.current = true;
      safeSetState({ 
        isActive: true, 
        error: null,
        isNativeSupported: true,
      });
      
      console.log('[useTuner] Native Pitch Detection started successfully');
      
    } catch (err: any) {
      console.error('[useTuner] startNative error:', err);
      
      // Clean up subscription on error
      if (pitchySubscriptionRef.current) {
        try {
          pitchySubscriptionRef.current.remove();
        } catch {}
        pitchySubscriptionRef.current = null;
      }
      
      const errMsg = err?.message || 'Erro ao iniciar detecção de áudio';
      safeSetState({ error: errMsg });
      throw err;
    }
  }, [requestMicPermission, smoothFrequency, safeSetState]);
  
  // Main start function
  const start = useCallback(async () => {
    if (isRunningRef.current) {
      console.log('[useTuner] Already running, skipping start');
      return;
    }
    
    console.log('[useTuner] Starting tuner on platform:', Platform.OS);
    frequencyHistoryRef.current = [];
    
    try {
      if (Platform.OS === 'web') {
        await startWeb();
      } else {
        await startNative();
      }
    } catch (err) {
      console.log('[useTuner] Start failed, error already set');
    }
  }, [startWeb, startNative]);
  
  // Stop function
  const stop = useCallback(async () => {
    console.log('[useTuner] Stopping tuner...');
    isRunningRef.current = false;
    
    // Cancel animation frame (web)
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    
    if (Platform.OS === 'web') {
      // Web cleanup
      try {
        if (audioContextRef.current) {
          await audioContextRef.current.close();
          audioContextRef.current = null;
        }
      } catch (err) {
        console.warn('[useTuner] Error closing audio context:', err);
      }
      
      try {
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop());
          streamRef.current = null;
        }
      } catch (err) {
        console.warn('[useTuner] Error stopping stream:', err);
      }
      
      sourceRef.current = null;
      analyzerRef.current = null;
    } else {
      // Native cleanup - IMPORTANT: Remove listener FIRST, then stop
      if (pitchySubscriptionRef.current) {
        console.log('[useTuner] Removing Pitchy listener...');
        try {
          pitchySubscriptionRef.current.remove();
        } catch (err) {
          console.warn('[useTuner] Error removing listener:', err);
        }
        pitchySubscriptionRef.current = null;
      }
      
      if (pitchyModuleRef.current) {
        try {
          console.log('[useTuner] Stopping Pitchy...');
          await pitchyModuleRef.current.stop();
        } catch (err) {
          console.warn('[useTuner] Error stopping Pitchy:', err);
        }
      }
    }
    
    safeSetState({
      isActive: false,
      frequency: null,
      smoothedFrequency: null,
      noiseLevel: 0,
      error: null,
    });
    
    console.log('[useTuner] Tuner stopped');
  }, [safeSetState]);
  
  // Cleanup on unmount
  useEffect(() => {
    return () => {
      console.log('[useTuner] Component unmounting, cleaning up...');
      isRunningRef.current = false;
      
      (async () => {
        if (animFrameRef.current) {
          cancelAnimationFrame(animFrameRef.current);
        }
        
        if (audioContextRef.current) {
          try { await audioContextRef.current.close(); } catch {}
        }
        
        if (streamRef.current) {
          try { streamRef.current.getTracks().forEach(t => t.stop()); } catch {}
        }
        
        // Native cleanup
        if (pitchySubscriptionRef.current) {
          try { pitchySubscriptionRef.current.remove(); } catch {}
        }
        
        if (pitchyModuleRef.current && Platform.OS !== 'web') {
          try { await pitchyModuleRef.current.stop(); } catch {}
        }
      })();
    };
  }, []);
  
  return {
    ...state,
    start,
    stop,
  };
}
