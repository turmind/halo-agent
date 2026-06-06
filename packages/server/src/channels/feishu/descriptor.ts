import type { ServerChannelDescriptor } from '../registry.js'
import { startFeishuChannel, type FeishuChannel } from './handler.js'
import { createFeishuRoutes } from '../../routes/feishu.js'
import { registerFeishuCronDispatcher } from './cron-dispatcher.js'

export const feishuDescriptor: ServerChannelDescriptor<FeishuChannel> = {
  channelType: 'feishu',
  start: (deps) => startFeishuChannel(deps),
  routes: (deps) => createFeishuRoutes(deps),
  shutdown: (channel) => channel.stopAll(),
  registerCronDispatcher: () => registerFeishuCronDispatcher(),
}
