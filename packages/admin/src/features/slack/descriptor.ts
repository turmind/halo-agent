import { Hash } from 'lucide-react'
import type { AdminChannelDescriptor } from '@/features/channels/registry'
import { SlackSettings } from './slack-settings'

export const slackAdminDescriptor: AdminChannelDescriptor = {
  id: 'slack',
  // Brand name — same in every locale, no i18n key needed.
  label: 'Slack',
  Icon: Hash,
  Component: SlackSettings,
}
