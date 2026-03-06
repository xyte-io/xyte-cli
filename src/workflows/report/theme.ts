export interface WindowFocus {
  label: string;
  detail: string;
  accent: string;
  surface: string;
  panel: string;
}

const XYTE_PALETTE = {
  brandPrimary: '#2457F5',
  brandPrimaryStrong: '#173FB8',
  brandPrimaryLight: '#DCE7FF',
  brandPrimaryWash: '#EDF3FF',
  brandNavy: '#10254A',
  brandNavySoft: '#16366E',
  accentTeal: '#0F9F8A',
  textPrimary: '#0F172A',
  textSecondary: '#475569',
  textTertiary: '#64748B',
  textInverse: '#FFFFFF',
  textInverseMuted: '#D9E4FF',
  textWarning: '#9A3412',
  textDanger: '#991B1B',
  textSuccess: '#166534',
  bgPage: '#FFFFFF',
  bgCanvas: '#F8FAFC',
  bgSubtle: '#F4F7FB',
  bgSubtleAlt: '#E8EEF7',
  bgPanel: '#FFFFFF',
  bgHero: '#10254A',
  bgHeroSoft: '#16366E',
  bgWarning: '#FFF8EE',
  bgSuccess: '#F2FBF7',
  bgDanger: '#FFF5F5',
  border: '#D7E0ED',
  borderStrong: '#C2D0E0',
  borderWarning: '#F59E0B',
  borderSuccess: '#10B981',
  borderDanger: '#DC2626',
  statusGreen: '#059669',
  statusRed: '#DC2626',
  statusAmber: '#D97706'
} as const;

export const REPORT_THEME = {
  text: {
    primary: XYTE_PALETTE.textPrimary,
    secondary: XYTE_PALETTE.textSecondary,
    tertiary: XYTE_PALETTE.textTertiary,
    inverse: XYTE_PALETTE.textInverse,
    inverseMuted: XYTE_PALETTE.textInverseMuted
  },
  surface: {
    page: XYTE_PALETTE.bgPage,
    canvas: XYTE_PALETTE.bgCanvas,
    subtle: XYTE_PALETTE.bgSubtle,
    subtleAlt: XYTE_PALETTE.bgSubtleAlt,
    panel: XYTE_PALETTE.bgPanel,
    hero: XYTE_PALETTE.bgHero,
    heroSoft: XYTE_PALETTE.bgHeroSoft,
    badge: XYTE_PALETTE.brandPrimaryWash,
    accent: XYTE_PALETTE.brandPrimaryLight,
    success: XYTE_PALETTE.bgSuccess,
    warning: XYTE_PALETTE.bgWarning,
    danger: XYTE_PALETTE.bgDanger
  },
  border: {
    default: XYTE_PALETTE.border,
    strong: XYTE_PALETTE.borderStrong
  },
  accent: {
    primary: XYTE_PALETTE.brandPrimary,
    strong: XYTE_PALETTE.brandPrimaryStrong,
    secondary: XYTE_PALETTE.accentTeal
  },
  status: {
    online: XYTE_PALETTE.statusGreen,
    offline: XYTE_PALETTE.statusRed,
    warning: XYTE_PALETTE.statusAmber
  }
} as const;

interface MetricTone {
  panel: string;
  border: string;
  label: string;
  value: string;
  accent: string;
}

export type ReportTone = 'accent' | 'normal' | 'warn' | 'bad' | 'success';

const PANEL_TONES: Record<ReportTone, MetricTone> = {
  accent: {
    panel: REPORT_THEME.surface.accent,
    border: REPORT_THEME.border.default,
    label: REPORT_THEME.accent.strong,
    value: REPORT_THEME.text.primary,
    accent: REPORT_THEME.accent.primary
  },
  normal: {
    panel: REPORT_THEME.surface.panel,
    border: REPORT_THEME.border.default,
    label: REPORT_THEME.text.secondary,
    value: REPORT_THEME.text.primary,
    accent: REPORT_THEME.border.strong
  },
  warn: {
    panel: XYTE_PALETTE.bgWarning,
    border: REPORT_THEME.border.default,
    label: XYTE_PALETTE.textWarning,
    value: REPORT_THEME.text.primary,
    accent: REPORT_THEME.status.warning
  },
  bad: {
    panel: REPORT_THEME.surface.danger,
    border: REPORT_THEME.border.default,
    label: XYTE_PALETTE.textDanger,
    value: REPORT_THEME.text.primary,
    accent: REPORT_THEME.status.offline
  },
  success: {
    panel: REPORT_THEME.surface.success,
    border: REPORT_THEME.border.default,
    label: XYTE_PALETTE.textSuccess,
    value: REPORT_THEME.text.primary,
    accent: REPORT_THEME.status.online
  }
};

export function getMetricTone(tone: 'normal' | 'warn' | 'bad'): MetricTone {
  return PANEL_TONES[tone];
}

export function getPanelTone(tone: ReportTone): MetricTone {
  return PANEL_TONES[tone];
}

export function getWindowFocus(windowHours: number): WindowFocus {
  if (windowHours <= 24) {
    return {
      label: 'Immediate churn',
      detail: 'Contain active incidents and stabilize high-volatility spaces from the last day.',
      accent: REPORT_THEME.accent.primary,
      surface: REPORT_THEME.surface.badge,
      panel: REPORT_THEME.surface.badge
    };
  }

  if (windowHours <= 72) {
    return {
      label: 'Short-term trend',
      detail: 'Track repeat offenders and reduce recurring churn patterns before they harden.',
      accent: REPORT_THEME.accent.primary,
      surface: REPORT_THEME.surface.badge,
      panel: REPORT_THEME.surface.badge
    };
  }

  return {
    label: 'Weekly concentration',
    detail: 'Prioritize structural remediation where incident concentration persists week over week.',
    accent: REPORT_THEME.accent.primary,
    surface: REPORT_THEME.surface.badge,
    panel: REPORT_THEME.surface.badge
  };
}
