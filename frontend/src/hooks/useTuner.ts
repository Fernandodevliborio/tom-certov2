import { useState, useRef, useCallback, useEffect } from 'react';
import { Platform, PermissionsAndroid, Alert } from 'react-native';
import { Audio } from 'expo-av';

// Import native pitch detection for Android/iOS
let Pitchy: any = null;
if (Platform.OS !== 'web') {
  try {
    Pitchy = require('react-native-pitchy').default;
  } catch (e) {
    console.warn('[useTuner] react-native-pitchy not available:', e);
  }
}

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
    isNativeSupported: Platform.OS !== 'web' && Pitchy !== null,
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
  
  // Start tuner for web platform (Web Audio API)
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
      
      if (!Pitchy) {
        throw new Error('Biblioteca de detecção de pitch não disponível');
      }
      
      // Initialize Pitchy with configuration
      await Pitchy.init({
        minVolume: 15, // Minimum volume threshold (0-100)
        bufferSize: 2048, // Buffer size for analysis
      });
      
      // Set up pitch detection callback
      Pitchy.addListener((data: { pitch: number; volume: number }) => {
        if (!mountedRef.current || !isRunningRef.current) return;
        
        try {
          const { pitch, volume } = data;
          const noiseLevel = Math.min(1, volume / 100);
          
          // Only process if volume is above threshold and pitch is valid
          if (volume > 15 && pitch > 30 && pitch < 1000) {
            const smoothed = smoothFrequency(pitch);
            safeSetState({
              frequency: smoothed,
              smoothedFrequency: smoothed,
              noiseLevel,
            });
          } else if (volume > 5) {
            // Has some audio but no clear pitch
            safeSetState({ noiseLevel, frequency: null });
          } else {
            // Very quiet
            safeSetState({ noiseLevel: 0, frequency: null });
          }
        } catch (err) {
          console.warn('[useTuner] Pitch callback error:', err);
        }
      });
      
      // Start pitch detection
      await Pitchy.start();
      
      isRunningRef.current = true;
      safeSetState({ 
        isActive: true, 
        error: null,
        isNativeSupported: true,
      });
      
      console.log('[useTuner] Native Pitch Detection started successfully');
      
    } catch (err: any) {
      console.error('[useTuner] startNative error:', err);
      
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
      // Native cleanup
      if (Pitchy) {
        try {
          await Pitchy.stop();
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
        
        if (Pitchy && Platform.OS !== 'web') {
          try { await Pitchy.stop(); } catch {}
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
