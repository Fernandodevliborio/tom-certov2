// Authentication context: handles token activation, persistence and revalidation.
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import Constants from 'expo-constants';
import * as storage from './storage';
import { getDeviceId } from './deviceId';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface SessionInfo {
  session: string;
  token_id: string;
  expires_at?: string | null;
  customer_name?: string | null;
  duration_minutes?: number | null;
}

export interface AuthContextValue {
  status: AuthStatus;
  session: SessionInfo | null;
  errorMessage: string | null;
  lastReason: string | null;
  hasSavedToken: boolean;
  activate: (code?: string) => Promise<{ ok: boolean; reason?: string | null }>;
  logout: () => Promise<void>;
  forgetDevice: () => Promise<void>;
  clearError: () => void;
  retryRevalidate: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const SESSION_KEY = 'tc_session_v1';
const TOKEN_KEY = 'tc_token_v1';

const PROD_BACKEND_URL = 'https://tom-certo-v2.preview.emergentagent.com';

function getBackendUrl(): string {
  const url =
    (process.env.EXPO_PUBLIC_BACKEND_URL as string | undefined) ||
    (Constants.expoConfig?.extra as any)?.backendUrl ||
    PROD_BACKEND_URL;
  return (url || '').replace(/\/+$/g, '');
}

function reasonToMessage(reason?: string | null): string {
  switch (reason) {
    case 'not_found': return 'Token inválido. Verifique o código e tente novamente.';
    case 'revoked': return 'Token revogado. Entre em contato com o suporte.';
    case 'expired': return 'Token expirado. Solicite um novo acesso.';
    case 'device_limit': return 'Limite de dispositivos atingido. Peça ao suporte para liberar seu dispositivo.';
    case 'session_expired':
    case 'session_invalid': return 'Sessão expirada. Ative novamente com seu token.';
    case 'device_mismatch': return 'Este dispositivo não está autorizado neste token.';
    case 'timeout': return 'Tempo esgotado. Verifique sua internet e tente novamente.';
    case 'network': return 'Não foi possível conectar ao servidor. Verifique sua conexão.';
    case 'no_backend': return 'Servidor não configurado. Reinstale o app ou contate o suporte.';
    default: return 'Falha ao validar token. Tente novamente em instantes.';
  }
}

export function isPermanentFailure(reason?: string | null): boolean {
  return reason === 'not_found' || reason === 'revoked' || reason === 'expired';
}

export function isDeviceBlockingFailure(reason?: string | null): boolean {
  return reason === 'device_limit' || reason === 'device_mismatch';
}

export function isTransientFailure(reason?: string | null): boolean {
  return reason === 'timeout' || reason === 'network' || reason === 'no_backend';
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('unauthenticated');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastReason, setLastReason] = useState<string | null>(null);
  const [hasSavedToken, setHasSavedToken] = useState(false);
  const boot = useRef(false);

  const loadAndRevalidate = async () => {
    try {
      const savedToken = await storage.getItem(TOKEN_KEY);
      setHasSavedToken(!!savedToken);

      const raw = await storage.getItem(SESSION_KEY);
      if (!raw) return;

      const parsed: SessionInfo = JSON.parse(raw);
      const deviceId = await getDeviceId();
      const base = getBackendUrl();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      let res: Response;
      try {
        res = await fetch(`${base}/api/auth/revalidate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: parsed.session, device_id: deviceId }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      const data = await res.json().catch(() => ({}));

      if (res.ok && data?.valid) {
        setSession({
          ...parsed,
          expires_at: data.expires_at ?? parsed.expires_at,
          customer_name: data.customer_name ?? parsed.customer_name,
          duration_minutes: data.duration_minutes ?? parsed.duration_minutes,
        });
        setStatus('authenticated');
      } else {
        const r = data?.reason;
        if (r === 'not_found' || r === 'revoked' || r === 'expired') {
          await storage.removeItem(SESSION_KEY);
          setSession(null);
          setErrorMessage(reasonToMessage(r));
          setLastReason(r);
        } else if (r === 'session_invalid' || r === 'session_expired') {
          await storage.removeItem(SESSION_KEY);
          setSession(null);
        } else {
          setSession(null);
        }
      }
    } catch (err: any) {
      console.warn('[Auth] Revalidate falhou:', err?.name === 'AbortError' ? 'timeout' : String(err?.message || err));
    }
  };

  useEffect(() => {
    if (boot.current) return;
    boot.current = true;
    loadAndRevalidate();
  }, []);

  const activate = async (code?: string) => {
    setErrorMessage(null);

    let clean: string;
    if (code === undefined || code === null || !code.trim()) {
      const saved = await storage.getItem(TOKEN_KEY);
      if (!saved) {
        setErrorMessage('Digite o código do token');
        return { ok: false, reason: 'empty' };
      }
      clean = saved;
    } else {
      clean = code.trim().toUpperCase();
    }

    const base = getBackendUrl();
    if (!base) {
      setErrorMessage('Não foi possível conectar ao servidor.');
      return { ok: false, reason: 'no_backend' };
    }

    try {
      const deviceId = await getDeviceId();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const res = await fetch(`${base}/api/auth/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: clean, device_id: deviceId }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data?.valid) {
        const reason = data?.reason || 'unknown';
        setErrorMessage(reasonToMessage(reason));
        setLastReason(reason);
        if (reason === 'not_found' || reason === 'revoked' || reason === 'expired') {
          await storage.removeItem(TOKEN_KEY);
          await storage.removeItem(SESSION_KEY);
          setHasSavedToken(false);
        }
        return { ok: false, reason };
      }

      const s: SessionInfo = {
        session: data.session,
        token_id: data.token_id,
        expires_at: data.expires_at,
        customer_name: data.customer_name,
        duration_minutes: data.duration_minutes,
      };
      await storage.setItem(SESSION_KEY, JSON.stringify(s));
      await storage.setItem(TOKEN_KEY, clean);
      setHasSavedToken(true);
      setSession(s);
      setStatus('authenticated');
      return { ok: true };
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError';
      const reason = isAbort ? 'timeout' : 'network';
      setErrorMessage(reasonToMessage(reason));
      setLastReason(reason);
      return { ok: false, reason };
    }
  };

  const logout = async () => {
    await storage.removeItem(SESSION_KEY);
    setSession(null);
    setErrorMessage(null);
    setLastReason(null);
    setStatus('unauthenticated');
  };

  const forgetDevice = async () => {
    await storage.removeItem(SESSION_KEY);
    await storage.removeItem(TOKEN_KEY);
    setSession(null);
    setHasSavedToken(false);
    setErrorMessage(null);
    setLastReason(null);
    setStatus('unauthenticated');
  };

  const clearError = () => {
    setErrorMessage(null);
    setLastReason(null);
  };

  const retryRevalidate = async () => {
    setErrorMessage(null);
    setLastReason(null);
    await loadAndRevalidate();
  };

  const value: AuthContextValue = {
    status, session, errorMessage, lastReason, hasSavedToken,
    activate, logout, forgetDevice, clearError, retryRevalidate,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
