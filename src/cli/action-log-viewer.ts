import blessed from 'blessed';

import { extractCommandPathFromLogEntry, type CliActionLogEntry } from './action-logger';

export interface ActionLogViewerOptions {
  entries: CliActionLogEntry[];
  title?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function extractDurationMs(entry: CliActionLogEntry): number | undefined {
  if (!isRecord(entry.data)) {
    return undefined;
  }
  const value = entry.data.durationMs;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.round(value);
}

function summarize(entry: CliActionLogEntry): string {
  const timestamp = entry.timestamp.replace('T', ' ').replace('Z', '');
  const event = entry.event.padEnd(20).slice(0, 20);
  const commandPath = (extractCommandPathFromLogEntry(entry) ?? '-').slice(0, 60);
  const durationMs = extractDurationMs(entry);
  if (durationMs !== undefined) {
    return `${timestamp}  ${event}  ${commandPath} (${durationMs}ms)`;
  }
  return `${timestamp}  ${event}  ${commandPath}`;
}

function pretty(entry: CliActionLogEntry): string {
  return JSON.stringify(entry, null, 2);
}

export async function runActionLogViewer(options: ActionLogViewerOptions): Promise<void> {
  await new Promise<void>((resolve) => {
    const screen = blessed.screen({
      smartCSR: true,
      title: options.title ?? 'xyte-cli action logs'
    });

    const list = blessed.list({
      parent: screen,
      top: 0,
      left: 0,
      width: '50%',
      height: '100%-1',
      border: 'line',
      label: ' Action Log Entries ',
      keys: true,
      vi: true,
      mouse: true,
      style: {
        selected: {
          bg: 'blue'
        }
      },
      items: options.entries.map((entry) => summarize(entry))
    });

    const details = blessed.box({
      parent: screen,
      top: 0,
      left: '50%',
      width: '50%',
      height: '100%-1',
      border: 'line',
      label: ' Entry Details ',
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true
    });

    blessed.box({
      parent: screen,
      left: 0,
      bottom: 0,
      width: '100%',
      height: 1,
      content: ' ↑/↓: select   Tab: switch pane   PgUp/PgDn: scroll details   q: quit ',
      style: {
        fg: 'black',
        bg: 'white'
      }
    });

    let selectedIndex = options.entries.length > 0 ? options.entries.length - 1 : 0;

    const renderDetails = () => {
      if (options.entries.length === 0) {
        details.setContent('No action log entries found.');
      } else {
        details.setContent(pretty(options.entries[selectedIndex] ?? options.entries[0]));
      }
      screen.render();
    };

    let closed = false;
    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      screen.destroy();
      resolve();
    };

    screen.key(['q', 'escape', 'C-c'], close);
    screen.key(['tab'], () => {
      if (screen.focused === list) {
        details.focus();
      } else {
        list.focus();
      }
      screen.render();
    });

    list.on('select item', (_item, index) => {
      selectedIndex = Math.max(0, index);
      renderDetails();
    });

    if (options.entries.length > 0) {
      list.select(options.entries.length - 1);
    }
    list.focus();
    renderDetails();
  });
}
