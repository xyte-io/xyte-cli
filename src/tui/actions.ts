import type { TuiContext } from './types';

type PromptContext = Pick<TuiContext, 'prompt' | 'setStatus' | 'choose'>;
type GuardContext = Pick<TuiContext, 'confirmWrite' | 'setStatus'>;
type ErrorContext = Pick<TuiContext, 'showError'>;

interface PaletteAction {
  label: string;
  enabled?: boolean;
  disabledReason?: string;
  run: () => Promise<void | boolean>;
}

interface PromptChoice {
  label: string;
  value: string;
}

function parseOneBasedIndex(input: string, total: number): number | undefined {
  const trimmed = input.trim();
  if (!/^(?:0|[1-9]\d*)$/.test(trimmed)) {
    return undefined;
  }
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || numeric < 1 || numeric > total) {
    return undefined;
  }
  return numeric - 1;
}

export async function openActionPalette(args: {
  context: PromptContext & ErrorContext;
  title: string;
  actions: PaletteAction[];
}): Promise<boolean> {
  if (!args.actions.length) {
    args.context.setStatus('No actions are available.');
    return true;
  }

  let selectedIndex: number | undefined;
  if (args.context.choose) {
    selectedIndex = await args.context.choose({
      title: args.title,
      items: args.actions.map((action) => ({
        label: action.label,
        disabled: action.enabled === false,
        disabledReason: action.disabledReason,
        hint: action.enabled === false ? action.disabledReason ?? 'Unavailable' : undefined
      }))
    });
    if (selectedIndex === undefined) {
      args.context.setStatus('Action menu canceled.');
      return true;
    }
  } else {
    const lines = [args.title, ...args.actions.map((action, index) => {
      const disabled = action.enabled === false ? ' (disabled)' : '';
      return `${index + 1}. ${action.label}${disabled}`;
    })];

    const raw = await args.context.prompt(`${lines.join('\n')}\n\nSelect action number:`, '');
    if (raw === undefined || raw.trim() === '') {
      args.context.setStatus('Action menu canceled.');
      return true;
    }

    selectedIndex = parseOneBasedIndex(raw, args.actions.length);
    if (selectedIndex === undefined) {
      args.context.setStatus('Invalid action selection.');
      return true;
    }
  }

  const selected = args.actions[selectedIndex];
  if (selected.enabled === false) {
    args.context.setStatus(selected.disabledReason ?? `${selected.label} is disabled.`);
    return true;
  }

  try {
    await selected.run();
    return true;
  } catch (error) {
    args.context.showError(error);
    return true;
  }
}

export async function confirmWriteWithToken(
  context: GuardContext,
  actionLabel: string,
  token: string,
  cancelStatus: string
): Promise<boolean> {
  const ok = await context.confirmWrite(actionLabel, token);
  if (!ok) {
    context.setStatus(cancelStatus);
    return false;
  }
  return true;
}

export async function promptChoice(
  context: PromptContext,
  args: { title: string; choices: PromptChoice[]; emptyStatus?: string }
): Promise<PromptChoice | undefined> {
  if (!args.choices.length) {
    context.setStatus(args.emptyStatus ?? 'No options are available.');
    return undefined;
  }

  let selectedIndex: number | undefined;
  if (context.choose) {
    selectedIndex = await context.choose({
      title: args.title,
      items: args.choices.map((choice) => ({
        label: choice.label
      }))
    });
    if (selectedIndex === undefined) {
      context.setStatus('Selection canceled.');
      return undefined;
    }
  } else {
    const lines = [args.title, ...args.choices.map((choice, index) => `${index + 1}. ${choice.label}`)];
    const raw = await context.prompt(`${lines.join('\n')}\n\nChoose number:`, '');
    if (raw === undefined || raw.trim() === '') {
      context.setStatus('Selection canceled.');
      return undefined;
    }

    selectedIndex = parseOneBasedIndex(raw, args.choices.length);
    if (selectedIndex === undefined) {
      context.setStatus('Invalid selection.');
      return undefined;
    }
  }
  return args.choices[selectedIndex];
}

export function parseJsonObjectInput(value: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'JSON value must be an object.' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Invalid JSON.'
    };
  }
}
