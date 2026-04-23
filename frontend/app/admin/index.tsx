import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput,
  Modal, ActivityIndicator, Alert, Platform, Switch, RefreshControl,
  KeyboardAvoidingView, Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';

// ─── API ───────────────────────────────────────────────────────────────
const BASE_URL = (
  (process.env.EXPO_PUBLIC_BACKEND_URL as string | undefined) ||
  (Constants.expoConfig?.extra as any)?.backendUrl ||
  'https://tom-certo-v2.preview.emergentagent.com'
).replace(/\/+$/, '');

const STORAGE_KEY = 'tc_admin_key_v1';

async function apiFetch(
  path: string,
  adminKey: string,
  method = 'GET',
  body?: object
) {
  const opts: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Key': adminKey,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.detail || data?.message || `HTTP ${res.status}`);
  return data;
}

// ─── Types ─────────────────────────────────────────────────────────────
interface TokenDoc {
  _id: string;
  code: string;
  customer_name?: string | null;
  device_limit: number;
  active_devices: string[];
  active: boolean;
  created_at?: string;
  expires_at?: string | null;
  last_used_at?: string | null;
  duration_minutes?: number | null;
  notes?: string | null;
}

// ─── Colors ─────────────────────────────────────────────────────────────
const C = {
  bg: '#0A0A0A', surface: '#111111', surface2: '#181818', surface3: '#1E1E1E',
  border: '#222222', borderStrong: '#333333',
  amber: '#FFB020', amberMuted: 'rgba(255,176,32,0.12)', amberBorder: 'rgba(255,176,32,0.30)',
  white: '#FFFFFF', text2: '#A0A0A0', text3: '#555555',
  green: '#22C55E', greenMuted: 'rgba(34,197,94,0.12)', greenBorder: 'rgba(34,197,94,0.30)',
  red: '#EF4444', redMuted: 'rgba(239,68,68,0.12)', redBorder: 'rgba(239,68,68,0.30)',
  blue: '#60A5FA', blueMuted: 'rgba(96,165,250,0.12)', blueBorder: 'rgba(96,165,250,0.30)',
};

// ═══════════════════════════════════════════════════════════════════════
// ROOT
// ═══════════════════════════════════════════════════════════════════════
export default function AdminPanel() {
  const [adminKey, setAdminKey] = useState('');
  const [authed, setAuthed] = useState(false);

  // Auto-load saved key
  useEffect(() => {
    try {
      if (Platform.OS === 'web') {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        if (saved) { setAdminKey(saved); }
      }
    } catch { /* */ }
  }, []);

  const onLogin = (key: string) => {
    try {
      if (Platform.OS === 'web') window.localStorage.setItem(STORAGE_KEY, key);
    } catch { /* */ }
    setAdminKey(key);
    setAuthed(true);
  };

  const onLogout = () => {
    setAuthed(false);
    try { if (Platform.OS === 'web') window.localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
  };

  if (!authed) return <LoginScreen onLogin={onLogin} />;
  return <Dashboard adminKey={adminKey} onLogout={onLogout} />;
}

// ═══════════════════════════════════════════════════════════════════════
// LOGIN SCREEN
// ═══════════════════════════════════════════════════════════════════════
function LoginScreen({ onLogin }: { onLogin: (key: string) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fadeIn = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeIn, { toValue: 1, duration: 500, useNativeDriver: true }).start();
  }, []);

  const onSubmit = async () => {
    if (!key.trim()) { setError('Digite a chave de acesso'); return; }
    setBusy(true); setError('');
    try {
      await apiFetch('/api/admin/stats', key.trim());
      onLogin(key.trim());
    } catch {
      setError('Chave inválida ou servidor inacessível');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={ss.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <Animated.View style={[ss.loginWrap, { opacity: fadeIn }]}>
          <View style={ss.loginIcon}>
            <Ionicons name="shield-checkmark" size={48} color={C.amber} />
          </View>
          <Text style={ss.loginTitle}>Tom Certo Admin</Text>
          <Text style={ss.loginSub}>PAINEL DE GESTÃO DE TOKENS</Text>

          <View style={ss.inputWrap}>
            <Text style={ss.inputLabel}>CHAVE DE ACESSO ADMIN</Text>
            <TextInput
              testID="admin-key-input"
              style={ss.textInput}
              value={key}
              onChangeText={t => { setKey(t); setError(''); }}
              placeholder="Digite sua chave admin"
              placeholderTextColor={C.text3}
              secureTextEntry
              autoCorrect={false}
              onSubmitEditing={onSubmit}
              returnKeyType="done"
              selectionColor={C.amber}
              underlineColorAndroid="transparent"
            />
          </View>

          {error ? (
            <View style={ss.errorRow}>
              <Ionicons name="alert-circle" size={14} color={C.red} />
              <Text style={ss.errorTxt}>{error}</Text>
            </View>
          ) : null}

          <TouchableOpacity testID="admin-login-btn" style={ss.primaryBtn} onPress={onSubmit} disabled={busy} activeOpacity={0.85}>
            {busy ? <ActivityIndicator color={C.bg} /> : <Text style={ss.primaryBtnTxt}>Entrar no Painel</Text>}
          </TouchableOpacity>
        </Animated.View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════
function Dashboard({ adminKey, onLogout }: { adminKey: string; onLogout: () => void }) {
  const [tokens, setTokens] = useState<TokenDoc[]>([]);
  const [stats, setStats] = useState({ total: 0, active: 0, revoked: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [selectedToken, setSelectedToken] = useState<TokenDoc | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    else setRefreshing(true);
    try {
      const [tokensRes, statsRes] = await Promise.all([
        apiFetch('/api/admin/tokens', adminKey),
        apiFetch('/api/admin/stats', adminKey),
      ]);
      setTokens(tokensRes.tokens || []);
      setStats(statsRes);
    } catch (e: any) {
      Alert.alert('Erro', e?.message || 'Falha ao carregar dados');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [adminKey]);

  useEffect(() => { load(); }, [load]);

  const filtered = tokens.filter(t => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      t.code.toLowerCase().includes(q) ||
      (t.customer_name || '').toLowerCase().includes(q) ||
      (t.notes || '').toLowerCase().includes(q)
    );
  });

  const onToggleActive = async (t: TokenDoc) => {
    try {
      await apiFetch(`/api/admin/tokens/${t._id}`, adminKey, 'PATCH', { active: !t.active });
      setTokens(prev => prev.map(x => x._id === t._id ? { ...x, active: !t.active } : x));
    } catch (e: any) { Alert.alert('Erro', e?.message); }
  };

  const onClearDevices = async (t: TokenDoc) => {
    Alert.alert(
      'Limpar dispositivos',
      `Isso removerá ${t.active_devices.length} dispositivo(s) de "${t.code}". Confirmar?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Limpar', style: 'destructive', onPress: async () => {
            try {
              await apiFetch(`/api/admin/tokens/${t._id}/clear-devices`, adminKey, 'POST');
              setTokens(prev => prev.map(x => x._id === t._id ? { ...x, active_devices: [] } : x));
            } catch (e: any) { Alert.alert('Erro', e?.message); }
          }
        }
      ]
    );
  };

  const onDelete = async (t: TokenDoc) => {
    Alert.alert(
      'Excluir token',
      `Excluir "${t.code}" permanentemente?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Excluir', style: 'destructive', onPress: async () => {
            try {
              await apiFetch(`/api/admin/tokens/${t._id}`, adminKey, 'DELETE');
              setTokens(prev => prev.filter(x => x._id !== t._id));
            } catch (e: any) { Alert.alert('Erro', e?.message); }
          }
        }
      ]
    );
  };

  return (
    <SafeAreaView style={ss.safe}>
      {/* Header */}
      <View style={ss.header}>
        <View style={ss.headerLeft}>
          <Ionicons name="musical-notes" size={22} color={C.amber} />
          <Text style={ss.headerTitle}>Tom Certo Admin</Text>
        </View>
        <TouchableOpacity testID="admin-logout-btn" onPress={onLogout} style={ss.headerBtn}>
          <Ionicons name="log-out-outline" size={16} color={C.text2} />
          <Text style={ss.headerBtnTxt}>Sair</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={ss.center}>
          <ActivityIndicator size="large" color={C.amber} />
          <Text style={[ss.text2, { marginTop: 12 }]}>Carregando...</Text>
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.amber} />}
          contentContainerStyle={ss.scrollContent}
        >
          {/* Stats Row */}
          <View style={ss.statsRow}>
            <StatCard label="TOTAL" value={stats.total} icon="key-outline" color={C.amber} />
            <StatCard label="ATIVOS" value={stats.active} icon="checkmark-circle-outline" color={C.green} />
            <StatCard label="REVOGADOS" value={stats.revoked} icon="ban-outline" color={C.red} />
          </View>

          {/* Toolbar */}
          <View style={ss.toolbar}>
            <View style={ss.searchWrap}>
              <Ionicons name="search-outline" size={15} color={C.text3} style={{ marginRight: 6 }} />
              <TextInput
                testID="admin-search"
                style={ss.searchInput}
                value={search}
                onChangeText={setSearch}
                placeholder="Buscar token ou cliente..."
                placeholderTextColor={C.text3}
                selectionColor={C.amber}
                underlineColorAndroid="transparent"
              />
              {search.length > 0 && (
                <TouchableOpacity onPress={() => setSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close-circle" size={15} color={C.text3} />
                </TouchableOpacity>
              )}
            </View>
            <TouchableOpacity testID="create-token-btn" style={ss.createBtn} onPress={() => setShowCreate(true)} activeOpacity={0.85}>
              <Ionicons name="add" size={17} color={C.bg} />
              <Text style={ss.createBtnTxt}>Novo Token</Text>
            </TouchableOpacity>
          </View>

          {/* Token List */}
          {filtered.length === 0 ? (
            <View style={ss.empty}>
              <Ionicons name="key-outline" size={40} color={C.text3} />
              <Text style={ss.emptyTxt}>
                {search ? 'Nenhum token encontrado' : 'Nenhum token cadastrado'}
              </Text>
            </View>
          ) : (
            filtered.map(t => (
              <TokenCard
                key={t._id}
                token={t}
                onToggleActive={onToggleActive}
                onClearDevices={onClearDevices}
                onDelete={onDelete}
                onEdit={() => setSelectedToken(t)}
              />
            ))
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      <CreateTokenModal
        visible={showCreate}
        adminKey={adminKey}
        onClose={() => setShowCreate(false)}
        onCreated={(t) => { setTokens(prev => [t, ...prev]); setShowCreate(false); load(true); }}
      />

      <EditTokenModal
        visible={!!selectedToken}
        token={selectedToken}
        adminKey={adminKey}
        onClose={() => setSelectedToken(null)}
        onSaved={(updated) => {
          setTokens(prev => prev.map(x => x._id === updated._id ? updated : x));
          setSelectedToken(null);
        }}
      />
    </SafeAreaView>
  );
}

// ─── StatCard ────────────────────────────────────────────────────────────
function StatCard({ label, value, icon, color }: { label: string; value: number; icon: any; color: string }) {
  return (
    <View style={[ss.statCard, { borderColor: `${color}33` }]}>
      <Ionicons name={icon} size={20} color={color} />
      <Text style={[ss.statValue, { color }]}>{value}</Text>
      <Text style={ss.statLabel}>{label}</Text>
    </View>
  );
}

// ─── TokenCard ────────────────────────────────────────────────────────────
function TokenCard({ token: t, onToggleActive, onClearDevices, onDelete, onEdit }: {
  token: TokenDoc;
  onToggleActive: (t: TokenDoc) => void;
  onClearDevices: (t: TokenDoc) => void;
  onDelete: (t: TokenDoc) => void;
  onEdit: (t: TokenDoc) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const deviceCount = t.active_devices.length;
  const isAtLimit = deviceCount >= t.device_limit;
  const pct = t.device_limit > 0 ? deviceCount / t.device_limit : 0;

  const statusColor = !t.active ? C.red : isAtLimit ? C.amber : C.green;
  const statusLabel = !t.active ? 'Revogado' : isAtLimit ? 'Limite atingido' : 'Ativo';

  return (
    <TouchableOpacity
      testID={`token-card-${t.code}`}
      style={[ss.tokenCard, !t.active && ss.tokenCardRevoked]}
      onPress={() => setExpanded(e => !e)}
      activeOpacity={0.85}
    >
      {/* Header Row */}
      <View style={ss.tokenCardTop}>
        <View style={{ flex: 1 }}>
          <View style={ss.tokenCodeRow}>
            <Text style={ss.tokenCode}>{t.code}</Text>
            <View style={[ss.statusBadge, { borderColor: `${statusColor}55`, backgroundColor: `${statusColor}18` }]}>
              <View style={[ss.statusDot, { backgroundColor: statusColor }]} />
              <Text style={[ss.statusTxt, { color: statusColor }]}>{statusLabel}</Text>
            </View>
          </View>
          {t.customer_name ? <Text style={ss.customerName}>{t.customer_name}</Text> : null}
        </View>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={C.text3} />
      </View>

      {/* Device Bar */}
      <View style={ss.deviceBarRow}>
        <Text style={ss.deviceBarTxt}>{deviceCount}/{t.device_limit} dispositivos</Text>
        <View style={ss.deviceBarBg}>
          <View style={[ss.deviceBarFill, {
            width: `${Math.min(100, pct * 100)}%` as any,
            backgroundColor: isAtLimit ? C.amber : C.green,
          }]} />
        </View>
      </View>

      {/* Expanded */}
      {expanded && (
        <View style={ss.expandedSection}>
          {t.notes ? (
            <View style={ss.infoRow}>
              <Ionicons name="document-text-outline" size={13} color={C.text3} />
              <Text style={ss.infoTxt}>{t.notes}</Text>
            </View>
          ) : null}
          {t.expires_at ? (
            <View style={ss.infoRow}>
              <Ionicons name="time-outline" size={13} color={C.text3} />
              <Text style={ss.infoTxt}>Expira: {new Date(t.expires_at).toLocaleDateString('pt-BR')}</Text>
            </View>
          ) : null}
          {t.last_used_at ? (
            <View style={ss.infoRow}>
              <Ionicons name="pulse-outline" size={13} color={C.text3} />
              <Text style={ss.infoTxt}>Último uso: {new Date(t.last_used_at).toLocaleDateString('pt-BR')}</Text>
            </View>
          ) : null}

          {/* Action Buttons */}
          <View style={ss.actionRow}>
            <TouchableOpacity
              testID={`toggle-${t.code}`}
              style={[ss.actionBtn, t.active ? ss.actionBtnDanger : ss.actionBtnSuccess]}
              onPress={() => onToggleActive(t)}
              activeOpacity={0.8}
            >
              <Ionicons name={t.active ? 'ban-outline' : 'checkmark-circle-outline'} size={14}
                color={t.active ? C.red : C.green} />
              <Text style={[ss.actionBtnTxt, { color: t.active ? C.red : C.green }]}>
                {t.active ? 'Revogar' : 'Ativar'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              testID={`clear-${t.code}`}
              style={[ss.actionBtn, ss.actionBtnAmber]}
              onPress={() => onClearDevices(t)}
              activeOpacity={0.8}
            >
              <Ionicons name="phone-portrait-outline" size={14} color={C.amber} />
              <Text style={[ss.actionBtnTxt, { color: C.amber }]}>Limpar devices</Text>
            </TouchableOpacity>

            <TouchableOpacity
              testID={`edit-${t.code}`}
              style={[ss.actionBtn, ss.actionBtnBlue]}
              onPress={() => onEdit(t)}
              activeOpacity={0.8}
            >
              <Ionicons name="create-outline" size={14} color={C.blue} />
              <Text style={[ss.actionBtnTxt, { color: C.blue }]}>Editar</Text>
            </TouchableOpacity>

            <TouchableOpacity
              testID={`delete-${t.code}`}
              style={[ss.actionBtn, ss.actionBtnDanger]}
              onPress={() => onDelete(t)}
              activeOpacity={0.8}
            >
              <Ionicons name="trash-outline" size={14} color={C.red} />
              <Text style={[ss.actionBtnTxt, { color: C.red }]}>Excluir</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </TouchableOpacity>
  );
}

// ─── CreateTokenModal ───────────────────────────────────────────────────
function CreateTokenModal({ visible, adminKey, onClose, onCreated }: {
  visible: boolean; adminKey: string;
  onClose: () => void; onCreated: (t: TokenDoc) => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [limit, setLimit] = useState('3');
  const [notes, setNotes] = useState('');
  const [durDays, setDurDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const reset = () => { setCode(''); setName(''); setLimit('3'); setNotes(''); setDurDays(''); setError(''); };
  const onCancel = () => { reset(); onClose(); };

  const onSave = async () => {
    if (!code.trim()) { setError('O código do token é obrigatório'); return; }
    setBusy(true); setError('');
    try {
      const body: any = {
        code: code.trim().toUpperCase(),
        customer_name: name.trim() || null,
        device_limit: parseInt(limit) || 3,
        notes: notes.trim() || null,
      };
      if (durDays.trim()) {
        body.duration_minutes = parseInt(durDays) * 24 * 60;
      }
      const res = await apiFetch('/api/admin/tokens', adminKey, 'POST', body);
      // Re-fetch the token to get full doc
      const listRes = await apiFetch('/api/admin/tokens', adminKey);
      const newToken = listRes.tokens?.find((t: TokenDoc) => t._id === res.token_id);
      onCreated(newToken || { _id: res.token_id, code: body.code, active: true, device_limit: body.device_limit, active_devices: [] });
      reset();
    } catch (e: any) {
      setError(e?.message || 'Falha ao criar token');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={ss.modalBg}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ width: '100%', maxWidth: 500, alignSelf: 'center' }}>
          <View style={ss.modalCard}>
            <View style={ss.modalHeader}>
              <Text style={ss.modalTitle}>Novo Token</Text>
              <TouchableOpacity onPress={onCancel} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close" size={22} color={C.text2} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <FormField label="CÓDIGO*" placeholder="ex: ALUNO-001" value={code}
                onChangeText={t => setCode(t.toUpperCase())} autoCapitalize="characters" />
              <FormField label="NOME DO CLIENTE" placeholder="ex: João Silva" value={name}
                onChangeText={setName} />
              <FormField label="LIMITE DE DISPOSITIVOS" placeholder="3" value={limit}
                onChangeText={setLimit} keyboardType="number-pad" />
              <FormField label="VALIDADE (dias) — vazio = sem expiração" placeholder="ex: 30"
                value={durDays} onChangeText={setDurDays} keyboardType="number-pad" />
              <FormField label="OBSERVAÇÕES" placeholder="Opcional..." value={notes}
                onChangeText={setNotes} multiline />

              {error ? (
                <View style={[ss.errorRow, { marginBottom: 12 }]}>
                  <Ionicons name="alert-circle" size={14} color={C.red} />
                  <Text style={ss.errorTxt}>{error}</Text>
                </View>
              ) : null}

              <TouchableOpacity testID="save-token-btn" style={ss.primaryBtn} onPress={onSave} disabled={busy} activeOpacity={0.85}>
                {busy ? <ActivityIndicator color={C.bg} /> : <Text style={ss.primaryBtnTxt}>Criar Token</Text>}
              </TouchableOpacity>
              <View style={{ height: 20 }} />
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

// ─── EditTokenModal ──────────────────────────────────────────────────────
function EditTokenModal({ visible, token, adminKey, onClose, onSaved }: {
  visible: boolean; token: TokenDoc | null; adminKey: string;
  onClose: () => void; onSaved: (t: TokenDoc) => void;
}) {
  const [name, setName] = useState('');
  const [limit, setLimit] = useState('3');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (token) {
      setName(token.customer_name || '');
      setLimit(String(token.device_limit));
      setNotes(token.notes || '');
      setError('');
    }
  }, [token]);

  if (!token) return null;

  const onSave = async () => {
    setBusy(true); setError('');
    try {
      const body: any = {
        customer_name: name.trim() || null,
        device_limit: parseInt(limit) || token.device_limit,
        notes: notes.trim() || null,
      };
      await apiFetch(`/api/admin/tokens/${token._id}`, adminKey, 'PATCH', body);
      onSaved({ ...token, ...body });
    } catch (e: any) {
      setError(e?.message || 'Falha ao salvar');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={ss.modalBg}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ width: '100%', maxWidth: 500, alignSelf: 'center' }}>
          <View style={ss.modalCard}>
            <View style={ss.modalHeader}>
              <Text style={ss.modalTitle}>Editar {token.code}</Text>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="close" size={22} color={C.text2} />
              </TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <FormField label="NOME DO CLIENTE" placeholder="ex: João Silva" value={name} onChangeText={setName} />
              <FormField label="LIMITE DE DISPOSITIVOS" placeholder="3" value={limit} onChangeText={setLimit} keyboardType="number-pad" />
              <FormField label="OBSERVAÇÕES" placeholder="Opcional..." value={notes} onChangeText={setNotes} multiline />

              {error ? (
                <View style={[ss.errorRow, { marginBottom: 12 }]}>
                  <Ionicons name="alert-circle" size={14} color={C.red} />
                  <Text style={ss.errorTxt}>{error}</Text>
                </View>
              ) : null}

              <TouchableOpacity testID="save-edit-btn" style={ss.primaryBtn} onPress={onSave} disabled={busy} activeOpacity={0.85}>
                {busy ? <ActivityIndicator color={C.bg} /> : <Text style={ss.primaryBtnTxt}>Salvar alterações</Text>}
              </TouchableOpacity>
              <View style={{ height: 20 }} />
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

// ─── FormField ───────────────────────────────────────────────────────────
function FormField({ label, placeholder, value, onChangeText, keyboardType, autoCapitalize, multiline }: {
  label: string; placeholder: string; value: string;
  onChangeText: (t: string) => void;
  keyboardType?: any; autoCapitalize?: any; multiline?: boolean;
}) {
  return (
    <View style={ss.formField}>
      <Text style={ss.inputLabel}>{label}</Text>
      <TextInput
        style={[ss.textInput, multiline && { height: 72, textAlignVertical: 'top' }]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={C.text3}
        keyboardType={keyboardType || 'default'}
        autoCapitalize={autoCapitalize || 'sentences'}
        autoCorrect={false}
        multiline={multiline}
        selectionColor={C.amber}
        underlineColorAndroid="transparent"
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────
const ss = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // Login
  loginWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, maxWidth: 480, alignSelf: 'center', width: '100%' },
  loginIcon: { width: 100, height: 100, borderRadius: 50, backgroundColor: C.amberMuted, borderWidth: 1.5, borderColor: C.amberBorder, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  loginTitle: { fontFamily: 'Outfit_800ExtraBold', fontSize: 26, color: C.white, letterSpacing: -0.8, marginBottom: 4 },
  loginSub: { fontFamily: 'Manrope_500Medium', fontSize: 10, color: C.text3, letterSpacing: 3, marginBottom: 36 },

  // Header
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: { fontFamily: 'Outfit_700Bold', fontSize: 17, color: C.white, letterSpacing: -0.4 },
  headerBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, backgroundColor: C.surface2, borderWidth: 1, borderColor: C.border },
  headerBtnTxt: { fontFamily: 'Manrope_500Medium', fontSize: 12, color: C.text2 },

  // Scroll
  scrollContent: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 32, gap: 12 },

  // Stats
  statsRow: { flexDirection: 'row', gap: 10 },
  statCard: { flex: 1, backgroundColor: C.surface, borderRadius: 14, borderWidth: 1, padding: 14, alignItems: 'center', gap: 4 },
  statValue: { fontFamily: 'Outfit_800ExtraBold', fontSize: 26, letterSpacing: -1 },
  statLabel: { fontFamily: 'Manrope_600SemiBold', fontSize: 9.5, color: C.text3, letterSpacing: 2 },

  // Toolbar
  toolbar: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  searchWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: C.surface2, borderWidth: 1, borderColor: C.border, borderRadius: 12, paddingHorizontal: 12, height: 44 },
  searchInput: { flex: 1, fontFamily: 'Manrope_400Regular', fontSize: 14, color: C.white, ...Platform.select({ web: { outlineWidth: 0 } as any, default: {} }) },
  createBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 44, paddingHorizontal: 14, borderRadius: 12, backgroundColor: C.amber },
  createBtnTxt: { fontFamily: 'Manrope_600SemiBold', fontSize: 13, color: C.bg },

  // Empty
  empty: { alignItems: 'center', paddingVertical: 48, gap: 10 },
  emptyTxt: { fontFamily: 'Manrope_400Regular', fontSize: 14, color: C.text3 },

  // Token Card
  tokenCard: { backgroundColor: C.surface, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 14, gap: 10 },
  tokenCardRevoked: { borderColor: C.redBorder, opacity: 0.7 },
  tokenCardTop: { flexDirection: 'row', alignItems: 'flex-start' },
  tokenCodeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  tokenCode: { fontFamily: 'Outfit_700Bold', fontSize: 17, color: C.white, letterSpacing: -0.3 },
  customerName: { fontFamily: 'Manrope_400Regular', fontSize: 12.5, color: C.text2, marginTop: 2 },
  statusBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99, borderWidth: 1 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusTxt: { fontFamily: 'Manrope_600SemiBold', fontSize: 10, letterSpacing: 1 },

  // Device Bar
  deviceBarRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  deviceBarTxt: { fontFamily: 'Manrope_500Medium', fontSize: 11, color: C.text3, width: 100 },
  deviceBarBg: { flex: 1, height: 4, borderRadius: 99, backgroundColor: 'rgba(255,255,255,0.06)', overflow: 'hidden' },
  deviceBarFill: { height: '100%', borderRadius: 99 },

  // Expanded
  expandedSection: { gap: 8, paddingTop: 6, borderTopWidth: 1, borderTopColor: C.border },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  infoTxt: { fontFamily: 'Manrope_400Regular', fontSize: 12, color: C.text2 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  actionBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1 },
  actionBtnTxt: { fontFamily: 'Manrope_600SemiBold', fontSize: 12, letterSpacing: 0.2 },
  actionBtnDanger: { backgroundColor: C.redMuted, borderColor: C.redBorder },
  actionBtnSuccess: { backgroundColor: C.greenMuted, borderColor: C.greenBorder },
  actionBtnAmber: { backgroundColor: C.amberMuted, borderColor: C.amberBorder },
  actionBtnBlue: { backgroundColor: C.blueMuted, borderColor: C.blueBorder },

  // Form
  inputWrap: { width: '100%', marginBottom: 20 },
  formField: { marginBottom: 14 },
  inputLabel: { fontFamily: 'Manrope_600SemiBold', fontSize: 10, color: C.amber, letterSpacing: 2.5, marginBottom: 8 },
  textInput: { fontFamily: 'Manrope_400Regular', fontSize: 15, color: C.white, backgroundColor: C.surface2, borderWidth: 1, borderColor: C.border, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, ...Platform.select({ web: { outlineWidth: 0 } as any, default: {} }) },

  // Errors
  errorRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  errorTxt: { flex: 1, fontFamily: 'Manrope_500Medium', fontSize: 12, color: C.red, lineHeight: 16 },

  // Buttons
  primaryBtn: { width: '100%', height: 54, borderRadius: 99, backgroundColor: C.amber, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  primaryBtnTxt: { fontFamily: 'Manrope_600SemiBold', fontSize: 16, color: C.bg, letterSpacing: 0.4 },

  // Modal
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'flex-end', paddingHorizontal: 0 },
  modalCard: { backgroundColor: C.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderBottomWidth: 0, borderColor: C.border, padding: 20, maxHeight: '90%' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  modalTitle: { fontFamily: 'Outfit_700Bold', fontSize: 20, color: C.white, letterSpacing: -0.4 },

  // Misc
  text2: { fontFamily: 'Manrope_400Regular', fontSize: 14, color: C.text2 },
});
