/** Set by the authenticated phone host before mounting the shared app. */
export const isRemoteClient = (): boolean => document.documentElement.dataset.remoteClient === 'true'
