import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Linking } from 'react-native';
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
};

// URL do checkout do plano Profissional
const PROFISSIONAL_CHECKOUT_URL = 'https://checkout.ticto.app/OF743CFCB';

interface UpgradeModalProps {
  visible: boolean;
  onClose: () => void;
}

export default function UpgradeModal({ visible, onClose }: UpgradeModalProps) {
  const handleUpgrade = async () => {
    try {
      await Linking.openURL(PROFISSIONAL_CHECKOUT_URL);
    } catch (err) {
      console.error('Erro ao abrir link de upgrade:', err);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={ss.modalBg}>
        <View style={ss.modalCard}>
          {/* Ícone */}
          <View style={ss.iconWrap}>
            <Ionicons name="lock-open" size={32} color={C.amber} />
          </View>

          {/* Título */}
          <Text style={ss.title}>Você já tem o tom.</Text>
          <Text style={ss.titleHighlight}>Falta só o acorde.</Text>

          {/* Subtítulo */}
          <Text style={ss.subtitle}>
            Desbloqueie o recurso que transforma o app em uma ferramenta completa.
          </Text>

          {/* Benefícios */}
          <View style={ss.benefits}>
            <View style={ss.benefitRow}>
              <Ionicons name="checkmark-circle" size={18} color={C.green} />
              <Text style={ss.benefitText}>Acordes em tempo real</Text>
            </View>
            <View style={ss.benefitRow}>
              <Ionicons name="checkmark-circle" size={18} color={C.green} />
              <Text style={ss.benefitText}>Diagramas de acordes</Text>
            </View>
            <View style={ss.benefitRow}>
              <Ionicons name="checkmark-circle" size={18} color={C.green} />
              <Text style={ss.benefitText}>Grau harmônico destacado</Text>
            </View>
          </View>

          {/* Preço */}
          <View style={ss.priceBox}>
            <Text style={ss.priceLabel}>PLANO PROFISSIONAL</Text>
            <View style={ss.priceRow}>
              <Text style={ss.priceValue}>R$ 19,90</Text>
              <Text style={ss.pricePeriod}>/mês</Text>
            </View>
          </View>

          {/* Botão de upgrade */}
          <TouchableOpacity
            style={ss.upgradeBtn}
            onPress={handleUpgrade}
            activeOpacity={0.85}
          >
            <Ionicons name="rocket" size={18} color={C.bg} />
            <Text style={ss.upgradeBtnTxt}>Desbloquear agora</Text>
          </TouchableOpacity>

          {/* Fechar */}
          <TouchableOpacity style={ss.closeBtn} onPress={onClose}>
            <Text style={ss.closeBtnTxt}>Continuar com plano Essencial</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const ss = StyleSheet.create({
  modalBg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.88)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  modalCard: {
    backgroundColor: C.surface,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: C.amberBorder,
    padding: 28,
    width: '100%',
    maxWidth: 360,
    alignItems: 'center',
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: C.amberMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  title: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 22,
    color: C.white,
    textAlign: 'center',
    letterSpacing: -0.5,
  },
  titleHighlight: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 22,
    color: C.amber,
    textAlign: 'center',
    letterSpacing: -0.5,
    marginBottom: 12,
  },
  subtitle: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 14,
    color: C.text2,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
  },
  benefits: {
    width: '100%',
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 12,
    padding: 14,
    gap: 10,
    marginBottom: 20,
  },
  benefitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  benefitText: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 13,
    color: C.white,
  },
  priceBox: {
    alignItems: 'center',
    marginBottom: 20,
  },
  priceLabel: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 10,
    color: C.amber,
    letterSpacing: 2,
    marginBottom: 4,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  priceValue: {
    fontFamily: 'Outfit_800ExtraBold',
    fontSize: 32,
    color: C.white,
    letterSpacing: -1,
  },
  pricePeriod: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 14,
    color: C.text2,
    marginLeft: 4,
  },
  upgradeBtn: {
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
  upgradeBtnTxt: {
    fontFamily: 'Manrope_700Bold',
    fontSize: 15,
    color: C.bg,
    letterSpacing: 0.3,
  },
  closeBtn: {
    paddingVertical: 10,
  },
  closeBtnTxt: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 13,
    color: C.text3,
  },
});
