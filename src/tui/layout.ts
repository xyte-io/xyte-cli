import blessed from 'blessed';

import { pulseChar } from './animation';
import type { TuiScreenId } from './types';
import { TAB_ORDER } from './tabs';

interface TuiLayout {
  header: blessed.Widgets.BoxElement;
  tabs: blessed.Widgets.BoxElement;
  route: blessed.Widgets.BoxElement;
  body: blessed.Widgets.BoxElement;
  footer: blessed.Widgets.BoxElement;
  help: blessed.Widgets.BoxElement;
  setHeaderTitle(title: string): void;
  setRouteText(text: string): void;
  setFooterText(text: string): void;
  setHelpText(text: string): void;
  setActiveTab(tab: TuiScreenId): void;
  setPulsePhase(phase: number): void;
}

interface TuiLayoutOptions {
  motionEnabled: boolean;
}

const TAB_LABELS: Record<TuiScreenId, string> = {
  setup: 'Setup',
  config: 'Config',
  dashboard: 'Dashboard',
  spaces: 'Spaces',
  devices: 'Devices',
  incidents: 'Incidents',
  tickets: 'Tickets'
};

export function createLayout(screen: blessed.Widgets.Screen, options: TuiLayoutOptions): TuiLayout {
  let footerBaseText = 'Ready';

  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: ' XYTE CLI | OPERATIONS CONSOLE ',
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
      fg: 'white',
      bg: 'black'
    }
  });

  const body = blessed.box({
    parent: screen,
    top: 3,
    left: 0,
    width: '100%',
    height: '100%-5',
    border: 'line',
    style: {
      border: {
        fg: 'blue'
      }
    }
  });

  const route = blessed.box({
    parent: screen,
    top: 2,
    left: 0,
    width: '100%',
    height: 1,
    content: ' Route: Home ',
    style: {
      fg: 'cyan',
      bg: 'black'
    }
  });

  const footer = blessed.box({
    parent: screen,
    bottom: 1,
    left: 0,
    width: '100%',
    height: 1,
    content: ' Ready ',
    style: {
      fg: 'white',
      bg: 'black'
    }
  });

  const help = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: ' Tab/Shift+Tab screens | 1-7 jump | arrows panes | Enter inspect | a actions | f filters | ? help | q quit ',
    style: {
      fg: 'cyan',
      bg: 'black'
    }
  });

  const setHeaderTitle = (title: string) => {
    header.setContent(` XYTE CLI | ${title.toUpperCase()} `);
  };

  const setFooterText = (text: string) => {
    footerBaseText = text;
    footer.setContent(` ${footerBaseText} `);
  };

  const setRouteText = (text: string) => {
    route.setContent(` Route: ${text} `);
  };

  const setHelpText = (text: string) => {
    help.setContent(` ${text} `);
  };

  const setActiveTab = (tab: TuiScreenId) => {
    tabs.setContent(
      TAB_ORDER.map((id, index) => {
        const label = ` ${index + 1} ${TAB_LABELS[id].toUpperCase()} `;
        if (id === tab) {
          return `{white-fg}{blue-bg}${label}{/blue-bg}{/white-fg}`;
        }
        return `{white-fg}${label}{/white-fg}`;
      }).join(' ')
    );
  };

  const setPulsePhase = (phase: number) => {
    const pulse = options.motionEnabled ? pulseChar(phase) : '@';
    footer.setContent(` ${pulse} ${footerBaseText} `);
  };

  setActiveTab('setup');

  return {
    header,
    tabs,
    route,
    body,
    footer,
    help,
    setHeaderTitle,
    setRouteText,
    setFooterText,
    setHelpText,
    setActiveTab,
    setPulsePhase
  };
}
