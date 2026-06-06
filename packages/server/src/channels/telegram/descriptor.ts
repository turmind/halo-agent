import type { ServerChannelDescriptor } from '../registry.js'
import { startTelegramChannel, type TelegramChannel } from './handler.js'
import { createTelegramRoutes } from '../../routes/telegram.js'
import { registerTelegramCronDispatcher } from './cron-dispatcher.js'

export const telegramDescriptor: ServerChannelDescriptor<TelegramChannel> = {
  channelType: 'telegram',
  start: (deps) => startTelegramChannel(deps),
  routes: (deps) => createTelegramRoutes(deps),
  shutdown: (channel) => channel.stopAll(),
  registerCronDispatcher: () => registerTelegramCronDispatcher(),
}
