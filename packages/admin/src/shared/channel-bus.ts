'use client'

import { createVersionBus } from './version-bus'

/**
 * "Channel data changed / please reload" signal. The Channels sidebar fires
 * this when the user clicks refresh; whichever channel page is currently
 * mounted (wechat / telegram / web) re-fetches its account list.
 */
const bus = createVersionBus()
export const useChannelBus = bus.useBus
export const bumpChannelBus = bus.bump
