import type {
  ExtensionCapability, ExtensionClientFrame, ExtensionHostFrame, ExtensionInfo, ExtensionLang, ExtensionPlatform, ExtensionTheme, ExtensionThemeVars,
} from '@turmind/halo-core/protocol'
import { EXTENSION_PROTOCOL_VERSION } from '@turmind/halo-core/protocol'

/**
 * Protocol brain of an extension's activity-bar page (manifest `activity`),
 * free of React and I/O like extension-host-logic.ts: each entry point takes
 * the state plus one input and returns the next state and the effects
 * `extension-activity-panel.tsx` carries out. The page has no file, so the
 * host speaks a subset of protocol v1: `ready` → `init` (`view: 'activity'`),
 * `error` → banner, `theme` / `lang` on change; everything file-shaped
 * (`dirty` / `save` / `fs` / `pick` / `export`) is ignored with a warning.
 */

export interface ActivityState {
  /** Extension sent `ready`; nothing is posted before that. */
  ready: boolean
}

export interface ActivityContext {
  capabilities: ExtensionCapability[]
  theme: ExtensionTheme
  themeVars: ExtensionThemeVars
  platform: ExtensionPlatform
  lang: ExtensionLang
}

export type ActivityEffect =
  | { type: 'post'; frame: ExtensionHostFrame }
  /** First (or repeated) `ready`: stop the unresponsive timer, drop the overlay. */
  | { type: 'ready' }
  /** Show above the iframe. */
  | { type: 'error'; message: string }
  /** Extension-author mistake: console only. */
  | { type: 'warn'; message: string }

export interface ActivityStep {
  state: ActivityState
  effects: ActivityEffect[]
}

export function initialActivityState(): ActivityState {
  return { ready: false }
}

/** What the page host grants: `media` (the iframe's `allow`) and `transcribe`
 *  (the server's cookie-gated WS proxy) work without a file; `save` / `fs-read`
 *  need the file host's frames, which this host doesn't answer. */
export function activityCapabilities(declared: readonly ExtensionCapability[]): ExtensionCapability[] {
  return declared.filter((c) => c === 'media' || c === 'transcribe')
}

export function onActivityFrame(state: ActivityState, frame: ExtensionClientFrame, ctx: ActivityContext): ActivityStep {
  switch (frame.type) {
    case 'ready': {
      // A second `ready` = the page reloaded itself; it holds nothing, so it
      // gets init again.
      const init: ActivityEffect = {
        type: 'post',
        frame: {
          haloExt: 1, type: 'init', view: 'activity', protocol: EXTENSION_PROTOCOL_VERSION, capabilities: ctx.capabilities,
          theme: ctx.theme, themeVars: ctx.themeVars, platform: ctx.platform, lang: ctx.lang,
        },
      }
      return { state: { ...state, ready: true }, effects: [{ type: 'ready' }, init] }
    }
    case 'error':
      return { state, effects: [{ type: 'error', message: frame.message }] }
    default:
      return { state, effects: [{ type: 'warn', message: `${frame.type} frame ignored on an activity page` }] }
  }
}

export function onActivityThemeChange(state: ActivityState, theme: ExtensionTheme, themeVars: ExtensionThemeVars): ActivityStep {
  if (!state.ready) return { state, effects: [] }
  return { state, effects: [{ type: 'post', frame: { haloExt: 1, type: 'theme', theme, themeVars } }] }
}

export function onActivityLangChange(state: ActivityState, lang: ExtensionLang): ActivityStep {
  if (!state.ready) return { state, effects: [] }
  return { state, effects: [{ type: 'post', frame: { haloExt: 1, type: 'lang', lang } }] }
}

/** Button title: zh `title_zh` → `title` → `name`; en `title` → `name`. */
export function activityTitle(info: ExtensionInfo, lang: ExtensionLang): string {
  const a = info.activity
  return (lang === 'zh' ? a?.title_zh : undefined) ?? a?.title ?? info.name
}

/** Hover-drawer line: zh `description_zh` → `description` → top-level
 *  `description` → ''; en skips the `_zh`. */
export function activityDescription(info: ExtensionInfo, lang: ExtensionLang): string {
  const a = info.activity
  return (lang === 'zh' ? a?.description_zh : undefined) ?? a?.description ?? info.description ?? ''
}

/** Activity-bar tab id of an extension page; persisted in `halo_sidebar_tab`. */
export const ACTIVITY_TAB_PREFIX = 'ext:'
export type ActivityTabId = `${typeof ACTIVITY_TAB_PREFIX}${string}`

export function activityTabId(id: string): ActivityTabId {
  return `${ACTIVITY_TAB_PREFIX}${id}`
}

export function isActivityTabId(tab: string): tab is ActivityTabId {
  return tab.startsWith(ACTIVITY_TAB_PREFIX)
}
