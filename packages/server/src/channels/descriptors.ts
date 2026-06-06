/**
 * Default set of channel descriptors. `index.ts` imports this list and
 * passes it to `bootChannels(...)`. Adding a new channel = add one
 * import + one entry here; nothing else in core changes.
 */
import type { ServerChannelDescriptor } from './registry.js'
import { telegramDescriptor } from './telegram/descriptor.js'
import { wechatDescriptor } from './wechat/descriptor.js'
import { webDescriptor } from './web/descriptor.js'
import { slackDescriptor } from './slack/descriptor.js'
import { feishuDescriptor } from './feishu/descriptor.js'

export const defaultChannelDescriptors: ReadonlyArray<ServerChannelDescriptor<unknown>> = [
  wechatDescriptor,
  telegramDescriptor,
  webDescriptor,
  slackDescriptor,
  feishuDescriptor,
]
