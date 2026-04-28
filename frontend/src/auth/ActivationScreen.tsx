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

// Premium Color Palette - Apple/Tesla inspired
const C = {
  bg: '#000000',
  bgAlt: '#0A0A0A',
  gold: '#FFB020',
  goldLight: '#FFCA5C',
  goldDeep: '#D4920F',
  goldGlow: 'rgba(255,176,32,0.08)',
  goldGlowMedium: 'rgba(255,176,32,0.15)',
  goldGlowStrong: 'rgba(255,176,32,0.25)',
  white: '#FFFFFF',
  whiteOff: '#FAFAFA',
  gray200: '#D4D4D4',
  gray400: '#9CA3AF',
  gray500: '#777777',
  gray600: '#525252',
  gray700: '#333333',
  gray800: '#1A1A1A',
  gray900: '#0D0D0D',
  red: '#F87171',
};

const WHATSAPP_URL =
  'https://wa.me/5563992029322?text=Ol%C3%A1.%20Quero%20Token%20de%20acesso%20do%20aplicativo';

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
  const slideUp = useRef(new Animated.Value(40)).current;
  const logoScale = useRef(new Animated.Value(0.9)).current;
  const logoGlow = useRef(new Animated.Value(0.6)).current;
  const errorShake = useRef(new Animated.Value(0)).current;
  const inputLineWidth = useRef(new Animated.Value(0)).current;
  const btnScale = useRef(new Animated.Value(1)).current;
  const linkScale = useRef(new Animated.Value(1)).current;

  // Entry animation
  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeIn, { 
        toValue: 1, 
        duration: 800, 
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true 
      }),
      Animated.timing(slideUp, { 
        toValue: 0, 
        duration: 800, 
        easing: Easing.out(Easing.cubic), 
        useNativeDriver: true 
      }),
      Animated.spring(logoScale, { 
        toValue: 1, 
        tension: 50, 
        friction: 10, 
        useNativeDriver: true 
      }),
    ]).start();

    // Subtle breathing glow on logo
    const breathe = Animated.loop(
      Animated.sequence([
        Animated.timing(logoGlow, { 
          toValue: 1, 
          duration: 2500, 
          easing: Easing.inOut(Easing.ease), 
          useNativeDriver: true 
        }),
        Animated.timing(logoGlow, { 
          toValue: 0.6, 
          duration: 2500, 
          easing: Easing.inOut(Easing.ease), 
          useNativeDriver: true 
        }),
      ])
    );
    breathe.start();
    return () => breathe.stop();
  }, []);

  // Input line animation
  useEffect(() => {
    Animated.timing(inputLineWidth, {
      toValue: focused || code.length > 0 ? 1 : 0,
      duration: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [focused, code]);

  // Error shake
  useEffect(() => {
    if (errorMessage) {
      Animated.sequence([
        Animated.timing(errorShake, { toValue: 8, duration: 40, useNativeDriver: true }),
        Animated.timing(errorShake, { toValue: -8, duration: 40, useNativeDriver: true }),
        Animated.timing(errorShake, { toValue: 5, duration: 40, useNativeDriver: true }),
        Animated.timing(errorShake, { toValue: -5, duration: 40, useNativeDriver: true }),
        Animated.timing(errorShake, { toValue: 0, duration: 40, useNativeDriver: true }),
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

  // Button micro-interactions
  const onBtnPressIn = () => {
    Animated.spring(btnScale, { 
      toValue: 0.97, 
      useNativeDriver: true,
      tension: 300,
      friction: 10
    }).start();
  };
  const onBtnPressOut = () => {
    Animated.spring(btnScale, { 
      toValue: 1, 
      useNativeDriver: true,
      tension: 200,
      friction: 8
    }).start();
  };

  const onLinkPressIn = () => {
    Animated.spring(linkScale, { toValue: 0.97, useNativeDriver: true }).start();
  };
  const onLinkPressOut = () => {
    Animated.spring(linkScale, { toValue: 1, friction: 5, useNativeDriver: true }).start();
  };

  const openWhatsApp = async () => {
    try { await Linking.openURL(WHATSAPP_URL); } catch { /* */ }
  };

  const canSubmit = showInput ? (!busy && code.trim().length > 0) : !busy;

  // Interpolate input line color
  const inputLineColor = inputLineWidth.interpolate({
    inputRange: [0, 1],
    outputRange: [C.gray700, C.gold],
  });

  return (
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
          <Animated.View style={[
            ss.container, 
            { 
              opacity: fadeIn, 
              transform: [{ translateY: slideUp }] 
            }
          ]}>

            {/* Premium Logo Block */}
            <Animated.View style={[ss.logoBlock, { transform: [{ scale: logoScale }] }]}>
              <Animated.View style={[ss.logoContainer, { opacity: logoGlow }]}>
                <View style={ss.logoGlowOuter} />
                <Image
                  source={require('../../assets/images/logo.png')}
                  style={ss.logo}
                  resizeMode="contain"
                />
              </Animated.View>
              <Text style={ss.tagline}>Precisão de tom com IA</Text>
            </Animated.View>

            {/* Token Input Block */}
            {showInput && (
              <Animated.View style={[ss.inputBlock, { transform: [{ translateX: errorShake }] }]}>
                <View style={ss.inputWrapper}>
                  <TextInput
                    testID="token-input"
                    style={ss.input}
                    value={code}
                    onChangeText={onChangeCode}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    onSubmitEditing={onSubmit}
                    placeholder="Digite seu código de acesso"
                    placeholderTextColor={C.gray600}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    maxLength={24}
                    returnKeyType="done"
                    selectionColor={C.gold}
                    underlineColorAndroid="transparent"
                  />
                  {/* Animated underline */}
                  <View style={ss.inputLineBase} />
                  <Animated.View 
                    style={[
                      ss.inputLineActive,
                      { 
                        backgroundColor: inputLineColor,
                        transform: [{ 
                          scaleX: inputLineWidth.interpolate({
                            inputRange: [0, 1],
                            outputRange: [0.3, 1],
                          })
                        }]
                      }
                    ]} 
                  />
                </View>
                {errorMessage && (
                  <View style={ss.errorRow}>
                    <Ionicons name="alert-circle" size={14} color={C.red} />
                    <Text style={ss.errorText}>{errorMessage}</Text>
                  </View>
                )}
              </Animated.View>
            )}

            {/* Standalone Error (when input hidden) */}
            {!showInput && errorMessage && (
              <Animated.View style={[ss.errorStandalone, { transform: [{ translateX: errorShake }] }]}>
                <Ionicons name="alert-circle" size={14} color={C.red} />
                <Text style={ss.errorText}>{errorMessage}</Text>
              </Animated.View>
            )}

            {/* Context Actions */}
            {(lastReason === 'device_limit' || lastReason === 'device_mismatch') && !showInput && (
              <TouchableOpacity onPress={onUseAnotherToken} activeOpacity={0.7} style={ss.contextBtn}>
                <Ionicons name="refresh-outline" size={14} color={C.gold} />
                <Text style={ss.contextBtnText}>Limpar e usar outro token</Text>
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
                activeOpacity={0.7}
                style={ss.contextBtn}
              >
                <Ionicons name="wifi-outline" size={14} color={C.gold} />
                <Text style={ss.contextBtnText}>Tentar conectar novamente</Text>
              </TouchableOpacity>
            )}

            {/* Premium Activate Button */}
            <Animated.View style={[
              ss.btnOuter,
              { transform: [{ scale: btnScale }] }
            ]}>
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
                    <View style={ss.btnGlow} />
                    {busy ? (
                      <ActivityIndicator size="small" color={C.bg} />
                    ) : (
                      <Text style={ss.btnText}>Ativar acesso</Text>
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

            {/* Request Access Link */}
            {!showInput ? (
              <TouchableOpacity 
                onPress={onUseAnotherToken} 
                activeOpacity={0.7} 
                style={ss.secondaryLink}
              >
                <Text style={ss.secondaryLinkText}>Usar outro token</Text>
              </TouchableOpacity>
            ) : (
              <Animated.View style={[ss.requestBlock, { transform: [{ scale: linkScale }] }]}>
                <TouchableOpacity
                  onPress={openWhatsApp}
                  onPressIn={onLinkPressIn}
                  onPressOut={onLinkPressOut}
                  activeOpacity={0.8}
                  style={ss.requestTouch}
                >
                  <Text style={ss.requestLabel}>Ainda não tem acesso?</Text>
                  <Text style={ss.requestAction}>Solicitar código</Text>
                </TouchableOpacity>
              </Animated.View>
            )}

            {/* Premium Footer */}
            <View style={ss.footer}>
              <View style={ss.footerIconWrap}>
                <Ionicons name="shield-checkmark-outline" size={13} color={C.gray500} />
              </View>
              <Text style={ss.footerText}>Acesso seguro e verificado instantaneamente</Text>
            </View>

          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const ss = StyleSheet.create({
  safe: { 
    flex: 1, 
    backgroundColor: C.bg 
  },
  scroll: { 
    flexGrow: 1, 
    justifyContent: 'center', 
    paddingVertical: 80,
    paddingHorizontal: 44,
  },
  container: { 
    alignItems: 'center',
  },

  // Logo Block - Reduced & Premium
  logoBlock: { 
    alignItems: 'center', 
    marginBottom: SH * 0.1,
  },
  logoContainer: {
    width: 88,
    height: 88,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  logoGlowOuter: {
    position: 'absolute',
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: C.goldGlow,
    ...Platform.select({
      ios: {
        shadowColor: C.gold,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.2,
        shadowRadius: 24,
      },
      android: {},
      default: {},
    }),
  },
  logo: { 
    width: 80, 
    height: 80,
  },
  tagline: { 
    fontFamily: 'Manrope_500Medium', 
    fontSize: 16, 
    color: C.white,
    letterSpacing: 0.3,
    opacity: 0.92,
  },

  // Input Block - Slim & Elegant
  inputBlock: { 
    width: '100%', 
    marginBottom: 40,
  },
  inputWrapper: {
    width: '100%',
    borderWidth: 0,
    borderColor: 'transparent',
  },
  input: {
    width: '100%',
    fontFamily: 'Outfit_500Medium',
    fontSize: 16,
    color: C.white,
    letterSpacing: 2,
    textAlign: 'center',
    paddingVertical: 18,
    paddingHorizontal: 8,
    backgroundColor: 'transparent',
    borderWidth: 0,
    ...Platform.select({ 
      web: { 
        outlineWidth: 0,
        outlineStyle: 'none',
        borderStyle: 'none',
      } as any, 
      default: {} 
    }),
  },
  inputLineBase: {
    width: '100%',
    height: 1,
    backgroundColor: C.gray700,
  },
  inputLineActive: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 1.5,
    ...Platform.select({
      ios: {
        shadowColor: C.gold,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.5,
        shadowRadius: 4,
      },
      android: { elevation: 1 },
      default: {},
    }),
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 18,
    paddingHorizontal: 4,
  },
  errorStandalone: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 28,
    paddingHorizontal: 4,
    maxWidth: '100%',
  },
  errorText: {
    flex: 1,
    fontFamily: 'Manrope_500Medium',
    fontSize: 13,
    color: C.red,
    lineHeight: 18,
  },

  // Context Actions
  contextBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.goldGlowMedium,
    backgroundColor: C.goldGlow,
    marginBottom: 18,
  },
  contextBtnText: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 13,
    color: C.gold,
    letterSpacing: 0.2,
  },

  // Premium Button - Slimmer & Modern
  btnOuter: {
    width: '100%',
    marginBottom: 28,
  },
  btnTouch: {
    width: '100%',
  },
  btn: {
    width: '100%',
    height: 50,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: C.gold,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.3,
        shadowRadius: 14,
      },
      android: { elevation: 6 },
      default: {},
    }),
  },
  btnGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '45%',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  btnText: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 15,
    color: C.bg,
    letterSpacing: 0.5,
  },
  btnDisabled: {
    width: '100%',
    height: 50,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.gray800,
    borderWidth: 1,
    borderColor: C.gray700,
  },
  btnTextDisabled: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 15,
    color: C.gray600,
    letterSpacing: 0.5,
  },

  // Request Access - Cleaner Spacing
  requestBlock: {
    alignItems: 'center',
    marginBottom: 12,
  },
  requestTouch: {
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 24,
  },
  requestLabel: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 14,
    color: C.gray400,
    marginBottom: 6,
  },
  requestAction: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 14,
    color: C.gold,
    letterSpacing: 0.3,
  },

  // Secondary Link
  secondaryLink: {
    paddingVertical: 14,
    paddingHorizontal: 24,
    marginBottom: 12,
  },
  secondaryLinkText: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 14,
    color: C.gray500,
    letterSpacing: 0.3,
  },

  // Footer - Minimal & Refined
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 40,
    paddingTop: 28,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.06)',
    width: '100%',
  },
  footerIconWrap: {
    opacity: 0.7,
  },
  footerText: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 12,
    color: C.gray500,
    letterSpacing: 0.2,
  },
});
