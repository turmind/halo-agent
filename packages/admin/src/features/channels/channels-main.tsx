'use client'

import { useChannelStore } from './channel-store'
import { defaultAdminChannelDescriptors } from './descriptors'

export function ChannelsMain() {
  const active = useChannelStore((s) => s.active)
  const descriptor = defaultAdminChannelDescriptors.find((d) => d.id === active)
  if (!descriptor) return null
  const Component = descriptor.Component
  return <Component />
}
