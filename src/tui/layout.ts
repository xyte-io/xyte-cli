import blessed from 'blessed';

import { pulseChar } from './animation';
import type { TuiScreenId } from './types';
import { TAB_ORDER } from './tabs';

export interface TuiLayout {
  header: blessed.Widgets.BoxElement;
  tabs: blessed.Widgets.BoxElement;
  body: blessed.Widgets.BoxElement;
  footer: blessed.Widgets.BoxElement;
  help: blessed.Widgets.BoxElement;
  setActiveTab(tab: TuiScreenId): void;
  setPulsePhase(phase: number): void;
}

export interface TuiLayoutOptions {
  motionEnabled: boolean;
}

export function createLayout(screen: blessed.Widgets.Screen, options: TuiLayoutOptions): TuiLayout {
  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: ' XYTE SDK TUI // RETRO-CONSOLE ',
    style: {
      fg: 'black',
      bg: 'yellow',
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
      fg: 'yellow',
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
    content: ' @ Ready ',
    style: {
      fg: 'yellow',
      bg: 'black'
    }
  });

  const help = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: ' u setup | g config | d/s/v/i/t/p screens | r refresh | / search | o provider | ? help | q quit ',
    style: {
      fg: 'white',
      bg: 'black'
    }
  });

  const setActiveTab = (tab: TuiScreenId) => {
    tabs.setContent(
      TAB_ORDER.map((id) => {
        const label = ` ${id.toUpperCase()} `;
        if (id === tab) {
          return `{black-fg}{yellow-bg}${label}{/yellow-bg}{/black-fg}`;
        }
        return `{yellow-fg}${label}{/yellow-fg}`;
      }).join(' ')
    );
  };

  const setPulsePhase = (phase: number) => {
    const pulse = options.motionEnabled ? pulseChar(phase) : '@';
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
