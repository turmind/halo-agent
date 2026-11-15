# Admin UI style layer

`general.ui_style` (`modern` default / `soft` / `classic`) restyles the admin's shape, spacing and type size without touching colors — it is orthogonal to `general.theme`. User-facing behavior: [requirements/settings.md](../requirements/settings.md) (General → UI style).

## How a style reaches the DOM

- `<html data-ui-style="modern|soft">`. **classic is the absence of the attribute**, so every style rule (all scoped under `[data-ui-style]`) misses and the original look renders untouched. An unset or unknown value maps to `modern`.
- Three writers keep it in sync, all mapping "unset → modern, only an explicit `classic` removes the attribute":
  - `app/layout.tsx` anti-flash inline script — reads the `halo_ui_style` localStorage cache before first paint;
  - `shared/theme/context.tsx` `applyUiStyle()` — on mount from the cache, then `refreshFromServer()` reads `general.ui_style` (value → schema default → `modern`) and rewrites the cache; the settings page calls `refreshFromServer()` after every save;
  - the schema default in `packages/server/src/settings-schema.ts` (`default: 'modern'`), which is what `refreshFromServer` sees when the key is unset.

## How the CSS works (`app/globals.css`, "UI style" block)

Call sites hardcode Tailwind classes (~600 of them), so the layer can't swap class names. Three mechanisms instead:

1. **Theme variables.** In Tailwind v4, `rounded-md/lg/xl/2xl` and `text-xs/sm` compile to `var(--radius-*)` / `var(--text-*)`; each style redefines those on `<html>`, which restyles every such call site with no TSX change.
2. **Literal utilities.** Bare `rounded` (`@theme inline` → `.25rem`) and arbitrary `text-[9px|10px|11px]` compile to constants, so they are overridden by class selector (unlayered rules beat `@layer utilities` at equal specificity).
3. **`data-ui` hooks** on containers — attributes only, no class or DOM-structure change, so classic is unaffected:

| Hook | Where | What the style does |
|---|---|---|
| `shell` / `activity` / `icon` / `main` / `nav` / `gap` / `card` / `dock` | `workspace-layout.tsx`, `quick-toggles.tsx` (`icon`) | backdrop, floating cards, gaps instead of 1px dividers, sidebars on the backdrop (their root's bg / `border-r` and header bars' `border-b` cleared). Activity buttons are inset 4px a side, so the `icon` slot shrinks to `3rem - 8px` and the bar drops its border width: icon, highlight and the 48px bar share one centre line, collapsed or with the drawer open |
| `main` / `nav` / `gap` / `card` | `agent-management-main.tsx`, `settings-main.tsx` | pages that lay out their own list + content (Agents, Settings): the outer layout card turns transparent and the page's own nav / card take the backdrop / card look |
| `editor` / `bar` / `tree` | `editor-panel.tsx` (also embedded as the Skills / agent edit view), `source-control-main.tsx` (diff), `skills-main.tsx` (extension skill view) | editor card on the Monaco surface (`--ui-editor-surface`: `#1e1e1e` on dark = vs-dark, `--background` on the others — `--background` is re-pointed inside the card so previews follow); the file tree is a tinted side column with no divider |
| `strip` | header / footer strips of main areas (agent editor toolbar, Settings section bar, session viewer, cron / evolution detail, cron form, channel account list, diff header) | no hard rule, card surface |
| `bottom` / `bar` / `chat` / `side` / `tabs` / `floating` | bottom panel, chat / terminal panels, tab bar, resizable sidebar, floating panel | one card for bar + chat + session column, pill tabs |
| `row` + `data-active` | sidebar list rows (file tree, sessions, change tree, commit files, channels, skills, agents, cron, evolution, Settings nav, extension skill files) | inset rounded rows, selection = `--ui-nav-active` block |
| `menu` | context menus, dropdowns, pickers | rounded, inset items |
| `dialog` | modal panels (folder / file pickers, credentials, account form, cron log, models sync, download, the chat bar's camera / capture pickers) | card radius |
| `pin` | sticky chat cards in `message-list.tsx` (sub-session report, compact summary, pinned user message) | inset rounded card |
| `exchange` / `attach` | `message-list.tsx`: one turn's root row (`ExchangeRow`) / the image or media attachment row under a user message | their full-width `border-b` goes transparent — a gap between turns instead of a line running past the inset `pin` cards |

`data-active` is set only where the component already knows the row is selected (`isActive || undefined`); classic CSS never reads it.

Remaining class-string selectors, each commented in place: `.uppercase[class*="tracking-wide"][class*="text-[var(--muted-foreground)]"]` (ALL-CAPS section labels → sentence case; a label pattern across ~20 call sites, not a container — a drifted label just stays ALL-CAPS), `[data-ui="bar"] button.rounded` (icon buttons in bars), and `input` / `select` `:is(.rounded, .rounded-md, .rounded-lg)` (only fully-rounded fields become pills).

Not styleable: `confirmAction()` uses the native `window.confirm` (or the desktop shell's `haloConfirm`), so that one dialog keeps the OS look in every style.

## Invariants

- **classic = pixel-identical to the pre-style admin.** Any change here must keep a classic screenshot diff at 0 px against the previous build (dark + light, zh + en) — new hooks are attributes only, and new rules stay under `[data-ui-style]`.
- **Colors come from the active theme's variables** (`color-mix` of `--muted` / `--border` / `--background` / `--foreground`), never a per-style palette; the only literal is `#1e1e1e`, which mirrors Monaco's built-in vs-dark background.
- Extensions are not told the style — the `themeVars` bridge forwards palette tokens only ([canvas-extensions.md](canvas-extensions.md)).
