import blessed, { type Widgets } from 'blessed';

import { pulseChar } from './animation';
import type { TuiScreenId } from './types';
import { TAB_ORDER } from './tabs';

interface TuiLayout {
  header: Widgets.BoxElement;
  tabs: Widgets.BoxElement;
  body: Widgets.BoxElement;
  footer: Widgets.BoxElement;
  help: Widgets.BoxElement;
  setActiveTab(tab: TuiScreenId): void;
  setPulsePhase(phase: number): void;
}

interface TuiLayoutOptions {
  motionEnabled: boolean;
}

export function createLayout(screen: Widgets.Screen, options: TuiLayoutOptions): TuiLayout {
  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: ' XYTE OPS CONSOLE ',
    style: {
      fg: 'white',
      bg: 'blue',
      bold: true
    }
  });

  const tabs = blessed.box({
    parent: screen,
    top: 1,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    content: ' ',
    style: {
      fg: 'cyan',
      bg: 'black'
    }
  });

  const body = blessed.box({
    parent: screen,
    top: 2,
    left: 0,
    width: '100%',
    height: '100%-4',
    border: 'line',
    style: {
      border: {
        fg: 'yellow'
      }
    }
  });

  const footer = blessed.box({
    parent: screen,
    bottom: 1,
    left: 0,
    width: '100%',
    height: 1,
    content: ' • Ready ',
    style: {
      fg: 'white',
      bg: 'blue'
    }
  });

  const help = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: ' 1-7 tabs | m jump | Ctrl+←/→ panes | ↑/↓ move | Enter drill | o deep view | ? help | q quit ',
    style: {
      fg: 'black',
      bg: 'cyan',
      bold: true
    }
  });

  const tabLabelById: Record<TuiScreenId, string> = {
    setup: '1 Setup',
    config: '2 Config',
    dashboard: '3 Dashboard',
    spaces: '4 Spaces',
    devices: '5 Devices',
    incidents: '6 Incidents',
    tickets: '7 Tickets'
  };

  const inactiveTabStyle = '{cyan-fg}';
  const activeTabStyle = '{black-fg}{cyan-bg}';
  const styleReset = '{/cyan-bg}{/black-fg}{/cyan-fg}';

  const setActiveTab = (tab: TuiScreenId) => {
    tabs.setContent(
      TAB_ORDER.map((id) => {
        const label = ` ${tabLabelById[id]} `;
        if (id === tab) {
          return `${activeTabStyle}${label}${styleReset}`;
        }
        return `${inactiveTabStyle}${label}${styleReset}`;
      }).join(' ')
    );
  };

  const setPulsePhase = (phase: number) => {
    const pulse = options.motionEnabled ? pulseChar(phase) : '•';
    const content = footer.getContent();
    footer.setContent(` ${pulse}${content.slice(2)}`);
  };

  setActiveTab('setup');

  return {
    header,
    tabs,
    body,
    footer,
    help,
    setActiveTab,
    setPulsePhase
  };
}
