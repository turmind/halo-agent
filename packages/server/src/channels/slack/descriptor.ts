import type { ServerChannelDescriptor } from '../registry.js'
import { startSlackChannel, type SlackChannel } from './handler.js'
import { createSlackRoutes } from '../../routes/slack.js'
import { registerSlackCronDispatcher } from './cron-dispatcher.js'

export const slackDescriptor: ServerChannelDescriptor<SlackChannel> = {
  channelType: 'slack',
  start: (deps) => startSlackChannel(deps),
  routes: (deps) => createSlackRoutes(deps),
  shutdown: (channel) => channel.stopAll(),
  registerCronDispatcher: () => registerSlackCronDispatcher(),
}
