import type { NamespaceCall, XyteCallArgs } from '../types/client';

export interface OrganizationNamespace {
  cancelCommand: NamespaceCall;
  getCommands: NamespaceCall;
  sendCommand: NamespaceCall;
  claimDevice: NamespaceCall;
  deleteDevice: NamespaceCall;
  getDevice: NamespaceCall;
  getDevices: NamespaceCall;
  getHistories: NamespaceCall;
  updateDevice: NamespaceCall;
  getOrganizationInfo: NamespaceCall;
  getIncidents: NamespaceCall;
  createSpace: NamespaceCall;
  deleteSpace: NamespaceCall;
  findOrCreateSpace: NamespaceCall;
  getSpace: NamespaceCall;
  getSpaces: NamespaceCall;
  updateSpace: NamespaceCall;
  getTicket: NamespaceCall;
  getTickets: NamespaceCall;
  markResolved: NamespaceCall;
  sendMessage: NamespaceCall;
  updateTicket: NamespaceCall;
}

export function createOrganizationNamespace(call: (endpointKey: string, args?: XyteCallArgs) => Promise<unknown>): OrganizationNamespace {
  return {
    cancelCommand: (args) => call('organization.commands.cancelCommand', args),
    getCommands: (args) => call('organization.commands.getCommands', args),
    sendCommand: (args) => call('organization.commands.sendCommand', args),
    claimDevice: (args) => call('organization.devices.claimDevice', args),
    deleteDevice: (args) => call('organization.devices.deleteDevice', args),
    getDevice: (args) => call('organization.devices.getDevice', args),
    getDevices: (args) => call('organization.devices.getDevices', args),
    getHistories: (args) => call('organization.devices.getHistories', args),
    updateDevice: (args) => call('organization.devices.updateDevice', args),
    getOrganizationInfo: (args) => call('organization.getOrganizationInfo', args),
    getIncidents: (args) => call('organization.incidents.getIncidents', args),
    createSpace: (args) => call('organization.spaces.createSpace', args),
    deleteSpace: (args) => call('organization.spaces.deleteSpace', args),
    findOrCreateSpace: (args) => call('organization.spaces.findOrCreateSpace', args),
    getSpace: (args) => call('organization.spaces.getSpace', args),
    getSpaces: (args) => call('organization.spaces.getSpaces', args),
    updateSpace: (args) => call('organization.spaces.updateSpace', args),
    getTicket: (args) => call('organization.tickets.getTicket', args),
    getTickets: (args) => call('organization.tickets.getTickets', args),
    markResolved: (args) => call('organization.tickets.markResolved', args),
    sendMessage: (args) => call('organization.tickets.sendMessage', args),
    updateTicket: (args) => call('organization.tickets.updateTicket', args)
  };
}
