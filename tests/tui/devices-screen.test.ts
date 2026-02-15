import { describe, expect, it } from 'vitest';

import { sceneFromDevicesState } from '../../src/tui/scene';

describe('devices screen rendering', () => {
  it('renders device detail safely for cyclic payloads', () => {
    const device: any = { id: 'dev-1', name: 'Display', status: 'online' };
    device.self = device;

    const panels = sceneFromDevicesState({
      searchText: '',
      selectedIndex: 0,
      devices: [device]
    });
    const detailPanel = panels.find((panel) => panel.id === 'devices-detail');
    const lines = detailPanel?.text?.lines ?? [];

    expect(lines.join('\n')).toContain('[Circular]');
  });
});
