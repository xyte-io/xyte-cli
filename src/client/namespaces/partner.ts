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
    getOrganizations: (args) => call('partner.organizations.getOrganizations', args),
    addOrganizationTag: (args) => call('partner.organizationTags.addOrganizationTag', args),
    removeOrganizationTag: (args) => call('partner.organizationTags.removeOrganizationTag', args),
    updateOrganizationTag: (args) => call('partner.organizationTags.updateOrganizationTag', args),
    getOrganizationTags: (args) => call('partner.organizationTags.getOrganizationTags', args),
    createCoupon: (args) => call('partner.coupons.createCoupon', args),
    getCoupons: (args) => call('partner.coupons.getCoupons', args),
    updateCoupon: (args) => call('partner.coupons.updateCoupon', args),
    deleteCoupon: (args) => call('partner.coupons.deleteCoupon', args),
    getStoreListings: (args) => call('partner.storeListings.getStoreListings', args),
    getStoreListing: (args) => call('partner.storeListings.getStoreListing', args),
    getStoreSettings: (args) => call('partner.storeSettings.getStoreSettings', args),
    getOrders: (args) => call('partner.orders.getOrders', args),
    getOrder: (args) => call('partner.orders.getOrder', args),
    approveOrder: (args) => call('partner.orders.approveOrder', args),
    getPayments: (args) => call('partner.payments.getPayments', args),
    getPayment: (args) => call('partner.payments.getPayment', args),
    getSubscriptions: (args) => call('partner.subscriptions.getSubscriptions', args),
    getSubscription: (args) => call('partner.subscriptions.getSubscription', args),
    getSubscriptionInvoiceItems: (args) => call('partner.subscriptions.getSubscriptionInvoiceItems', args),
    getProducts: (args) => call('partner.products.getProducts', args),
    getProduct: (args) => call('partner.products.getProduct', args),
    getSoldProducts: (args) => call('partner.soldProducts.getSoldProducts', args),
    getSoldProduct: (args) => call('partner.soldProducts.getSoldProduct', args),
    addComment: (args) => call('partner.tickets.addComment', args),
    closeTicket: (args) => call('partner.tickets.closeTicket', args),
    getTicket: (args) => call('partner.tickets.getTicket', args),
    getTickets: (args) => call('partner.tickets.getTickets', args),
    updateTicket: (args) => call('partner.tickets.updateTicket', args)
  };
}
