import type { PartnerNamespace, XyteCallArgs } from '../../types/client';

export function createPartnerNamespace(
  call: (endpointKey: string, args?: XyteCallArgs) => Promise<unknown>
): PartnerNamespace {
  return {
    deleteDevice: (args) => call('partner.devices.deleteDevice', args),
    getCommands: (args) => call('partner.devices.getCommands', args),
    getConfiguration: (args) => call('partner.devices.getConfiguration', args),
    getDeviceInfo: (args) => call('partner.devices.getDeviceInfo', args),
    getDevices: (args) => call('partner.devices.getDevices', args),
    getStateHistory: (args) => call('partner.devices.getStateHistory', args),
    getStateHistoryMultiDevices: (args) => call('partner.devices.getStateHistoryMultiDevices', args),
    getTelemetries: (args) => call('partner.devices.getTelemetries', args),
    createOrganization: (args) => call('partner.organizations.createOrganization', args),
    addComment: (args) => call('partner.tickets.addComment', args),
    closeTicket: (args) => call('partner.tickets.closeTicket', args),
    getTicket: (args) => call('partner.tickets.getTicket', args),
    getTickets: (args) => call('partner.tickets.getTickets', args),
    updateTicket: (args) => call('partner.tickets.updateTicket', args)
  };
}
