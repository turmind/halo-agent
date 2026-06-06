import { Send } from 'lucide-react'
import type { AdminChannelDescriptor } from '@/features/channels/registry'
import { TelegramSettings } from './telegram-settings'

export const telegramAdminDescriptor: AdminChannelDescriptor = {
  id: 'telegram',
  // Brand name — same in every locale, no i18n key needed.
  label: 'Telegram',
  Icon: Send,
  Component: TelegramSettings,
}
