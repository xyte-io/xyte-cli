export interface WindowFocus {
  label: string;
  detail: string;
  accent: string;
  surface: string;
  panel: string;
}

export const XYTE_PALETTE = {
  // Primary palette
  black: '#000000',
  white: '#FFFFFF',
  purplePrimary: '#7B1FA2',
  amberPrimary: '#FFC107',
  // Secondary palette
  blueDeep: '#283593',
  purpleDeep: '#6B0079',
  violet: '#7C4DFF',
  blueBright: '#2979FF',
  pink: '#FF4081',
  teal: '#00BFA5',
  // Derived utility tokens (tints/shades from the palette above)
  navy950: '#000000',
  navy900: '#283593',
  navy800: '#6B0079',
  navy700: '#7B1FA2',
  ink950: '#000000',
  ink900: '#0E0E12',
  ink700: '#2A2A33',
  slate700: '#414162',
  slate500: '#676782',
  slate400: '#8A8AA8',
  paper: '#FFFFFF',
  paperBlue: '#F4F3FF',
  mist: '#F6F1FB',
  borderSoft: '#DAD6EE',
  borderStrong: '#B8B0DE',
  borderInk: '#8B80C6',
  aqua: '#00BFA5',
  aquaBright: '#7C4DFF',
  aquaSoft: '#E7F9F6',
  gold: '#FFC107',
  goldSoft: '#FFF5D6',
  coral: '#FF4081',
  coralSoft: '#FFE4EF',
  blue: '#2979FF',
  blueSoft: '#E8F0FF'
} as const;

export interface MetricTone {
  panel: string;
  border: string;
  label: string;
  value: string;
  accent: string;
}

const METRIC_TONES: Record<'normal' | 'warn' | 'bad', MetricTone> = {
  normal: {
    panel: '#E8F9F6',
    border: '#8ADFD2',
    label: '#006B5C',
    value: '#007D6D',
    accent: XYTE_PALETTE.teal
  },
  warn: {
    panel: XYTE_PALETTE.goldSoft,
    border: '#E7CC83',
    label: '#7A5200',
    value: '#946200',
    accent: XYTE_PALETTE.amberPrimary
  },
  bad: {
    panel: XYTE_PALETTE.coralSoft,
    border: '#F2AFC6',
    label: '#8F1D49',
    value: '#B11157',
    accent: XYTE_PALETTE.pink
  }
};

export function getMetricTone(tone: 'normal' | 'warn' | 'bad'): MetricTone {
  return METRIC_TONES[tone];
}

export function getWindowFocus(windowHours: number): WindowFocus {
  if (windowHours <= 24) {
    return {
      label: 'Immediate churn',
      detail: 'Contain active incidents and stabilize high-volatility spaces from the last day.',
      accent: XYTE_PALETTE.pink,
      surface: XYTE_PALETTE.coralSoft,
      panel: '#FFEAF2'
    };
  }

  if (windowHours <= 72) {
    return {
      label: 'Short-term trend',
      detail: 'Track repeat offenders and reduce recurring churn patterns before they harden.',
      accent: XYTE_PALETTE.blueBright,
      surface: XYTE_PALETTE.blueSoft,
      panel: '#EEF3FF'
    };
  }

  return {
    label: 'Weekly concentration',
    detail: 'Prioritize structural remediation where incident concentration persists week over week.',
    accent: XYTE_PALETTE.purplePrimary,
    surface: XYTE_PALETTE.aquaSoft,
    panel: '#F1EBFF'
  };
}
