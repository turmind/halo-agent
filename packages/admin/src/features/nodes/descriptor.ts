import { Laptop } from 'lucide-react'
import type { AdminChannelDescriptor } from '@/features/channels/registry'
import { NodeSettings } from './node-settings'

export const nodesAdminDescriptor: AdminChannelDescriptor = {
  id: 'nodes',
  label: 'channels.nodes',
  Icon: Laptop,
  Component: NodeSettings,
}
