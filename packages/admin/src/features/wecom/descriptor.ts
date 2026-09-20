import { Briefcase } from 'lucide-react'
import type { AdminChannelDescriptor } from '@/features/channels/registry'
import { WecomSettings } from './wecom-settings'

export const wecomAdminDescriptor: AdminChannelDescriptor = {
  id: 'wecom',
  // Brand name — same in every locale, no i18n key needed.
  label: 'WeCom',
  Icon: Briefcase,
  Component: WecomSettings,
}
