import type { NamespaceCall, XyteCallArgs } from '../types/client';

export interface DeviceNamespace {
  getCommand: NamespaceCall;
  getCommandsWithChildren: NamespaceCall;
  updateCommand: NamespaceCall;
  getConfig: NamespaceCall;
  setConfig: NamespaceCall;
  getDeviceInfo: NamespaceCall;
  getSpaceInfo: NamespaceCall;
  setCloudSettings: (args: XyteCallArgs & { body: { property: string; value: unknown } | Record<string, unknown> }) => Promise<unknown>;
  updateDevice: NamespaceCall;
  addEvent: NamespaceCall;
  appendDumpFile: NamespaceCall;
  sendDump: NamespaceCall;
  closeIncident: NamespaceCall;
  closeIncidents: NamespaceCall;
  getIncidents: NamespaceCall;
  openIncident: NamespaceCall;
  getLicense: NamespaceCall;
  updateLicense: NamespaceCall;
  bulkRegisterDevice: NamespaceCall;
  deleteDevice: NamespaceCall;
  getChildDevices: NamespaceCall;
  registerChildDevice: NamespaceCall;
  registerDevice: NamespaceCall;
  getFile: NamespaceCall;
  getFiles: NamespaceCall;
  sendChildTelemetry: NamespaceCall;
  sendMassTelemetry: NamespaceCall;
  sendTelemetry: NamespaceCall;
}

export function createDeviceNamespace(call: (endpointKey: string, args?: XyteCallArgs) => Promise<unknown>): DeviceNamespace {
  return {
    getCommand: (args) => call('device.command.getCommand', args),
    getCommandsWithChildren: (args) => call('device.command.getCommandsWithChildren', args),
    updateCommand: (args) => call('device.command.updateCommand', args),
    getConfig: (args) => call('device.configuration.getConfig', args),
    setConfig: (args) => call('device.configuration.setConfig', args),
    getDeviceInfo: (args) => call('device.device-info.getDeviceInfo', args),
    getSpaceInfo: (args) => call('device.device-info.getSpaceInfo', args),
    setCloudSettings: (args) => call('device.device-info.setCloudSettings', args),
    updateDevice: (args) => call('device.device-info.updateDevice', args),
    addEvent: (args) => call('device.events.addEvent', args),
    appendDumpFile: (args) => call('device.file-dumps.appendDumpFile', args),
    sendDump: (args) => call('device.file-dumps.sendDump', args),
    closeIncident: (args) => call('device.incidents.closeIncident', args),
    closeIncidents: (args) => call('device.incidents.closeIncidents', args),
    getIncidents: (args) => call('device.incidents.getIncidents', args),
    openIncident: (args) => call('device.incidents.openIncident', args),
    getLicense: (args) => call('device.license.getLicense', args),
    updateLicense: (args) => call('device.license.updateLicense', args),
    bulkRegisterDevice: (args) => call('device.registration.bulkRegisterDevice', args),
    deleteDevice: (args) => call('device.registration.deleteDevice', args),
    getChildDevices: (args) => call('device.registration.getChildDevices', args),
    registerChildDevice: (args) => call('device.registration.registerChildDevice', args),
    registerDevice: (args) => call('device.registration.registerDevice', args),
    getFile: (args) => call('device.remote-files.getFile', args),
    getFiles: (args) => call('device.remote-files.getFiles', args),
    sendChildTelemetry: (args) => call('device.telemetries.sendChildTelemetry', args),
    sendMassTelemetry: (args) => call('device.telemetries.sendMassTelemetry', args),
    sendTelemetry: (args) => call('device.telemetries.sendTelemetry', args)
  };
}
