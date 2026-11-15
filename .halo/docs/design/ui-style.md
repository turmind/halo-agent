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

## Phone layout

User-facing behavior: [requirements/mobile.md](../requirements/mobile.md). The phone layout is a separate shell plus one CSS section. It is not a fourth style, and it applies under all three styles.

**Gate.** `MOBILE_QUERY` in `shared/use-is-mobile.ts` = `'(max-width: 767px), (pointer: coarse) and (max-height: 500px)'`. The phone `@media` block in `app/globals.css` uses **the same string, so keep the two in sync**: if the JS and CSS disagree, the phone CSS lands on the desktop tree, or the phone shell renders without its CSS. The landscape clause exists because a phone turned sideways (844×390) would otherwise cross 768px and swap in the desktop tree, remounting every canvas viewer (a game mid-play included). `useIsMobile()` is a `useSyncExternalStore` over one `matchMedia`, so the switch is live.

**Shell.** When `useIsMobile()` is true, `workspace-layout.tsx` returns `MobileShell` (`features/workspace/mobile-shell.tsx`) instead of the desktop tree:

- Bottom nav of chat / files / sessions / more; the canvas is a view under files. The current view is in `localStorage` `halo_mobile_view`, and a maximized canvas restores onto the canvas.
- More lists the remaining activity entries (extension pages included), Terminal and the quick toggles. `halo:navigate` events map onto these tabs.
- The one `BottomPanel` portals into `data-m="slot"` like into any other host, and `data-bottom=chat|terminal` picks the pane. The desktop split / floating / maximized prefs stay in the store, and the slot CSS shows a single pane.
- Long press: after `LONG_PRESS_MS` (500 ms) without moving, a synthetic `contextmenu` is dispatched on the target, because iOS never fires one. The click that ends the press is swallowed.
- Keyboard: `visualViewport` writes `--m-vt` / `--m-vh` on `<html>`, and the shell is `fixed` at that offset and height, so the composer stays above the keyboard.
- `layout.tsx` sets `viewport-fit=cover`, and the CSS pads the safe areas.

**Hooks.** These are attributes only, like `data-ui`. The rules live solely inside the phone `@media` block, so at ≥ 768px nothing matches and the desktop renders pixel-identical (classic 0 px, modern / soft unchanged).

| Hook | Where | What the phone CSS does |
|---|---|---|
| `data-m="shell"` | `MobileShell` root | fixed to the visual viewport; scope for the overflow rules below |
| `data-m="top"` / `"nav"` | shell top bar / bottom nav | safe-area padding; both hidden while a viewer is immersive |
| `data-m="slot"` + `data-bottom` | chat / terminal host | hides the panel's desktop bar, the chat session column and the split divider; shows the one pane full size; composer icon buttons 40px, textarea ≤ 30dvh |
| `data-m="list"` / `"detail"` + `data-m-pane="list\|detail"` | `Panes` wrapper (Sessions, More pages) | one of the two visible. A row turning `data-active` inside the list moves to detail. Agents / Settings, which lay out their own `data-ui` `main` > `nav` + `card`, get the same two levels from the same attribute |
| `data-m="canvas"` | files → canvas view | hides the editor's own title bar (the shell's top bar names the file) |
| `data-m-page` | each More page's wrapper (value = the entry id) | no rule targets it; it names the mounted page |

Beyond the hooks, the block re-proportions shared pieces. Type steps go up (`--text-xs` 13px, `--text-sm` 15px), cards are flat and edge to edge (`--ui-card-radius` / `--ui-gap` 0), rows are ≥ 40px and fields 16px (no iOS focus zoom). `[data-ui="dialog"]` becomes a bottom sheet, as do menus opened at the pointer (`[data-ui="menu"][style*="top"]`); anchored dropdowns keep their place.

**Overflow rules** ("nothing scrolls sideways"), scoped to `:is([data-m="shell"], [data-ui="dialog"])`:

- **Text and containers.** `overflow-wrap: anywhere` on the shell and dialogs. Page containers get `min-width: 0; max-width: 100%`, as does every flex / grid child except svg. `.overflow-y-auto` gets `overflow-x: hidden`: `overflow-y: auto` silently computes overflow-x to `auto` as well, and a grid `1fr` is `minmax(auto, 1fr)`, which won't shrink below its content. Together those turned page containers into horizontal scrollers. `pre` gets `max-width: 100%`, `.prose table` becomes a block with its own `overflow-x: auto`, and `shrink-0` spans in wrapping rows may shrink.
- **Forms.** `.grid[class*="grid-cols-"]` (except `grid-cols-[repeat…]`) becomes two `minmax(0, 1fr)` columns, and a grid holding a text input, select or textarea becomes one column. Combobox's inline `min-width` goes to 0. `textarea.font-mono` is 13px, or 16px on iOS (`@supports (-webkit-touch-callout: none)`).
- **Wrapping.** `strip`s and `justify-between` / `items-baseline` rows may wrap, `h-10` / `h-9` strips get `height: auto`, and a report header row wraps while its title stays on one line.
- **One scroller per detail.** A `[data-m="detail"]` that is a fixed header + a `flex-1 overflow-y-auto` body (cron, evolution) scrolls as one column. A form with a `border-t` footer (the cron form's Save) is excluded and keeps the footer pinned.

**Regression check.** A local regression script (Playwright + Chromium, kept in the developer's scratch dir and not in the repo) loads every page at phone widths against a running server and checks:

- document width, and elements sticking out of the shell;
- fields inside the viewport and not overlapping;
- bubbles not overflowing;
- no container scrolling sideways (`scrollLeft`);
- text crushed into a vertical column;
- children spilling over their parent.

It exits 1 on any failure. Run it as `node scan.mjs --w=360,390 --base=<server url> --ws=<workspace path> [--shots=<dir>] [--only=<page,…>] [--css=<file>]` (`--css` injects candidate rules without a build), and run it before and after any change to the phone block. A desktop screenshot diff (≥ 768px, all three styles) must stay at 0 px for classic and show no change for modern / soft.

## Invariants

- **classic = pixel-identical to the pre-style admin.** Any change here must keep a classic screenshot diff at 0 px against the previous build (dark + light, zh + en) — new hooks are attributes only, and new rules stay under `[data-ui-style]`.
- **Colors come from the active theme's variables** (`color-mix` of `--muted` / `--border` / `--background` / `--foreground`), never a per-style palette; the only literal is `#1e1e1e`, which mirrors Monaco's built-in vs-dark background.
- Extensions are not told the style — the `themeVars` bridge forwards palette tokens only ([canvas-extensions.md](canvas-extensions.md)).
