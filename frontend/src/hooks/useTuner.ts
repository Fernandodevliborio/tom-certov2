import { useState, useRef, useCallback, useEffect } from 'react';
import { Platform } from 'react-native';
import { Audio } from 'expo-av';

// YIN algorithm constants
const BUFFER_SIZE = 2048;
const SAMPLE_RATE = 44100;
const YIN_THRESHOLD = 0.15;

interface TunerState {
  isActive: boolean;
  frequency: number | null;
  smoothedFrequency: number | null;
  noiseLevel: number;
  error: string | null;
}

export function useTuner() {
  const [state, setState] = useState<TunerState>({
    isActive: false,
    frequency: null,
    smoothedFrequency: null,
    noiseLevel: 0,
    error: null,
  });
  
  const recordingRef = useRef<Audio.Recording | null>(null);
  const isRunningRef = useRef(false);
  const frequencyHistoryRef = useRef<number[]>([]);
  const analyzerRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  
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
  
  // YIN pitch detection algorithm
  const detectPitchYIN = useCallback((buffer: Float32Array): number | null => {
    const bufferSize = buffer.length;
    const yinBuffer = new Float32Array(bufferSize / 2);
    
    // Step 1: Calculate squared difference
    let runningSum = 0;
    yinBuffer[0] = 1;
    
    for (let tau = 1; tau < bufferSize / 2; tau++) {
      yinBuffer[tau] = 0;
      for (let i = 0; i < bufferSize / 2; i++) {
        const delta = buffer[i] - buffer[i + tau];
        yinBuffer[tau] += delta * delta;
      }
      runningSum += yinBuffer[tau];
      yinBuffer[tau] *= tau / runningSum;
    }
    
    // Step 2: Find the first dip below threshold
    let tau = 2;
    while (tau < bufferSize / 2 && yinBuffer[tau] > YIN_THRESHOLD) {
      tau++;
    }
    
    if (tau === bufferSize / 2) return null;
    
    // Step 3: Parabolic interpolation
    let betterTau = tau;
    if (tau > 0 && tau < bufferSize / 2 - 1) {
      const s0 = yinBuffer[tau - 1];
      const s1 = yinBuffer[tau];
      const s2 = yinBuffer[tau + 1];
      betterTau = tau + (s2 - s0) / (2 * (2 * s1 - s2 - s0));
    }
    
    return SAMPLE_RATE / betterTau;
  }, []);
  
  // Calculate noise level from buffer
  const calculateNoiseLevel = useCallback((buffer: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      sum += buffer[i] * buffer[i];
    }
    const rms = Math.sqrt(sum / buffer.length);
    // Normalize to 0-1 range
    return Math.min(1, rms * 10);
  }, []);
  
  // Start tuner for web platform
  const startWeb = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
        if (!isRunningRef.current) return;
        
        const buffer = new Float32Array(BUFFER_SIZE);
        analyzer.getFloatTimeDomainData(buffer);
        
        const noiseLevel = calculateNoiseLevel(buffer);
        
        // Only detect pitch if there's enough signal
        if (noiseLevel > 0.01) {
          const pitch = detectPitchYIN(buffer);
          if (pitch && pitch > 30 && pitch < 1000) {
            const smoothed = smoothFrequency(pitch);
            setState(s => ({
              ...s,
              frequency: smoothed,
              smoothedFrequency: smoothed,
              noiseLevel,
            }));
          }
        } else {
          setState(s => ({ ...s, frequency: null, noiseLevel }));
        }
        
        requestAnimationFrame(processAudio);
      };
      
      isRunningRef.current = true;
      setState(s => ({ ...s, isActive: true, error: null }));
      processAudio();
      
    } catch (err: any) {
      setState(s => ({ ...s, error: err.message || 'Erro ao acessar microfone' }));
    }
  }, [detectPitchYIN, smoothFrequency, calculateNoiseLevel]);
  
  // Start tuner for native platform (simplified - uses expo-av)
  const startNative = useCallback(async () => {
    try {
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        setState(s => ({ ...s, error: 'Permissão de microfone negada' }));
        return;
      }
      
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      
      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      
      recordingRef.current = recording;
      isRunningRef.current = true;
      
      // Note: Full pitch detection on native would require native module
      // For now, we'll use a simplified approach with metering
      recording.setOnRecordingStatusUpdate((status) => {
        if (status.isRecording && status.metering !== undefined) {
          // Convert dB to noise level (0-1)
          const db = status.metering;
          const noiseLevel = Math.max(0, Math.min(1, (db + 60) / 60));
          
          setState(s => ({ ...s, noiseLevel }));
        }
      });
      
      await recording.startAsync();
      setState(s => ({ ...s, isActive: true, error: null }));
      
      // For native, we'd need to implement proper pitch detection
      // This is a placeholder that simulates detection
      const simulateDetection = () => {
        if (!isRunningRef.current) return;
        
        // In a real implementation, we'd process audio data here
        // For now, this serves as a framework
        
        setTimeout(simulateDetection, 50);
      };
      simulateDetection();
      
    } catch (err: any) {
      setState(s => ({ ...s, error: err.message || 'Erro ao iniciar gravação' }));
    }
  }, []);
  
  const start = useCallback(async () => {
    if (isRunningRef.current) return;
    
    frequencyHistoryRef.current = [];
    
    if (Platform.OS === 'web') {
      await startWeb();
    } else {
      await startNative();
    }
  }, [startWeb, startNative]);
  
  const stop = useCallback(async () => {
    isRunningRef.current = false;
    
    if (Platform.OS === 'web') {
      if (audioContextRef.current) {
        await audioContextRef.current.close();
        audioContextRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
    } else {
      if (recordingRef.current) {
        try {
          await recordingRef.current.stopAndUnloadAsync();
        } catch {}
        recordingRef.current = null;
      }
    }
    
    setState({
      isActive: false,
      frequency: null,
      smoothedFrequency: null,
      noiseLevel: 0,
      error: null,
    });
  }, []);
  
  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);
  
  return {
    ...state,
    start,
    stop,
  };
}
