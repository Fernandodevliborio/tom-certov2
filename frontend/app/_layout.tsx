import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import { Stack, SplashScreen } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Updates from 'expo-updates';
import {
  useFonts,
  Poppins_400Regular,
  Poppins_500Medium,
  Poppins_600SemiBold,
  Poppins_700Bold,
} from '@expo-google-fonts/poppins';
import { AuthProvider, useAuth } from '../src/auth/AuthContext';
import ActivationScreen from '../src/auth/ActivationScreen';

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
  if (status !== 'authenticated') return <ActivationScreen />;
  return <>{children}</>;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Poppins_400Regular,
    Poppins_500Medium,
    Poppins_600SemiBold,
    Poppins_700Bold,
  });

  useEffect(() => {
    SplashScreen.hideAsync().catch(() => {});
    const t = setTimeout(kickBackgroundOtaCheck, 1000);
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
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0A0A0A' } }} />
        </AuthGate>
      </AuthProvider>
    </SafeAreaProvider>
  );
}

const ss = StyleSheet.create({
  bgBlack: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: '#0A0A0A', zIndex: -1,
  },
});
