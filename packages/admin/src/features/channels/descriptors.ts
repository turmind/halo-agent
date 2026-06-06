/**
 * Default set of admin channel descriptors. Sidebar + main pane both
 * iterate this list. Adding a new channel = add one import + one entry.
 *
 * Order here is the order the sidebar renders.
 */
import type { AdminChannelDescriptor } from './registry'
import { weixinAdminDescriptor } from '@/features/weixin/descriptor'
import { telegramAdminDescriptor } from '@/features/telegram/descriptor'
import { webAdminDescriptor } from '@/features/web/descriptor'
import { slackAdminDescriptor } from '@/features/slack/descriptor'
import { feishuAdminDescriptor } from '@/features/feishu/descriptor'

export const defaultAdminChannelDescriptors: ReadonlyArray<AdminChannelDescriptor> = [
  weixinAdminDescriptor,
  telegramAdminDescriptor,
  webAdminDescriptor,
  slackAdminDescriptor,
  feishuAdminDescriptor,
]
