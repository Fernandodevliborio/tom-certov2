/**
 * Design tokens — Tom Certo v4.0 Premium
 * Baseado no mockup ChatGPT 25 abr 2026.
 */

export const Colors = {
  // Fundos
  bg: '#0A0A0A',
  bgDeep: '#000000',
  surface: '#111111',
  surface2: '#171717',
  surface3: '#1E1E1E',

  // Bordas
  border: '#1F1F1F',
  borderStrong: '#2A2A2A',

  // Dourado (primário)
  gold: '#FFB020',
  goldLight: '#FFD166',
  goldDeep: '#C98A12',
  goldGlow: 'rgba(255, 176, 32, 0.45)',
  goldGlowSoft: 'rgba(255, 176, 32, 0.22)',
  goldMuted: 'rgba(255, 176, 32, 0.10)',
  goldBorder: 'rgba(255, 176, 32, 0.32)',
  goldBorderSoft: 'rgba(255, 176, 32, 0.18)',

  // Verde (confirmação)
  green: '#22C55E',
  greenSoft: 'rgba(34, 197, 94, 0.18)',
  greenBorder: 'rgba(34, 197, 94, 0.45)',
  greenGlow: 'rgba(34, 197, 94, 0.30)',

  // Texto
  white: '#FFFFFF',
  textMuted: '#9BA1A6',
  text2: '#687280',
  text3: '#4A5159',

  // Erro
  red: '#EF4444',
  redSoft: 'rgba(239, 68, 68, 0.14)',

  // Outros
  blue: '#60A5FA',
};

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 40,
};

export const Radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
};

export const Typography = {
  // Famílias Poppins
  bold: 'Poppins_700Bold',
  semi: 'Poppins_600SemiBold',
  medium: 'Poppins_500Medium',
  regular: 'Poppins_400Regular',
};

export const Shadows = {
  goldGlow: {
    shadowColor: Colors.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.55,
    shadowRadius: 28,
    elevation: 12,
  },
  goldGlowSoft: {
    shadowColor: Colors.gold,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.32,
    shadowRadius: 16,
    elevation: 6,
  },
  greenGlow: {
    shadowColor: Colors.green,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.45,
    shadowRadius: 18,
    elevation: 8,
  },
};
