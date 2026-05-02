import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const NOTES_BR = ['Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si'];

interface Props {
  apiBaseUrl: string;
  deviceId: string;
  detectedKeyName: string | null;  // Ex: "Sol Maior"
  confidencePct: number;           // 0-100
}

/**
 * Botão "Tom errado?" + modal para usuário indicar o tom correto.
 * Envia para POST /api/key-feedback/submit.
 */
export const WrongKeyFeedback: React.FC<Props> = ({ apiBaseUrl, deviceId, detectedKeyName, confidencePct }) => {
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedPc, setSelectedPc] = useState<number | null>(null);
  const [selectedQuality, setSelectedQuality] = useState<'major' | 'minor'>('major');
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const submit = async () => {
    if (selectedPc === null) {
      Alert.alert('Selecione o tom', 'Escolha a tônica e se é maior ou menor.');
      return;
    }
    const correctKeyName = `${NOTES_BR[selectedPc]} ${selectedQuality === 'major' ? 'Maior' : 'menor'}`;
    setSubmitting(true);
    try {
      const resp = await fetch(`${apiBaseUrl}/api/key-feedback/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Id': deviceId,
        },
        body: JSON.stringify({
          correct_key_name: correctKeyName,
          user_comment: comment || undefined,
        }),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 120)}`);
      }
      const data = await resp.json();
      setSubmitted(true);
      Alert.alert(
        'Obrigado!',
        data.message || 'Seu feedback foi registrado e vai ajudar a melhorar a detecção.',
      );
      setTimeout(() => setModalOpen(false), 300);
    } catch (e: any) {
      Alert.alert('Erro', e.message || 'Não consegui enviar o feedback.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!detectedKeyName) return null;

  return (
    <>
      <TouchableOpacity
        testID="wrong-key-button"
        onPress={() => setModalOpen(true)}
        style={styles.wrongBtn}
        accessibilityLabel="Tom errado? Nos avise"
      >
        <Ionicons name="alert-circle-outline" size={12} color="#E8B84A" />
        <Text style={styles.wrongBtnTxt}>Tom errado?</Text>
      </TouchableOpacity>

      <Modal
        visible={modalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setModalOpen(false)}
      >
        <View style={styles.overlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Qual era o tom certo?</Text>
              <TouchableOpacity
                onPress={() => setModalOpen(false)}
                testID="wrong-key-close"
                accessibilityLabel="Fechar"
              >
                <Ionicons name="close" size={22} color="#AAA" />
              </TouchableOpacity>
            </View>

            <Text style={styles.modalSub}>
              Detectei <Text style={styles.detectedName}>{detectedKeyName}</Text> ({confidencePct}%).
              {'\n'}Me ajude: qual tonalidade você cantou?
            </Text>

            {/* Grid de 12 tônicas */}
            <ScrollView style={styles.tonicsScroll}>
              <View style={styles.tonicsGrid}>
                {NOTES_BR.map((name, pc) => {
                  const selected = selectedPc === pc;
                  return (
                    <TouchableOpacity
                      key={pc}
                      testID={`tonic-${pc}`}
                      onPress={() => setSelectedPc(pc)}
                      style={[styles.tonicBtn, selected && styles.tonicBtnSel]}
                    >
                      <Text style={[styles.tonicTxt, selected && styles.tonicTxtSel]}>{name}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>

            <View style={styles.qualityRow}>
              <TouchableOpacity
                testID="quality-major"
                onPress={() => setSelectedQuality('major')}
                style={[styles.qBtn, selectedQuality === 'major' && styles.qBtnSel]}
              >
                <Text style={[styles.qTxt, selectedQuality === 'major' && styles.qTxtSel]}>Maior</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="quality-minor"
                onPress={() => setSelectedQuality('minor')}
                style={[styles.qBtn, selectedQuality === 'minor' && styles.qBtnSel]}
              >
                <Text style={[styles.qTxt, selectedQuality === 'minor' && styles.qTxtSel]}>menor</Text>
              </TouchableOpacity>
            </View>

            {selectedPc !== null && (
              <View style={styles.preview}>
                <Text style={styles.previewLabel}>Você selecionou:</Text>
                <Text style={styles.previewValue}>
                  {NOTES_BR[selectedPc]} {selectedQuality === 'major' ? 'Maior' : 'menor'}
                </Text>
              </View>
            )}

            <TouchableOpacity
              testID="wrong-key-submit"
              disabled={selectedPc === null || submitting || submitted}
              onPress={submit}
              style={[
                styles.submitBtn,
                (selectedPc === null || submitting || submitted) && styles.submitBtnDis,
              ]}
            >
              {submitting ? (
                <ActivityIndicator color="#000" size="small" />
              ) : submitted ? (
                <Text style={styles.submitTxt}>Enviado ✓</Text>
              ) : (
                <Text style={styles.submitTxt}>Enviar feedback</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
};

const styles = StyleSheet.create({
  wrongBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'center',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 14,
    backgroundColor: 'rgba(232,184,74,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(232,184,74,0.28)',
    marginTop: 8,
  },
  wrongBtnTxt: {
    fontSize: 11,
    fontWeight: '600',
    color: '#E8B84A',
    letterSpacing: 0.3,
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.72)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: '#101010',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 18,
    paddingBottom: 28,
    maxHeight: '82%',
    borderWidth: 1,
    borderColor: 'rgba(232,184,74,0.2)',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#FFF',
  },
  modalSub: {
    fontSize: 13,
    color: '#AAA',
    marginBottom: 14,
    lineHeight: 18,
  },
  detectedName: {
    color: '#E8B84A',
    fontWeight: '600',
  },
  tonicsScroll: {
    maxHeight: 180,
    marginBottom: 12,
  },
  tonicsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  tonicBtn: {
    width: '23%',
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.05)',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  tonicBtnSel: {
    backgroundColor: 'rgba(232,184,74,0.18)',
    borderColor: '#E8B84A',
  },
  tonicTxt: {
    fontSize: 14,
    fontWeight: '600',
    color: '#DDD',
  },
  tonicTxtSel: {
    color: '#E8B84A',
  },
  qualityRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 14,
  },
  qBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.05)',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  qBtnSel: {
    backgroundColor: 'rgba(232,184,74,0.18)',
    borderColor: '#E8B84A',
  },
  qTxt: { fontSize: 14, color: '#DDD', fontWeight: '600' },
  qTxtSel: { color: '#E8B84A' },
  preview: {
    alignItems: 'center',
    padding: 12,
    backgroundColor: 'rgba(232,184,74,0.06)',
    borderRadius: 10,
    marginBottom: 14,
  },
  previewLabel: { fontSize: 11, color: '#888', marginBottom: 3 },
  previewValue: { fontSize: 18, color: '#E8B84A', fontWeight: '700' },
  submitBtn: {
    backgroundColor: '#E8B84A',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  submitBtnDis: {
    backgroundColor: '#333',
  },
  submitTxt: {
    fontSize: 15,
    fontWeight: '700',
    color: '#000',
    letterSpacing: 0.3,
  },
});
