import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, Animated,
  Dimensions, Easing, KeyboardAvoidingView, Platform, ScrollView,
  Keyboard, ActivityIndicator, Linking, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from './AuthContext';

const { width: SW, height: SH } = Dimensions.get('window');

// Ultra-Premium Color Palette
const C = {
  bg: '#030305',
  bgAlt: '#0A0A0F',
  surface: '#0F0F14',
  surfaceLight: '#16161E',
  gold: '#FFB020',
  goldLight: '#FFCC5C',
  goldDeep: '#D4920F',
  goldGlow: 'rgba(255,176,32,0.06)',
  goldGlowMedium: 'rgba(255,176,32,0.12)',
  goldGlowStrong: 'rgba(255,176,32,0.25)',
  white: '#FFFFFF',
  whiteOff: '#F5F5F7',
  gray200: '#E5E5E7',
  gray400: '#9CA3AF',
  gray500: '#6B7280',
  gray600: '#4B5563',
  gray700: '#2A2A35',
  gray800: '#1A1A22',
  gray900: '#0D0D12',
  red: '#F87171',
  green: '#10B981',
  cyan: '#06B6D4',
  purple: '#A855F7',
};

const WHATSAPP_URL =
  'https://wa.me/5563992029322?text=Ol%C3%A1.%20Quero%20Token%20de%20acesso%20do%20aplicativo';

// Floating particles component
function FloatingParticles() {
  const particles = useRef(
    Array.from({ length: 6 }, () => ({
      x: new Animated.Value(Math.random() * SW),
      y: new Animated.Value(Math.random() * SH * 0.5),
      opacity: new Animated.Value(0),
      scale: new Animated.Value(0.5 + Math.random() * 0.5),
    }))
  ).current;

  useEffect(() => {
    particles.forEach((p, i) => {
      const animate = () => {
        const duration = 4000 + Math.random() * 3000;
        Animated.parallel([
          Animated.sequence([
            Animated.timing(p.opacity, { toValue: 0.4, duration: duration * 0.3, useNativeDriver: true }),
            Animated.timing(p.opacity, { toValue: 0, duration: duration * 0.7, useNativeDriver: true }),
          ]),
          Animated.timing(p.y, {
            toValue: -50,
            duration: duration,
            easing: Easing.linear,
            useNativeDriver: true,
          }),
        ]).start(() => {
          p.x.setValue(Math.random() * SW);
          p.y.setValue(SH * 0.6 + Math.random() * 100);
          animate();
        });
      };
      setTimeout(() => animate(), i * 800);
    });
  }, []);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {particles.map((p, i) => (
        <Animated.View
          key={i}
          style={[
            ss.particle,
            {
              opacity: p.opacity,
              transform: [
                { translateX: p.x },
                { translateY: p.y },
                { scale: p.scale },
              ],
            },
          ]}
        />
      ))}
    </View>
  );
}

// Animated ring component
function PulseRing({ delay, size }: { delay: number; size: number }) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    const animate = () => {
      scale.setValue(1);
      opacity.setValue(0.4);
      Animated.parallel([
        Animated.timing(scale, {
          toValue: 1.8,
          duration: 2500,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0,
          duration: 2500,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start(() => animate());
    };
    setTimeout(() => animate(), delay);
  }, []);

  return (
    <Animated.View
      style={[
        ss.pulseRing,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          opacity,
          transform: [{ scale }],
        },
      ]}
    />
  );
}

export default function ActivationScreen() {
  const {
    activate, errorMessage, clearError,
    hasSavedToken, forgetDevice, lastReason, retryRevalidate,
  } = useAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [forceShowInput, setForceShowInput] = useState(false);

  const showInput = !hasSavedToken || forceShowInput;

  // Animations
  const fadeIn = useRef(new Animated.Value(0)).current;
  const slideUp = useRef(new Animated.Value(60)).current;
  const logoScale = useRef(new Animated.Value(0.8)).current;
  const logoRotate = useRef(new Animated.Value(0)).current;
  const glowPulse = useRef(new Animated.Value(0.5)).current;
  const errorShake = useRef(new Animated.Value(0)).current;
  const inputGlow = useRef(new Animated.Value(0)).current;
  const btnScale = useRef(new Animated.Value(1)).current;
  const titleOpacity = useRef(new Animated.Value(0)).current;
  const subtitleOpacity = useRef(new Animated.Value(0)).current;

  // Entry animation sequence
  useEffect(() => {
    Animated.sequence([
      Animated.parallel([
        Animated.timing(fadeIn, {
          toValue: 1,
          duration: 600,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.spring(logoScale, {
          toValue: 1,
          tension: 40,
          friction: 8,
          useNativeDriver: true,
        }),
      ]),
      Animated.parallel([
        Animated.timing(titleOpacity, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }),
        Animated.timing(slideUp, {
          toValue: 0,
          duration: 600,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
      Animated.timing(subtitleOpacity, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }),
    ]).start();

    // Continuous glow pulse
    const glow = Animated.loop(
      Animated.sequence([
        Animated.timing(glowPulse, {
          toValue: 1,
          duration: 2000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(glowPulse, {
          toValue: 0.5,
          duration: 2000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    glow.start();

    // Subtle logo rotation
    const rotate = Animated.loop(
      Animated.sequence([
        Animated.timing(logoRotate, {
          toValue: 1,
          duration: 8000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(logoRotate, {
          toValue: 0,
          duration: 8000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    rotate.start();

    return () => {
      glow.stop();
      rotate.stop();
    };
  }, []);

  // Input glow animation
  useEffect(() => {
    Animated.timing(inputGlow, {
      toValue: focused ? 1 : 0,
      duration: 200,
      useNativeDriver: false,
    }).start();
  }, [focused]);

  // Error shake
  useEffect(() => {
    if (errorMessage) {
      Animated.sequence([
        Animated.timing(errorShake, { toValue: 10, duration: 50, useNativeDriver: true }),
        Animated.timing(errorShake, { toValue: -10, duration: 50, useNativeDriver: true }),
        Animated.timing(errorShake, { toValue: 8, duration: 50, useNativeDriver: true }),
        Animated.timing(errorShake, { toValue: -8, duration: 50, useNativeDriver: true }),
        Animated.timing(errorShake, { toValue: 0, duration: 50, useNativeDriver: true }),
      ]).start();
    }
  }, [errorMessage]);

  const onChangeCode = (t: string) => {
    if (errorMessage) clearError();
    setCode(t.toUpperCase().replace(/\s+/g, ''));
  };

  const onSubmit = async () => {
    if (busy) return;
    if (showInput) {
      if (!code.trim()) return;
      Keyboard.dismiss();
      setBusy(true);
      await activate(code);
      setBusy(false);
    } else {
      Keyboard.dismiss();
      setBusy(true);
      const r = await activate();
      setBusy(false);
      if (!r.ok) setForceShowInput(true);
    }
  };

  const onUseAnotherToken = async () => {
    if (busy) return;
    setCode('');
    await forgetDevice();
    setForceShowInput(true);
  };

  const onBtnPressIn = () => {
    Animated.spring(btnScale, {
      toValue: 0.96,
      useNativeDriver: true,
      tension: 300,
      friction: 10,
    }).start();
  };
  
  const onBtnPressOut = () => {
    Animated.spring(btnScale, {
      toValue: 1,
      useNativeDriver: true,
      tension: 200,
      friction: 8,
    }).start();
  };

  const openWhatsApp = async () => {
    try {
      await Linking.openURL(WHATSAPP_URL);
    } catch { /* */ }
  };

  const canSubmit = showInput ? (!busy && code.trim().length > 0) : !busy;

  const logoRotation = logoRotate.interpolate({
    inputRange: [0, 1],
    outputRange: ['-3deg', '3deg'],
  });

  const inputBorderColor = inputGlow.interpolate({
    inputRange: [0, 1],
    outputRange: [C.gray700, C.gold],
  });

  return (
    <View style={ss.container}>
      {/* Background gradient */}
      <LinearGradient
        colors={[C.bg, '#0A0A12', C.bg]}
        style={StyleSheet.absoluteFill}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
      />
      
      {/* Floating particles */}
      <FloatingParticles />
      
      {/* Radial glow behind logo */}
      <Animated.View style={[ss.radialGlow, { opacity: glowPulse }]} />
      
      <SafeAreaView style={ss.safe}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
          <ScrollView
            contentContainerStyle={ss.scroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Animated.View style={[ss.content, { opacity: fadeIn }]}>
              
              {/* Logo Section */}
              <View style={ss.logoSection}>
                {/* Pulse rings */}
                <View style={ss.pulseContainer}>
                  <PulseRing delay={0} size={140} />
                  <PulseRing delay={800} size={140} />
                  <PulseRing delay={1600} size={140} />
                </View>
                
                {/* Logo with glow */}
                <Animated.View
                  style={[
                    ss.logoWrapper,
                    {
                      transform: [
                        { scale: logoScale },
                        { rotate: logoRotation },
                      ],
                    },
                  ]}
                >
                  <Animated.View style={[ss.logoGlow, { opacity: glowPulse }]} />
                  <View style={ss.logoInner}>
                    <Image
                      source={require('../../assets/images/logo.png')}
                      style={ss.logo}
                      resizeMode="contain"
                    />
                  </View>
                </Animated.View>
                
                {/* Title */}
                <Animated.View style={{ opacity: titleOpacity }}>
                  <Text style={ss.title}>Tom Certo</Text>
                </Animated.View>
                
                {/* Subtitle with tech feel */}
                <Animated.View style={[ss.subtitleRow, { opacity: subtitleOpacity }]}>
                  <View style={ss.techDot} />
                  <Text style={ss.subtitle}>Precisão de tom com IA</Text>
                  <View style={ss.techDot} />
                </Animated.View>
              </View>

              {/* Input Section */}
              <Animated.View
                style={[
                  ss.inputSection,
                  { transform: [{ translateY: slideUp }, { translateX: errorShake }] },
                ]}
              >
                {showInput && (
                  <View style={ss.inputBlock}>
                    <Text style={ss.inputLabel}>CÓDIGO DE ACESSO</Text>
                    <Animated.View
                      style={[
                        ss.inputWrapper,
                        { borderColor: inputBorderColor },
                      ]}
                    >
                      <TextInput
                        testID="token-input"
                        style={ss.input}
                        value={code}
                        onChangeText={onChangeCode}
                        onFocus={() => setFocused(true)}
                        onBlur={() => setFocused(false)}
                        onSubmitEditing={onSubmit}
                        placeholder="Digite seu código"
                        placeholderTextColor={C.gray600}
                        autoCapitalize="characters"
                        autoCorrect={false}
                        maxLength={24}
                        returnKeyType="done"
                        selectionColor={C.gold}
                      />
                      {focused && (
                        <View style={ss.inputGlowEffect} />
                      )}
                    </Animated.View>
                  </View>
                )}

                {/* Error message */}
                {errorMessage && (
                  <View style={ss.errorBox}>
                    <Ionicons name="alert-circle" size={16} color={C.red} />
                    <Text style={ss.errorText}>{errorMessage}</Text>
                  </View>
                )}

                {/* Context actions */}
                {(lastReason === 'device_limit' || lastReason === 'device_mismatch') && !showInput && (
                  <TouchableOpacity onPress={onUseAnotherToken} style={ss.contextBtn}>
                    <Ionicons name="refresh-outline" size={16} color={C.gold} />
                    <Text style={ss.contextBtnText}>Usar outro token</Text>
                  </TouchableOpacity>
                )}

                {(lastReason === 'timeout' || lastReason === 'network') && (
                  <TouchableOpacity
                    onPress={async () => {
                      clearError();
                      if (!showInput) {
                        setBusy(true);
                        await retryRevalidate();
                        setBusy(false);
                      }
                    }}
                    style={ss.contextBtn}
                  >
                    <Ionicons name="wifi-outline" size={16} color={C.gold} />
                    <Text style={ss.contextBtnText}>Tentar novamente</Text>
                  </TouchableOpacity>
                )}

                {/* Primary Button */}
                <Animated.View style={[ss.btnContainer, { transform: [{ scale: btnScale }] }]}>
                  <TouchableOpacity
                    testID="activate-btn"
                    onPress={onSubmit}
                    onPressIn={onBtnPressIn}
                    onPressOut={onBtnPressOut}
                    disabled={!canSubmit}
                    activeOpacity={1}
                    style={ss.btnTouch}
                  >
                    {canSubmit ? (
                      <LinearGradient
                        colors={[C.goldLight, C.gold, C.goldDeep]}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                        style={ss.btn}
                      >
                        <View style={ss.btnShine} />
                        {busy ? (
                          <ActivityIndicator size="small" color={C.bg} />
                        ) : (
                          <>
                            <Text style={ss.btnText}>Ativar acesso</Text>
                            <Ionicons name="arrow-forward" size={18} color={C.bg} style={{ marginLeft: 8 }} />
                          </>
                        )}
                      </LinearGradient>
                    ) : (
                      <View style={ss.btnDisabled}>
                        {busy ? (
                          <ActivityIndicator size="small" color={C.gray500} />
                        ) : (
                          <Text style={ss.btnTextDisabled}>Ativar acesso</Text>
                        )}
                      </View>
                    )}
                  </TouchableOpacity>
                </Animated.View>

                {/* Secondary actions */}
                {!showInput ? (
                  <TouchableOpacity onPress={onUseAnotherToken} style={ss.secondaryBtn}>
                    <Text style={ss.secondaryBtnText}>Usar outro código</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity onPress={openWhatsApp} style={ss.requestBtn}>
                    <Text style={ss.requestLabel}>Não tem código?</Text>
                    <View style={ss.requestAction}>
                      <Ionicons name="logo-whatsapp" size={16} color={C.green} />
                      <Text style={ss.requestActionText}>Solicitar acesso</Text>
                    </View>
                  </TouchableOpacity>
                )}
              </Animated.View>

              {/* Footer */}
              <View style={ss.footer}>
                <View style={ss.footerLine} />
                <View style={ss.footerContent}>
                  <Ionicons name="shield-checkmark" size={14} color={C.gray500} />
                  <Text style={ss.footerText}>Conexão segura e criptografada</Text>
                </View>
                <View style={ss.footerBadges}>
                  <View style={ss.badge}>
                    <Ionicons name="flash" size={10} color={C.cyan} />
                    <Text style={ss.badgeText}>Instant</Text>
                  </View>
                  <View style={ss.badge}>
                    <Ionicons name="lock-closed" size={10} color={C.purple} />
                    <Text style={ss.badgeText}>Secure</Text>
                  </View>
                </View>
              </View>
              
            </Animated.View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const ss = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.bg,
  },
  safe: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingVertical: 60,
    paddingHorizontal: 32,
  },
  content: {
    alignItems: 'center',
  },
  
  // Radial glow
  radialGlow: {
    position: 'absolute',
    top: SH * 0.1,
    left: SW * 0.5 - 150,
    width: 300,
    height: 300,
    borderRadius: 150,
    backgroundColor: 'rgba(255,176,32,0.08)',
    ...Platform.select({
      ios: {
        shadowColor: C.gold,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.3,
        shadowRadius: 100,
      },
      default: {},
    }),
  },
  
  // Particles
  particle: {
    position: 'absolute',
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: C.gold,
  },
  
  // Pulse rings
  pulseContainer: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseRing: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: C.gold,
  },
  
  // Logo Section
  logoSection: {
    alignItems: 'center',
    marginBottom: 48,
  },
  logoWrapper: {
    width: 100,
    height: 100,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  logoGlow: {
    position: 'absolute',
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: 'rgba(255,176,32,0.15)',
    ...Platform.select({
      ios: {
        shadowColor: C.gold,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.5,
        shadowRadius: 30,
      },
      default: {},
    }),
  },
  logoInner: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: C.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,176,32,0.2)',
  },
  logo: {
    width: 64,
    height: 64,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    color: C.white,
    letterSpacing: -0.5,
    marginBottom: 12,
  },
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  techDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: C.gold,
  },
  subtitle: {
    fontSize: 14,
    color: C.gray400,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  
  // Input Section
  inputSection: {
    width: '100%',
    alignItems: 'center',
  },
  inputBlock: {
    width: '100%',
    marginBottom: 24,
  },
  inputLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: C.gray500,
    letterSpacing: 2,
    marginBottom: 12,
    textAlign: 'center',
  },
  inputWrapper: {
    width: '100%',
    backgroundColor: C.surface,
    borderRadius: 16,
    borderWidth: 1.5,
    overflow: 'hidden',
  },
  input: {
    width: '100%',
    fontSize: 18,
    fontWeight: '600',
    color: C.white,
    letterSpacing: 3,
    textAlign: 'center',
    paddingVertical: 18,
    paddingHorizontal: 16,
  },
  inputGlowEffect: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.goldGlowMedium,
    ...Platform.select({
      ios: {
        shadowColor: C.gold,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.3,
        shadowRadius: 10,
      },
      default: {},
    }),
  },
  
  // Error
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(248,113,113,0.1)',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.2)',
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    color: C.red,
    lineHeight: 18,
  },
  
  // Context button
  contextBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: C.goldGlow,
    borderWidth: 1,
    borderColor: C.goldGlowMedium,
    marginBottom: 20,
  },
  contextBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: C.gold,
  },
  
  // Primary Button
  btnContainer: {
    width: '100%',
    marginBottom: 20,
  },
  btnTouch: {
    width: '100%',
  },
  btn: {
    width: '100%',
    height: 56,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: C.gold,
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.4,
        shadowRadius: 16,
      },
      android: { elevation: 8 },
      default: {},
    }),
  },
  btnShine: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '50%',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  btnText: {
    fontSize: 16,
    fontWeight: '700',
    color: C.bg,
    letterSpacing: 0.5,
  },
  btnDisabled: {
    width: '100%',
    height: 56,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.gray700,
  },
  btnTextDisabled: {
    fontSize: 16,
    fontWeight: '600',
    color: C.gray600,
  },
  
  // Secondary button
  secondaryBtn: {
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  secondaryBtnText: {
    fontSize: 14,
    color: C.gray500,
  },
  
  // Request button
  requestBtn: {
    alignItems: 'center',
    paddingVertical: 16,
  },
  requestLabel: {
    fontSize: 13,
    color: C.gray500,
    marginBottom: 8,
  },
  requestAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  requestActionText: {
    fontSize: 14,
    fontWeight: '600',
    color: C.green,
  },
  
  // Footer
  footer: {
    width: '100%',
    marginTop: 40,
    alignItems: 'center',
  },
  footerLine: {
    width: 40,
    height: 1,
    backgroundColor: C.gray700,
    marginBottom: 20,
  },
  footerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  footerText: {
    fontSize: 12,
    color: C.gray500,
  },
  footerBadges: {
    flexDirection: 'row',
    gap: 12,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.gray700,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: C.gray400,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
