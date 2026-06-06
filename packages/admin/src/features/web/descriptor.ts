import { Globe } from 'lucide-react'
import type { AdminChannelDescriptor } from '@/features/channels/registry'
import { WebSettings } from './web-settings'

export const webAdminDescriptor: AdminChannelDescriptor = {
  id: 'web_demo',
  label: 'Web',
  Icon: Globe,
  Component: WebSettings,
}
