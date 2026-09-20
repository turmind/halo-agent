import type { ServerChannelDescriptor } from '../registry.js'
import { startWecomChannel, type WecomChannel } from './handler.js'
import { createWecomRoutes } from '../../routes/wecom.js'
import { registerWecomCronDispatcher } from './cron-dispatcher.js'

export const wecomDescriptor: ServerChannelDescriptor<WecomChannel> = {
  channelType: 'wecom',
  start: (deps) => startWecomChannel(deps),
  routes: (deps) => createWecomRoutes(deps),
  shutdown: (channel) => channel.stopAll(),
  registerCronDispatcher: () => registerWecomCronDispatcher(),
}
