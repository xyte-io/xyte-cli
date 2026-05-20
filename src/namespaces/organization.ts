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
  moveDevice: NamespaceCall;
  resumeIncidents: NamespaceCall;
  suspendIncidents: NamespaceCall;
  updateDevice: NamespaceCall;
  getClaimStatus: NamespaceCall;
  getPingStatus: NamespaceCall;
  listEdges: NamespaceCall;
  startClaim: NamespaceCall;
  startPing: NamespaceCall;
  addExternalUserToGroup: NamespaceCall;
  addUsersToGroup: NamespaceCall;
  createGroup: NamespaceCall;
  deleteGroup: NamespaceCall;
  getGroup: NamespaceCall;
  listGroups: NamespaceCall;
  removeUsersFromGroup: NamespaceCall;
  updateGroup: NamespaceCall;
  deleteIncident: NamespaceCall;
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
  createUser: NamespaceCall;
  deactivateUser: NamespaceCall;
  getUser: NamespaceCall;
  listUsers: NamespaceCall;
  resendWelcome: NamespaceCall;
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
    moveDevice: (args) => call('organization.devices.moveDevice', args),
    resumeIncidents: (args) => call('organization.devices.resumeIncidents', args),
    suspendIncidents: (args) => call('organization.devices.suspendIncidents', args),
    updateDevice: (args) => call('organization.devices.updateDevice', args),
    getClaimStatus: (args) => call('organization.edges.getClaimStatus', args),
    getPingStatus: (args) => call('organization.edges.getPingStatus', args),
    listEdges: (args) => call('organization.edges.listEdges', args),
    startClaim: (args) => call('organization.edges.startClaim', args),
    startPing: (args) => call('organization.edges.startPing', args),
    addExternalUserToGroup: (args) => call('organization.groups.addExternalUser', args),
    addUsersToGroup: (args) => call('organization.groups.addUsers', args),
    createGroup: (args) => call('organization.groups.createGroup', args),
    deleteGroup: (args) => call('organization.groups.deleteGroup', args),
    getGroup: (args) => call('organization.groups.getGroup', args),
    listGroups: (args) => call('organization.groups.listGroups', args),
    removeUsersFromGroup: (args) => call('organization.groups.removeUsers', args),
    updateGroup: (args) => call('organization.groups.updateGroup', args),
    deleteIncident: (args) => call('organization.incidents.deleteIncident', args),
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
    updateTicket: (args) => call('organization.tickets.updateTicket', args),
    createUser: (args) => call('organization.users.createUser', args),
    deactivateUser: (args) => call('organization.users.deactivateUser', args),
    getUser: (args) => call('organization.users.getUser', args),
    listUsers: (args) => call('organization.users.listUsers', args),
    resendWelcome: (args) => call('organization.users.resendWelcome', args)
  };
}
