import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, ActivityIndicator, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const C = {
  bg: '#000000',
  surface: '#0E0E0E',
  surface2: '#141414',
  border: '#1C1C1C',
  amber: '#FFB020',
  amberGlow: 'rgba(255,176,32,0.38)',
  amberMuted: 'rgba(255,176,32,0.10)',
  amberBorder: 'rgba(255,176,32,0.28)',
  white: '#FFFFFF',
  text2: '#A0A0A0',
  text3: '#555555',
  green: '#22C55E',
  red: '#EF4444',
};

const SUPPORT_WHATSAPP = 'https://wa.me/5511999999999?text=Ol%C3%A1!%20Preciso%20de%20ajuda%20com%20meu%20acesso%20ao%20Tom%20Certo';

interface DeviceSwapScreenProps {
  visible: boolean;
  canSwap: boolean;
  swapBlockedReason: string | null;
  resetCount: number;
  maxAutoResets: number;
  onSwapConfirm: () => Promise<void>;
  onCancel: () => void;
}

export default function DeviceSwapScreen({
  visible,
  canSwap,
  swapBlockedReason,
  resetCount,
  maxAutoResets,
  onSwapConfirm,
  onCancel,
}: DeviceSwapScreenProps) {
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [isSwapping, setIsSwapping] = useState(false);

  const handleSwapPress = () => {
    if (canSwap) {
      setShowConfirmModal(true);
    }
  };

  const handleConfirmSwap = async () => {
    setIsSwapping(true);
    try {
      await onSwapConfirm();
    } finally {
      setIsSwapping(false);
      setShowConfirmModal(false);
    }
  };

  const handleContactSupport = () => {
    Linking.openURL(SUPPORT_WHATSAPP);
  };

  // Parse blocked reason
  let blockedMessage = '';
  let daysRemaining = 0;
  if (swapBlockedReason) {
    if (swapBlockedReason === 'swap_limit_reached') {
      blockedMessage = 'Limite de troca atingido. Fale com o suporte para liberar seu acesso.';
    } else if (swapBlockedReason.startsWith('cooldown_active:')) {
      daysRemaining = parseInt(swapBlockedReason.split(':')[1]) || 0;
      blockedMessage = `Você poderá trocar de dispositivo em ${daysRemaining} dias.`;
    }
  }

  if (!visible) return null;

  return (
    <View style={ss.container}>
      <View style={ss.card}>
        {/* Ícone */}
        <View style={ss.iconWrap}>
          <Ionicons name="phone-portrait-outline" size={40} color={C.amber} />
          <View style={ss.iconBadge}>
            <Ionicons name="close" size={16} color={C.red} />
          </View>
        </View>

        {/* Título */}
        <Text style={ss.title}>Este código já está vinculado{'\n'}a outro celular</Text>

        {/* Texto explicativo */}
        <Text style={ss.description}>
          Se você trocou ou formatou o aparelho, pode transferir seu acesso para este dispositivo.
        </Text>

        {/* Info de trocas */}
        <View style={ss.swapInfo}>
          <Text style={ss.swapInfoLabel}>Trocas realizadas</Text>
          <Text style={ss.swapInfoValue}>{resetCount} de {maxAutoResets}</Text>
        </View>

        {/* Botão de troca ou mensagem de bloqueio */}
        {canSwap ? (
          <>
            <TouchableOpacity
              style={ss.swapBtn}
              onPress={handleSwapPress}
              activeOpacity={0.85}
            >
              <Ionicons name="swap-horizontal" size={20} color={C.bg} />
              <Text style={ss.swapBtnTxt}>Transferir acesso para este celular</Text>
            </TouchableOpacity>

            <Text style={ss.securityNote}>
              <Ionicons name="shield-checkmark" size={12} color={C.text3} />
              {' '}Por segurança, essa troca é limitada.
            </Text>
          </>
        ) : (
          <>
            <View style={ss.blockedBox}>
              <Ionicons name="lock-closed" size={20} color={C.red} />
              <Text style={ss.blockedText}>{blockedMessage}</Text>
            </View>

            <TouchableOpacity
              style={ss.supportBtn}
              onPress={handleContactSupport}
              activeOpacity={0.85}
            >
              <Ionicons name="logo-whatsapp" size={18} color={C.green} />
              <Text style={ss.supportBtnTxt}>Falar com suporte</Text>
            </TouchableOpacity>
          </>
        )}

        {/* Botão cancelar */}
        <TouchableOpacity style={ss.cancelBtn} onPress={onCancel}>
          <Text style={ss.cancelBtnTxt}>Usar outro código</Text>
        </TouchableOpacity>
      </View>

      {/* Modal de confirmação */}
      <Modal visible={showConfirmModal} transparent animationType="fade">
        <View style={ss.modalBg}>
          <View style={ss.confirmCard}>
            <View style={ss.confirmIconWrap}>
              <Ionicons name="alert-circle" size={32} color={C.amber} />
            </View>

            <Text style={ss.confirmTitle}>Confirmar troca de dispositivo?</Text>

            <Text style={ss.confirmDesc}>
              Ao continuar, o acesso será removido do celular anterior e ficará ativo apenas neste aparelho.
            </Text>

            <View style={ss.confirmBtns}>
              <TouchableOpacity
                style={ss.confirmCancelBtn}
                onPress={() => setShowConfirmModal(false)}
                disabled={isSwapping}
              >
                <Text style={ss.confirmCancelTxt}>Cancelar</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={ss.confirmOkBtn}
                onPress={handleConfirmSwap}
                disabled={isSwapping}
                activeOpacity={0.85}
              >
                {isSwapping ? (
                  <ActivityIndicator size="small" color={C.bg} />
                ) : (
                  <Text style={ss.confirmOkTxt}>Confirmar troca</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const ss = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: C.surface,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: C.border,
    padding: 28,
    width: '100%',
    maxWidth: 360,
    alignItems: 'center',
  },
  iconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: C.amberMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    position: 'relative',
  },
  iconBadge: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(239,68,68,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 20,
    color: C.white,
    textAlign: 'center',
    letterSpacing: -0.5,
    marginBottom: 12,
  },
  description: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 14,
    color: C.text2,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
  },
  swapInfo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 10,
    padding: 12,
    width: '100%',
    marginBottom: 20,
  },
  swapInfoLabel: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 13,
    color: C.text3,
  },
  swapInfoValue: {
    fontFamily: 'Manrope_700Bold',
    fontSize: 13,
    color: C.amber,
  },
  swapBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: C.amber,
    width: '100%',
    height: 52,
    borderRadius: 14,
    marginBottom: 12,
  },
  swapBtnTxt: {
    fontFamily: 'Manrope_700Bold',
    fontSize: 14,
    color: C.bg,
  },
  securityNote: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 11,
    color: C.text3,
    textAlign: 'center',
    marginBottom: 16,
  },
  blockedBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.3)',
    padding: 14,
    gap: 10,
    marginBottom: 16,
    width: '100%',
  },
  blockedText: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 13,
    color: C.red,
    flex: 1,
  },
  supportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(34,197,94,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.3)',
    width: '100%',
    height: 48,
    borderRadius: 12,
    marginBottom: 16,
  },
  supportBtnTxt: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 14,
    color: C.green,
  },
  cancelBtn: {
    paddingVertical: 12,
  },
  cancelBtnTxt: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 13,
    color: C.text3,
  },
  // Modal
  modalBg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  confirmCard: {
    backgroundColor: C.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.border,
    padding: 24,
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
  },
  confirmIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: C.amberMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  confirmTitle: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 18,
    color: C.white,
    textAlign: 'center',
    marginBottom: 10,
  },
  confirmDesc: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 13,
    color: C.text2,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 20,
  },
  confirmBtns: {
    flexDirection: 'row',
    gap: 10,
    width: '100%',
  },
  confirmCancelBtn: {
    flex: 1,
    height: 46,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmCancelTxt: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 14,
    color: C.text2,
  },
  confirmOkBtn: {
    flex: 1,
    height: 46,
    borderRadius: 10,
    backgroundColor: C.amber,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmOkTxt: {
    fontFamily: 'Manrope_700Bold',
    fontSize: 14,
    color: C.bg,
  },
});
