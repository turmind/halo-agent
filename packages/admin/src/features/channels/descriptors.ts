/**
 * Default set of admin channel descriptors. Sidebar + main pane both
 * iterate this list. Adding a new channel = add one import + one entry.
 *
 * Order here is the order the sidebar renders.
 */
import type { AdminChannelDescriptor } from './registry'
import { wechatAdminDescriptor } from '@/features/wechat/descriptor'
import { telegramAdminDescriptor } from '@/features/telegram/descriptor'
import { webAdminDescriptor } from '@/features/web/descriptor'
import { slackAdminDescriptor } from '@/features/slack/descriptor'
import { feishuAdminDescriptor } from '@/features/feishu/descriptor'
import { wecomAdminDescriptor } from '@/features/wecom/descriptor'

export const defaultAdminChannelDescriptors: ReadonlyArray<AdminChannelDescriptor> = [
  wechatAdminDescriptor,
  telegramAdminDescriptor,
  webAdminDescriptor,
  slackAdminDescriptor,
  feishuAdminDescriptor,
  wecomAdminDescriptor,
]
