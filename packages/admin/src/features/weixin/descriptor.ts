import { MessageCircle } from 'lucide-react'
import type { AdminChannelDescriptor } from '@/features/channels/registry'
import { WeixinSettings } from './weixin-settings'

export const weixinAdminDescriptor: AdminChannelDescriptor = {
  id: 'weixin',
  label: 'channels.weixin',  // resolved via useT() in the sidebar
  Icon: MessageCircle,
  Component: WeixinSettings,
}
