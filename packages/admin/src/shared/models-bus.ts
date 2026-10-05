'use client'

import { createVersionBus } from './version-bus'

/**
 * "Models registry changed" signal — bumped by the `models:changed` WS frame
 * (hub provider yamls installed into / removed from `~/.halo/global/models.d/`)
 * and on WS reconnect (a frame lost while the socket was down). Everything
 * that fetched `/agent-configs/models` or the settings schema re-fetches.
 */
const bus = createVersionBus()
export const useModelsBus = bus.useBus
export const bumpModelsBus = bus.bump
