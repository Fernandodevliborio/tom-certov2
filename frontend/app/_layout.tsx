import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import { Stack, SplashScreen } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Updates from 'expo-updates';
import {
  useFonts,
  Outfit_700Bold,
  Outfit_800ExtraBold,
} from '@expo-google-fonts/outfit';
import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
} from '@expo-google-fonts/manrope';
import { AuthProvider, useAuth } from '../src/auth/AuthContext';
import ActivationScreen from '../src/auth/ActivationScreen';
import { MetaPixel } from '../src/utils/metaPixel';

SplashScreen.hideAsync().catch(() => {});

function kickBackgroundOtaCheck() {
  (async () => {
    try {
      if (!Updates.isEnabled) return;
      // @ts-ignore
      if (typeof __DEV__ !== 'undefined' && __DEV__) return;
      const res = await Updates.checkForUpdateAsync();
      if (res?.isAvailable) {
        await Updates.fetchUpdateAsync();
      }
    } catch { /* silencioso */ }
  })();
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  // Painel admin agora é servido como HTML pelo backend em /admin — não há mais rota RN
  if (status !== 'authenticated') return <ActivationScreen />;
  return <>{children}</>;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Outfit_700Bold,
    Outfit_800ExtraBold,
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
  });

  useEffect(() => {
    SplashScreen.hideAsync().catch(() => {});
    const t = setTimeout(kickBackgroundOtaCheck, 1000);
    
    // Track PageView no Meta Pixel ao abrir o app
    MetaPixel.pageView('app_open');
    
    return () => clearTimeout(t);
  }, []);

  if (!fontsLoaded && !fontError) {
    return <View style={ss.bgBlack} />;
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <AuthProvider>
        <AuthGate>
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#000000' } }} />
        </AuthGate>
      </AuthProvider>
    </SafeAreaProvider>
  );
}

const ss = StyleSheet.create({
  bgBlack: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: '#000000', zIndex: -1,
  },
});
