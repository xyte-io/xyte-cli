import { describe, expect, it, vi } from 'vitest';

import { resolveTicketWithGuard } from '../../src/tui/screens/tickets';
import { sceneFromTicketsState } from '../../src/tui/scene';

describe('tickets screen write guard', () => {
  it('asks for confirmation before resolving ticket', async () => {
    const markResolved = vi.fn().mockResolvedValue({ ok: true });
    const context: any = {
      client: {
        organization: {
          markResolved
        },
        partner: {
          closeTicket: vi.fn()
        }
      },
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(false),
      setStatus: vi.fn(),
      showError: vi.fn()
    };

    const result = await resolveTicketWithGuard({
      ticket: { id: 't-1', status: 'open' },
      mode: 'organization',
      context
    });

    expect(result).toBe(false);
    expect(context.confirmWrite).toHaveBeenCalledWith('Resolve ticket', 'resolve');
    expect(markResolved).not.toHaveBeenCalled();
    expect(context.setStatus).toHaveBeenCalledWith('Resolve action canceled.');
  });

  it('resolves organization ticket after confirmation', async () => {
    const markResolved = vi.fn().mockResolvedValue({ ok: true });
    const context: any = {
      client: {
        organization: { markResolved },
        partner: { closeTicket: vi.fn() }
      },
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn(),
      showError: vi.fn()
    };

    const result = await resolveTicketWithGuard({
      ticket: { id: 't-1' },
      mode: 'organization',
      context
    });

    expect(result).toBe(true);
    expect(markResolved).toHaveBeenCalledWith({
      tenantId: 'acme',
      path: { ticket_id: 't-1' }
    });
    expect(context.setStatus).toHaveBeenCalledWith('Resolving ticket...');
    expect(context.setStatus).toHaveBeenCalledWith('Ticket t-1 resolved.');
  });

  it('resolves partner ticket after confirmation', async () => {
    const closeTicket = vi.fn().mockResolvedValue({ ok: true });
    const context: any = {
      client: {
        organization: { markResolved: vi.fn() },
        partner: { closeTicket }
      },
      getActiveTenantId: vi.fn().mockResolvedValue('partner-tenant'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn(),
      showError: vi.fn()
    };

    const result = await resolveTicketWithGuard({
      ticket: { _id: 'p-55' },
      mode: 'partner',
      context
    });

    expect(result).toBe(true);
    expect(closeTicket).toHaveBeenCalledWith({
      tenantId: 'partner-tenant',
      path: { ticket_id: 'p-55' }
    });
  });

  it('does not attempt resolve when ticket id is missing', async () => {
    const markResolved = vi.fn().mockResolvedValue({ ok: true });
    const context: any = {
      client: {
        organization: { markResolved },
        partner: { closeTicket: vi.fn() }
      },
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn(),
      showError: vi.fn()
    };

    const result = await resolveTicketWithGuard({
      ticket: { status: 'open' },
      mode: 'organization',
      context
    });

    expect(result).toBe(false);
    expect(markResolved).not.toHaveBeenCalled();
    expect(context.setStatus).toHaveBeenCalledWith('Selected ticket has no id.');
  });

  it('renders ticket detail safely for cyclic payloads', () => {
    const ticket: any = { id: 't-1', status: 'open', subject: 'Help' };
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
