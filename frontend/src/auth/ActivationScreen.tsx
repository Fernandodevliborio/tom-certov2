import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, Animated,
  Dimensions, Easing, KeyboardAvoidingView, Platform, ScrollView,
  Keyboard, ActivityIndicator, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from './AuthContext';

const { height: SH } = Dimensions.get('window');

const C = {
  bg: '#000000',
  amber: '#FFB020',
  amberLight: '#FFC543',
  amberDeep: '#E69A0F',
  amberSoft: '#CFA14A',
  amberSoftDim: 'rgba(207,161,74,0.5)',
  amberDim: 'rgba(255,176,32,0.35)',
  amberGlow: 'rgba(255,176,32,0.55)',
  white: '#FFFFFF',
  text2: '#A0A0A0',
  text3: '#555555',
  text4: '#3A3A3A',
  red: '#EF4444',
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

  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(24)).current;
  const logoScale = useRef(new Animated.Value(0.92)).current;
  const logoGlow = useRef(new Animated.Value(0.78)).current;
  const errorShake = useRef(new Animated.Value(0)).current;
  const underlineScale = useRef(new Animated.Value(0.6)).current;
  const ctaScale = useRef(new Animated.Value(1)).current;
  const waLinkScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 650, useNativeDriver: true }),
      Animated.timing(slide, { toValue: 0, duration: 650, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.spring(logoScale, { toValue: 1, tension: 40, friction: 8, useNativeDriver: true }),
    ]).start();

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(logoGlow, { toValue: 1, duration: 2200, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(logoGlow, { toValue: 0.78, duration: 2200, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  useEffect(() => {
    Animated.timing(underlineScale, {
      toValue: focused || code.length > 0 ? 1 : 0.6,
      duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true,
    }).start();
  }, [focused, code]);

  useEffect(() => {
    if (errorMessage) {
      Animated.sequence([
        Animated.timing(errorShake, { toValue: 10, duration: 50, useNativeDriver: true }),
        Animated.timing(errorShake, { toValue: -10, duration: 50, useNativeDriver: true }),
        Animated.timing(errorShake, { toValue: 6, duration: 50, useNativeDriver: true }),
        Animated.timing(errorShake, { toValue: -6, duration: 50, useNativeDriver: true }),
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

  const ctaPressIn = () => Animated.spring(ctaScale, { toValue: 0.96, useNativeDriver: true }).start();
  const ctaPressOut = () => Animated.spring(ctaScale, { toValue: 1, friction: 4, tension: 120, useNativeDriver: true }).start();

  const waPressIn = () => Animated.spring(waLinkScale, { toValue: 0.97, useNativeDriver: true }).start();
  const waPressOut = () => Animated.spring(waLinkScale, { toValue: 1, friction: 4, useNativeDriver: true }).start();

  const openWhatsApp = async () => {
    try { await Linking.openURL(WHATSAPP_URL); } catch { /* */ }
  };

  const canSubmit = showInput ? (!busy && code.trim().length > 0) : !busy;

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
          <Animated.View style={[ss.container, { opacity: fade, transform: [{ translateY: slide }] }]}>

            {/* Brand block */}
            <Animated.View style={[ss.brandBlock, { transform: [{ scale: logoScale }] }]}>
              <Animated.View style={[ss.logoCircle, { opacity: logoGlow }]}>
                <Text style={ss.logoEmoji}>🎵</Text>
              </Animated.View>
              <Text style={ss.appName}>Tom Certo</Text>
              <Text style={ss.tagline}>DETECTOR DE TONALIDADE</Text>
            </Animated.View>

            {/* Input block */}
            {showInput && (
              <Animated.View style={[ss.inputBlock, { transform: [{ translateX: errorShake }] }]}>
                <Text style={ss.inputLabel}>TOKEN DE ACESSO</Text>
                <TextInput
                  testID="token-input"
                  style={ss.input}
                  value={code}
                  onChangeText={onChangeCode}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  onSubmitEditing={onSubmit}
                  placeholder="Digite seu token de acesso"
                  placeholderTextColor={C.text3}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={24}
                  returnKeyType="done"
                  selectionColor={C.amber}
                  underlineColorAndroid="transparent"
                />
                <View style={ss.underlineBase} />
                <Animated.View style={[ss.underlineActive, { transform: [{ scaleX: underlineScale }], opacity: focused || code.length > 0 ? 1 : 0.45 }]} />
                {errorMessage ? (
                  <View style={ss.errorRow}>
                    <Ionicons name="alert-circle" size={14} color={C.red} />
                    <Text style={ss.errorTxt}>{errorMessage}</Text>
                  </View>
                ) : null}
              </Animated.View>
            )}

            {/* Error standalone (when no input visible) */}
            {!showInput && errorMessage ? (
              <Animated.View style={[ss.errorRowStandalone, { transform: [{ translateX: errorShake }] }]}>
                <Ionicons name="alert-circle" size={14} color={C.red} />
                <Text style={ss.errorTxt}>{errorMessage}</Text>
              </Animated.View>
            ) : null}

            {/* Context action buttons */}
            {(lastReason === 'device_limit' || lastReason === 'device_mismatch') && !showInput ? (
              <TouchableOpacity onPress={onUseAnotherToken} activeOpacity={0.7} style={ss.contextActionBtn}>
                <Ionicons name="refresh-outline" size={14} color={C.amber} />
                <Text style={ss.contextActionTxt}>Limpar e usar outro token</Text>
              </TouchableOpacity>
            ) : null}

            {(lastReason === 'timeout' || lastReason === 'network') ? (
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
                style={ss.contextActionBtn}
              >
                <Ionicons name="wifi-outline" size={14} color={C.amber} />
                <Text style={ss.contextActionTxt}>Tentar conectar novamente</Text>
              </TouchableOpacity>
            ) : null}

            {/* Primary button */}
            <Animated.View style={[ss.primaryBtnWrap, !canSubmit && ss.primaryBtnDisabled, { transform: [{ scale: ctaScale }] }]}>
              <TouchableOpacity
                testID="activate-btn"
                onPress={onSubmit}
                onPressIn={ctaPressIn}
                onPressOut={ctaPressOut}
                disabled={!canSubmit}
                activeOpacity={1}
              >
                <LinearGradient
                  colors={canSubmit ? [C.amberLight, C.amber, C.amberDeep] : ['#3A3A3A', '#2A2A2A', '#1A1A1A']}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                  style={ss.primaryBtn}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color={canSubmit ? C.bg : C.text3} />
                  ) : (
                    <Text style={[ss.primaryBtnTxt, !canSubmit && { color: C.text3 }]}>
                      Ativar acesso
                    </Text>
                  )}
                </LinearGradient>
              </TouchableOpacity>
            </Animated.View>

            {/* Secondary link */}
            {!showInput ? (
              <TouchableOpacity onPress={onUseAnotherToken} activeOpacity={0.7} style={ss.subtleLink}>
                <Text style={ss.subtleLinkTxt}>Usar outro token</Text>
              </TouchableOpacity>
            ) : (
              <Animated.View style={{ transform: [{ scale: waLinkScale }] }}>
                <TouchableOpacity
                  onPress={openWhatsApp}
                  onPressIn={waPressIn}
                  onPressOut={waPressOut}
                  activeOpacity={0.7}
                  style={ss.waLink}
                >
                  <Text style={ss.waLinkTxt}>
                    {'Não tem token de acesso?\n'}
                    <Text style={ss.waLinkTxtStrong}>Solicitar token de acesso</Text>
                  </Text>
                </TouchableOpacity>
              </Animated.View>
            )}

            {/* Trust message */}
            <View style={ss.trust}>
              <Ionicons name="shield-checkmark-outline" size={12} color={C.text3} />
              <Text style={ss.trustTxt}>Seu acesso é seguro e validado instantaneamente</Text>
            </View>

          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const ss = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingVertical: 40 },
  container: { paddingHorizontal: 32, alignItems: 'center' },

  brandBlock: { alignItems: 'center', marginBottom: SH * 0.06 },
  logoCircle: {
    width: 110, height: 110, borderRadius: 55,
    backgroundColor: 'rgba(255,176,32,0.15)',
    borderWidth: 1.5, borderColor: 'rgba(255,176,32,0.35)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 16,
    ...Platform.select({
      ios: { shadowColor: C.amber, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.5, shadowRadius: 24 },
      android: { elevation: 8 },
      default: {},
    }),
  },
  logoEmoji: { fontSize: 52 },
  appName: { fontFamily: 'Outfit_800ExtraBold', fontSize: 32, color: C.white, letterSpacing: -1, marginBottom: 4 },
  tagline: { fontFamily: 'Manrope_500Medium', fontSize: 11, color: C.text3, letterSpacing: 3.2, textTransform: 'uppercase', marginTop: 2 },

  inputBlock: { width: '100%', alignItems: 'center', marginBottom: 32 },
  inputLabel: { fontFamily: 'Manrope_600SemiBold', fontSize: 10, color: C.amber, letterSpacing: 3, marginBottom: 14 },
  input: {
    width: '100%', fontFamily: 'Outfit_700Bold', fontSize: 20,
    color: C.white, letterSpacing: 2.5, textAlign: 'center',
    paddingVertical: 14, paddingHorizontal: 8,
    ...Platform.select({ web: { outlineWidth: 0 } as any, default: {} }),
  },
  underlineBase: { width: '100%', height: 1, backgroundColor: 'rgba(255,255,255,0.10)' },
  underlineActive: {
    position: 'absolute', bottom: 0, left: 0, right: 0, height: 2,
    backgroundColor: C.amber,
    ...Platform.select({
      ios: { shadowColor: C.amber, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.85, shadowRadius: 8 },
      android: { elevation: 3 },
      default: {},
    }),
  },
  errorRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 14, paddingHorizontal: 4 },
  errorRowStandalone: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 6,
    marginBottom: 24, paddingHorizontal: 4, maxWidth: '90%',
  },
  errorTxt: { flex: 1, fontFamily: 'Manrope_500Medium', fontSize: 12, color: C.red, lineHeight: 16 },

  primaryBtnWrap: {
    width: '100%', borderRadius: 99, overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: C.amber, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.5, shadowRadius: 22 },
      android: { elevation: 10 },
      default: {},
    }),
  },
  primaryBtn: { width: '100%', height: 58, borderRadius: 99, alignItems: 'center', justifyContent: 'center' },
  primaryBtnDisabled: {
    ...Platform.select({ ios: { shadowOpacity: 0 }, android: { elevation: 0 }, default: {} }),
  },
  primaryBtnTxt: { fontFamily: 'Outfit_700Bold', fontSize: 16.5, color: C.bg, letterSpacing: 0.6 },

  waLink: { paddingVertical: 8, paddingHorizontal: 14, alignItems: 'center' },
  waLinkTxt: { fontFamily: 'Manrope_400Regular', fontSize: 13, color: C.text2, textAlign: 'center', letterSpacing: 0.2 },
  waLinkTxtStrong: { fontFamily: 'Manrope_600SemiBold', color: C.amberSoft, textDecorationLine: 'underline', textDecorationColor: C.amberSoftDim },

  subtleLink: { marginTop: 20, paddingVertical: 10, paddingHorizontal: 18, alignItems: 'center' },
  subtleLinkTxt: { fontFamily: 'Manrope_500Medium', fontSize: 12.5, color: C.text3, letterSpacing: 0.5, textDecorationLine: 'underline', textDecorationColor: 'rgba(85,85,85,0.4)' },

  contextActionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center',
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10,
    borderWidth: 1, borderColor: 'rgba(255,176,32,0.35)',
    backgroundColor: 'rgba(255,176,32,0.08)', marginBottom: 14,
  },
  contextActionTxt: { fontFamily: 'Manrope_600SemiBold', fontSize: 12.5, color: C.amber, letterSpacing: 0.2 },

  trust: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 28, paddingHorizontal: 8 },
  trustTxt: { fontFamily: 'Manrope_500Medium', fontSize: 11.5, color: C.text3, letterSpacing: 0.3 },
});
