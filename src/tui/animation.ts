import { xyteLogoRevealFrames } from './assets/logo';

export interface StartupFrame {
  banner: string;
  status: string;
  title: string;
}

const BOOT_STATUS = [
  'Booting terminal shell...',
  'Loading tenant profile...',
  'Hydrating XYTE panels...'
];

export function startupFrames(): StartupFrame[] {
  const logoFrames = xyteLogoRevealFrames();
  const count = Math.max(logoFrames.length, BOOT_STATUS.length);
  const frames: StartupFrame[] = [];

  for (let i = 0; i < count; i += 1) {
    frames.push({
      banner: logoFrames[Math.min(i, logoFrames.length - 1)],
      status: BOOT_STATUS[Math.min(i, BOOT_STATUS.length - 1)],
      title: 'XYTE SDK TUI'
    });
  }

  return frames;
}

const PULSE_CHARS = ['.', 'o', 'O', '@', 'O', 'o'];

export function pulseChar(phase: number): string {
  return PULSE_CHARS[Math.abs(phase) % PULSE_CHARS.length];
}

export function isMotionEnabled(args: { headless?: boolean; explicitMotion?: boolean }): boolean {
  if (process.env.XYTE_TUI_REDUCED_MOTION === '1') {
    return false;
  }

  if (args.explicitMotion !== undefined) {
    return args.explicitMotion;
  }

  if (args.headless) {
    return false;
  }

  return true;
}
