import { describe, expect, it, vi } from 'vitest';

import { markTicketResolvedWithGuard, sendTicketMessageWithGuard } from '../../src/tui/screens/tickets';
import { sceneFromTicketsState } from '../../src/tui/scene';
import { makeTuiContext, makeXyteClientMock } from '../support/typed-mocks';

describe('tickets screen write guard', () => {
  it('asks for confirmation before resolving ticket', async () => {
    const markResolved = vi.fn().mockResolvedValue({ ok: true });
    const confirmWrite = vi.fn().mockResolvedValue(false);
    const setStatus = vi.fn();
    const context = makeTuiContext({
      client: makeXyteClientMock({ organization: { markResolved } }),
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite,
      setStatus,
      showError: vi.fn()
    });

    const result = await markTicketResolvedWithGuard({
      ticket: { id: 't-1', status: 'open' },
      mode: 'organization',
      context
    });

    expect(result).toBe(false);
    expect(confirmWrite).toHaveBeenCalledWith('Resolve ticket', 'resolve');
    expect(markResolved).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith('Resolve action canceled.');
  });

  it('resolves organization ticket after confirmation', async () => {
    const markResolved = vi.fn().mockResolvedValue({ ok: true });
    const setStatus = vi.fn();
    const context = makeTuiContext({
      client: makeXyteClientMock({ organization: { markResolved } }),
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus,
      showError: vi.fn()
    });

    const result = await markTicketResolvedWithGuard({
      ticket: { id: 't-1' },
      mode: 'organization',
      context
    });

    expect(result).toBe(true);
    expect(markResolved).toHaveBeenCalledWith({
      tenantId: 'acme',
      path: { ticket_id: 't-1' }
    });
    expect(setStatus).toHaveBeenCalledWith('Resolving ticket...');
    expect(setStatus).toHaveBeenCalledWith('Ticket t-1 resolved.');
  });

  it('blocks resolve in partner mode by policy', async () => {
    const markResolved = vi.fn();
    const setStatus = vi.fn();
    const context = makeTuiContext({
      client: makeXyteClientMock({ organization: { markResolved } }),
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus,
      showError: vi.fn()
    });

    const result = await markTicketResolvedWithGuard({
      ticket: { id: 't-1' },
      mode: 'partner',
      context
    });

    expect(result).toBe(false);
    expect(markResolved).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith(
      'Ticket write actions are disabled in partner mode (organization-only policy).'
    );
  });

  it('does not attempt resolve when ticket id is missing', async () => {
    const markResolved = vi.fn().mockResolvedValue({ ok: true });
    const setStatus = vi.fn();
    const context = makeTuiContext({
      client: makeXyteClientMock({ organization: { markResolved } }),
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus,
      showError: vi.fn()
    });

    const result = await markTicketResolvedWithGuard({
      ticket: { status: 'open' },
      mode: 'organization',
      context
    });

    expect(result).toBe(false);
    expect(markResolved).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith('Selected ticket has no id.');
  });

  it('sends ticket message after confirmation', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const context = makeTuiContext({
      client: makeXyteClientMock({ organization: { sendMessage } }),
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn(),
      showError: vi.fn()
    });

    const result = await sendTicketMessageWithGuard({
      ticket: { id: 't-1' },
      mode: 'organization',
      message: 'hello',
      context
    });

    expect(result).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith({
      tenantId: 'acme',
      path: { ticket_id: 't-1' },
      query: { message: 'hello' }
    });
  });

  it('requires non-empty message', async () => {
    const sendMessage = vi.fn();
    const setStatus = vi.fn();
    const context = makeTuiContext({
      client: makeXyteClientMock({ organization: { sendMessage } }),
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus,
      showError: vi.fn()
    });

    const result = await sendTicketMessageWithGuard({
      ticket: { id: 't-1' },
      mode: 'organization',
      message: '   ',
      context
    });

    expect(result).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith('Message is required.');
  });

  it('renders ticket detail safely for cyclic payloads', () => {
    const ticket: Record<string, unknown> = { id: 't-1', status: 'open', subject: 'Help' };
    ticket.self = ticket;

    const panels = sceneFromTicketsState({
      mode: 'organization',
      searchText: '',
      selectedIndex: 0,
      tickets: [ticket]
    });
    const detailPanel = panels.find((panel) => panel.id === 'tickets-detail');
    const lines = detailPanel?.text?.lines ?? [];

    expect(lines.join('\n')).toContain('[Circular]');
  });
});
