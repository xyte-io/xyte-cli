export const XYTE_LOGO_LINES = [
  '██   ██ ██    ██ ████████ ███████',
  ' ██ ██   ██  ██     ██    ██     ',
  '  ███     ████      ██    █████  ',
  ' ██ ██     ██       ██    ██     ',
  '██   ██    ██       ██    ███████'
];

export const XYTE_LOGO_COMPACT = 'XYTE';

export function xyteLogoText(): string {
  return XYTE_LOGO_LINES.join('\n');
}

export function xyteLogoRevealFrames(): string[] {
  const frames: string[] = [];
  for (let i = 1; i <= XYTE_LOGO_LINES.length; i += 1) {
    frames.push(XYTE_LOGO_LINES.slice(0, i).join('\n'));
  }
  return frames;
}
