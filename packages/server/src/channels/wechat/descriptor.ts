import type { ServerChannelDescriptor } from '../registry.js'
import { startWeixinChannel, type WeixinChannel } from './handler.js'
import { createWeixinRoutes } from '../../routes/weixin.js'
import { registerWechatCronDispatcher } from './cron-dispatcher.js'

export const wechatDescriptor: ServerChannelDescriptor<WeixinChannel> = {
  channelType: 'wechat',
  start: (deps) => startWeixinChannel(deps),
  routes: (deps) => createWeixinRoutes(deps),
  shutdown: (channel) => channel.stopAll(),
  registerCronDispatcher: () => registerWechatCronDispatcher(),
}
