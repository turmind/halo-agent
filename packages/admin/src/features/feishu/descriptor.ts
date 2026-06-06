import { Building2 } from 'lucide-react'
import type { AdminChannelDescriptor } from '@/features/channels/registry'
import { FeishuSettings } from './feishu-settings'

export const feishuAdminDescriptor: AdminChannelDescriptor = {
  id: 'feishu',
  // Brand name — same in every locale, no i18n key needed.
  label: 'Feishu',
  Icon: Building2,
  Component: FeishuSettings,
}
