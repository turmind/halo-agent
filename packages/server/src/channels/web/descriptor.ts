import type { ServerChannelDescriptor } from '../registry.js'
import { createWebChannel, type WebChannel } from './handler.js'
import { createWebRoutes } from '../../routes/web.js'

export const webDescriptor: ServerChannelDescriptor<WebChannel> = {
  channelType: 'web',
  start: (deps) => createWebChannel(deps),
  routes: (deps) => createWebRoutes(deps),
  // Web channel is reactive (SSE per-request), no long-running runners
  // to drain. The cron dispatcher registry deliberately omits a 'web'
  // entry — cron has nowhere to push to over SSE; jobs targeting web
  // record a clear "web channel does not support cron broadcast" error.
}
