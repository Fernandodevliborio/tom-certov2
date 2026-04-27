/**
 * Meta Pixel (Facebook Pixel) para React Native
 * 
 * Como React Native não suporta scripts do navegador,
 * usamos a API de conversões do Facebook diretamente.
 * 
 * Pixel ID: 1762463901557600
 */

import { Platform } from 'react-native';
import * as Application from 'expo-application';

const PIXEL_ID = '1762463901557600';

// URL da API de eventos do Facebook (lado do servidor é recomendado, mas cliente funciona para PageView)
const FB_PIXEL_URL = `https://www.facebook.com/tr?id=${PIXEL_ID}`;

/**
 * Envia evento de PageView para o Meta Pixel
 */
export async function trackPageView(pageName?: string): Promise<void> {
  try {
    const params = new URLSearchParams({
      id: PIXEL_ID,
      ev: 'PageView',
      dl: `app://tomcerto/${pageName || 'home'}`,
      rl: '',
      if: 'false',
      ts: Date.now().toString(),
      cd: JSON.stringify({
        platform: Platform.OS,
        app_version: Application.nativeApplicationVersion || '1.0.0',
        page: pageName || 'home',
      }),
    });

    // Faz requisição GET para o pixel (como uma imagem)
    await fetch(`${FB_PIXEL_URL}&${params.toString()}`, {
      method: 'GET',
      mode: 'no-cors',
    }).catch(() => {});
    
    // eslint-disable-next-line no-console
    console.log(`[MetaPixel] PageView tracked: ${pageName || 'home'}`);
  } catch (error) {
    // Silencioso - não queremos quebrar o app por causa do pixel
    // eslint-disable-next-line no-console
    console.log('[MetaPixel] Error tracking:', error);
  }
}

/**
 * Envia evento customizado para o Meta Pixel
 */
export async function trackEvent(eventName: string, params?: Record<string, any>): Promise<void> {
  try {
    const urlParams = new URLSearchParams({
      id: PIXEL_ID,
      ev: eventName,
      dl: 'app://tomcerto',
      rl: '',
      if: 'false',
      ts: Date.now().toString(),
      cd: JSON.stringify({
        platform: Platform.OS,
        app_version: Application.nativeApplicationVersion || '1.0.0',
        ...params,
      }),
    });

    await fetch(`${FB_PIXEL_URL}&${urlParams.toString()}`, {
      method: 'GET',
      mode: 'no-cors',
    }).catch(() => {});
    
    // eslint-disable-next-line no-console
    console.log(`[MetaPixel] Event tracked: ${eventName}`);
  } catch (error) {
    // Silencioso
  }
}

/**
 * Eventos pré-definidos
 */
export const MetaPixel = {
  // Visualização de página
  pageView: (pageName?: string) => trackPageView(pageName),
  
  // Usuário ativou o app com token
  completeRegistration: () => trackEvent('CompleteRegistration'),
  
  // Usuário iniciou detecção de tom
  startDetection: () => trackEvent('StartTrial', { content_name: 'tone_detection' }),
  
  // Tom detectado com sucesso
  toneDetected: (tone: string) => trackEvent('ViewContent', { content_name: tone, content_type: 'tone' }),
  
  // Lead (quando tenta ativar mas token inválido - pode ser lead de venda)
  lead: () => trackEvent('Lead'),
};

export default MetaPixel;
