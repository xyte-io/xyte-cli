export interface WindowFocus {
  label: string;
  detail: string;
  accent: string;
  surface: string;
  panel: string;
}

export const XYTE_PALETTE = {
  brandPrimary: '#3B82F6',
  brandPrimaryLight: '#EFF6FF',
  textPrimary: '#111827',
  textSecondary: '#6B7280',
  textTertiary: '#9CA3AF',
  bgPage: '#FFFFFF',
  bgSubtle: '#F9FAFB',
  border: '#E5E7EB',
  statusGreen: '#059669',
  statusRed: '#DC2626',
  statusAmber: '#D97706'
} as const;

export const REPORT_THEME = {
  text: {
    primary: XYTE_PALETTE.textPrimary,
    secondary: XYTE_PALETTE.textSecondary,
    tertiary: XYTE_PALETTE.textTertiary
  },
  surface: {
    page: XYTE_PALETTE.bgPage,
    subtle: XYTE_PALETTE.bgSubtle,
    badge: XYTE_PALETTE.brandPrimaryLight
  },
  border: {
    default: XYTE_PALETTE.border
  },
  accent: {
    primary: XYTE_PALETTE.brandPrimary
  },
  status: {
    online: XYTE_PALETTE.statusGreen,
    offline: XYTE_PALETTE.statusRed,
    warning: XYTE_PALETTE.statusAmber
  }
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
    panel: REPORT_THEME.surface.subtle,
    border: REPORT_THEME.border.default,
    label: REPORT_THEME.text.secondary,
    value: REPORT_THEME.text.primary,
    accent: REPORT_THEME.accent.primary
  },
  warn: {
    panel: REPORT_THEME.surface.subtle,
    border: REPORT_THEME.border.default,
    label: REPORT_THEME.text.secondary,
    value: REPORT_THEME.text.primary,
    accent: REPORT_THEME.accent.primary
  },
  bad: {
    panel: REPORT_THEME.surface.subtle,
    border: REPORT_THEME.border.default,
    label: REPORT_THEME.text.secondary,
    value: REPORT_THEME.text.primary,
    accent: REPORT_THEME.accent.primary
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
