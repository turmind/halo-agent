---
name: Canvas PPTX
description: Create, edit, and inspect PowerPoint (.pptx) files. Supports building from scratch (pptxgenjs, JavaScript), generating from an existing .pptx template (python-pptx), and editing existing decks (patch + python-pptx). Halo-adapted port of Anthropic's canvas_pptx 2.0.0.
---
# Canvas PPTX (Halo port)

> **Important:** this skill came from Anthropic's own sandbox (`run_python` / `run_javascript` / `artifacts/` / `pptx_plan` etc.). The original sandbox-specific workflow doesn't apply here. The SKILL.md below replaces those steps. The reference docs (`creation.md` / `editing.md` / `template.md`) still describe the underlying APIs accurately and are reused as-is.

## Pick one of three workflows

| Situation | Workflow | Tools |
|---|---|---|
| Build a deck from scratch, no .pptx template | **Creation** | Node.js + `pptxgenjs` |
| Have a .pptx to use as a visual template, swap content | **Template** | Python 3 + `python-pptx` |
| Have a .pptx, change a few slides / a few text items | **Editing** | Python 3 + `python-pptx` + `pptx_edit.py` |

**How to decide**: is there a .pptx in the workspace, and does the user want to "use it as a sample" or "change it"? If a .pptx is present, **never take the Creation path** — you'll lose the template's visual design.

> **⚠️ Template path has serious limits** (lessons from a real OpenClaw deck):
> - The clone routine copies the template's native XML (with nested group / groupShape / spPr) verbatim.
> - **The patch system can't pierce a Group to edit inner txBody** — a group containing a 200-cell table forces a downgrade.
> - Cloned single-page slide XML can balloon from a healthy 8–15 KB to 900 KB+; if PowerPoint trips on the group transform matrix it shows "needs repair".
> - **Conclusion**: when the template has nested groups holding big tables / SmartArt / complex Master, Creation is more stable. Use Template only when the user-supplied visual is too rich to recreate AND they accept that table content can't be edited.
> - v1 vs v2 receipt: v1 Template clone → 6 of 25 slides triggered a "PowerPoint needs to repair" prompt; v2 Creation from scratch → 25 slides clean on first run, every slide xml 8–15 KB.

## Step 0 — One-time setup per workspace

```bash
# Python side (needed for Editing / Template)
python3 -c "import pptx" || pip install python-pptx pillow pandas matplotlib

# Node side (needed for Creation)
cd <workspace_root>
[ -f package.json ] || npm init -y
npm ls pptxgenjs >/dev/null 2>&1 || npm install pptxgenjs
# Only when you actually need react-icons SVG icons (slow, install on demand):
# npm install react react-dom react-icons
```

Run these via `shell_exec`. Both pip and npm work in this workspace — don't overthink it. One install is enough; it persists across sessions and restarts.

## Step 1 — Outline first, **align with the user before writing code**

A PPT isn't a chat reply. Before any code, confirm these (this is a **mandatory rule from INSTRUCTIONS.md**):

1. **Audience** — BD / engineering / executives? Depth varies a lot.
2. **Length** — 30 / 45 / 60 minutes; sets page count (≈ 1 page per minute).
3. **Angle** — architectural reasoning / war-stories / decomposition / mixed.
4. **Demo intensity** — Mermaid only / screenshots / live demo.
5. **Palette + typography** — let the user pick from [Color Palettes](#color-palettes), or supply their own.

**Output**: write the outline (page #, title, key bullets, intended figures/charts) to `deck/outline.md`. **Wait for the user to say "go" in chat before writing any code.** Don't `npm install` and start `.js` files until they confirm the outline.

## Step 1.5 — Write SPEC.md for precise specs (**strongly recommended for complex decks**)

**Lesson learned**: this workspace's v1 went the Template-clone route and **was abandoned** — the cloned slides contained a nested-group table the patch system couldn't reach, and XML bloat made PowerPoint refuse to open. The v2 redo wrote an exact `SPEC.md` first and then asked the agent to implement it with pptxgenjs — 25 slides on the first try.

A `SPEC.md` (`deck/SPEC.md`) should contain:

1. **Global constants**
   - `COLORS` palette (10+ entries with semantic names: `text_primary` / `accent1` / `card_bg` …)
   - `FONTS` (title font / body font + size scale)

2. **Shared helper functions** (signatures or pseudocode — let the agent fill them in)
   - `addFooter(slide, pageNum)` — uniform footer
   - `addPageHeader(slide, title, subtitle)` — title + decorative line
   - `addCardGrid(slide, cards, cols)` — N-card grid
   - `addKPI(slide, value, label, x, y)` — large number
   - `addCompareTable(slide, headers, rows)` — 2- or 3-column comparison
   - `addBigCenter(slide, text, color)` — centered hero text (pull-quote / divider)

3. **Per-slide spec** (one section per slide; copy the format)
   - Page # + slide type (cover / content / divider / pull-quote / closing)
   - Which helper to use (or "custom")
   - Title / subtitle / card content / KPI numbers / table rows — **give the full text, not placeholders**
   - Key coordinates and font sizes (only for slides where that matters; common slides delegate to the helper)
   - **Speaker notes**: 80–200 chars per slide, bullet-style "what to say + transition to the next slide"

**Why the extra step**:
- Agents (even Opus-xhigh) tend to "improvise" when writing decks. SPEC pins down everything that mustn't be improvised, leaving the agent only the visual judgement.
- When something fails, you can diff against SPEC to see what wasn't implemented.
- Iterations rewrite SPEC and re-run; no need to realign every time.

**How detailed should SPEC be**: a 25-page BD-grade deck takes ~500–600 lines of SPEC.md. Too short forces the agent to guess; too long is wasted effort — only nail down what the agent shouldn't decide on its own (copy, numbers, key layout). Visual nuance (card spacing, micro font tweaks) stays the agent's call.

## Step 2 — Creation: build from scratch (pptxgenjs)

### 2.1 File path conventions (**different from upstream docs**)

| Type | Where |
|---|---|
| Your `.js` template code | `deck/<name>_template.js` (note: `deck/`, not `artifacts/`) |
| Final `.pptx` output | `deck/<name>.pptx` |
| Temporary SVG icons | `deck/icons/icon_<id>.svg` |
| Source data (notes / JSON / CSV) | existing dirs like `notes/`, `processed/` |

`pres.writeFile({ fileName: 'deck/xxx.pptx' })` — use a **path relative to the workspace root**.

### 2.2 Halo-recommended flow (replaces the upstream "Session Tab Live Preview Workflow")

The original SKILL.md tells you to write in 4 layers and watch the sidebar live-preview. **Halo doesn't have that sidebar**, but the layered approach still helps **code readability** and **later edits**. Optional.

**Simplified (recommended — write it in one pass)**
1. `file_read('.halo/skills/canvas-pptx/docs/creation.md')` for the API reference.
2. (Optional but strongly recommended) `file_read('deck/SPEC.md')` to internalize the precise spec.
3. `file_write('deck/<name>_build.js', <full code>)` — write the entire script:
   - Define `COLORS` / `FONTS` constants at the top.
   - Implement helpers (`addPageHeader` / `addCardGrid` / `addKPI` …).
   - One builder function per slide; **end each with `slide.addNotes(...)` for speaker notes**.
4. `shell_exec('cd <workspace> && node deck/<name>_build.js')` to produce the `.pptx`.
5. **Visual self-check** (Step 5) — PDF intermediate + screenshot + OCR fallback.
6. Hand the `.pptx` to the user via the `send-file` skill.

**Layered version (only for genuinely complex decks)**: write in layers + multiple `file_edit` passes. See the "template file pattern" at the top of `docs/creation.md`. Without live preview the only benefit is easier debugging when a layer breaks.

### 2.3 Critical pitfalls (**read these before writing code, otherwise the file will be corrupt**)

> **v2 engineer's note**: before you touch the keyboard, read the **17 Common Pitfalls at the bottom of `docs/creation.md`** (10 minutes). The debugging time you save is 10x. v2 succeeded on the first run mostly because those 17 items had been read in advance.

The five most important to internalize right now:

1. **NEVER prefix hex colors with `#`** — `'FF0000'` is correct, `'#FF0000'` corrupts the file.
2. **NEVER reuse option objects** — pptxgenjs mutates them in place (pt → EMU); the second use sees the wrong values. Use a factory: `const makeShadow = () => ({...});`.
3. **NEVER call `writeFile()` twice** — the second call double-converts units; blur becomes 967740000 and PowerPoint says "needs repair". Write once, fix and re-run.
4. **NEVER encode opacity in the hex string** — `'00000020'` corrupts the file; use `opacity: 0.12`.
5. **For bullets, use `bullet: true`, not the `'•'` character** — the latter renders a double bullet.

### 2.3.1 Extra v2 pitfalls (not in the upstream 17 but I hit them)

**Use string shape names, not `pres.shapes.X` constants**
- Strings: `'rect'` / `'roundRect'` / `'ellipse'` / `'rightArrow'` / `'downArrow'` / `'line'`.
- The constants `pres.shapes.RECTANGLE` aren't accessible from a top-level helper unless you pass `pres` in. String names mean helpers don't need `pres` at all — much cleaner.

**Don't try to use Group**
- pptxgenjs doesn't support shape grouping (pitfall 11).
- For a "container card + three boxes + kernel + host OS + labels" stack, draw bottom-up with separate `addShape` calls and manage z-order manually (background card first, then the stack, then text).
- Cost: page code grows from 50 to 100+ lines, but XML stays clean.

**`valign` is `'middle'`, not `'center'`**
- `align: 'center'` — horizontal center.
- `valign: 'middle'` — vertical center.
- `valign: 'center'` silently falls back to `top` — no error, just visually wrong.

**`margin: 0` must be explicit**
- pptxgenjs adds 4–6 pt default padding to text boxes. Tight layouts need `margin: 0` or text drifts inward.

**Use rich-text arrays, not `\n`**
- For bold + body mixed runs (e.g. emphasizing one symbol in a sentence) use the rich-text array form. `\n` drops paragraph properties.

**Per-cell table borders**
- Whole-table border: `border: { pt: 1, color: COLORS.divider }`.
- One cell's top edge highlighted (e.g. green accent under a "✅ Suitable" header): use the per-cell `border: [top, right, bottom, left]` array form, with `null` to skip an edge.

**Emojis go in literally**
- pptxgenjs accepts unicode emoji directly, no escapes.
- `'🦞 What is OpenClaw'`, `'⚠️ Technical warning'` — write as-is.
- **OCR caveat**: when LibreOffice renders emojis, the colors shift; OCR may decode `🦞` as `¥` or some Han glyph — that's the fallback font, not the real render. **Don't trust OCR alone for emojis** — use `view_image` for confirmation.

**Don't embed `.ttf` fonts; rely on fallback**
- Specify a font like `Amazon Ember Display`. If the Linux server doesn't have it, it falls back to Liberation Sans / Noto Sans CJK and Chinese still renders fine.
- Users on macOS without that font fall back to Helvetica / Arial Black — perfectly readable for BD audiences.
- **Never embed `.ttf` in the script** — pushes file size into MBs, and PowerPoint may not honor it anyway.

**`writeFile` with workspace-root-relative paths**
- ✅ `pres.writeFile({ fileName: 'deck/output.pptx' })` and run `node deck/build.js` from the workspace root.
- ❌ Don't build absolute paths via `__dirname` — pptxgenjs sometimes treats `/` paths oddly and ends up at `/output.pptx`, which is unwritable.

### 2.3.2 Container-size formulas (**stop estimating heights**)

War story: v1 of the technical deck broke on slides P2/P3/P23 because heights were eyeballed. Root cause: pptxgenjs's imperative API forces every textbox to declare `x/y/w/h`. Bump the font size (80pt → 100pt → 120pt) or change the wording (2 lines → 3 lines) and the eyeballed height is wrong.

**Mandatory formula** (paste at the top of every `build.js`):

```js
// Line height (inches) = fontSize_pt × 1.2 / 72
function lineHeightIn(fontPt) {
  return fontPt * 1.2 / 72;
}

// Chinese bullet text actual line-height factor ≈ 1.4 (CJK ascender taller than ASCII)
// Large value containers (>= 60pt) factor ≈ 1.7 (ascender + descender > 1.5 × fontSize)
const LH_CN_BULLET = 1.4;
const LH_BIG_VALUE = 1.7;

function minBoxHIn(fontPt, lines, paddingIn) {
  paddingIn = (paddingIn === undefined) ? 0.15 : paddingIn;
  return Math.max(lines, 1) * lineHeightIn(fontPt) + paddingIn;
}
```

**Font size → minimum container height** (essential for `valign:middle` at large sizes):

| fontSize | 1.2 factor (ASCII) | 1.4 factor (CJK bullet) | 1.7 factor (large value box) |
|---:|---:|---:|---:|
| 11pt | 0.18" | 0.21" | — |
| 14pt | 0.23" | 0.27" | — |
| 18pt | 0.30" | 0.42" | — |
| 32pt | 0.53" | — | — |
| 60pt | — | — | 1.70" |
| 80pt | — | — | 2.27" |
| 100pt | — | — | 2.83" |
| 120pt | — | — | 3.40" |

**Helper enforcement principle** (avoid callers mis-counting "2 lines vs 3 lines"):

Bundle "easily-decoupled element pairs" into a helper that computes its own height. Callers pass content + `x/y/w` only, **never `h`**:

```js
// ✅ Caller passes content + start + width; height is derived from font size
addBigStat(slide, '54-86%', 'savings vs long-running EC2', 0.5, 1.9, 5.5,
  { valueSize: 90, labelSize: 16 });

// ❌ Caller passes h — change a font or a line and it falls apart
addBigStat(slide, '54-86%', '...', 0.5, 1.9, 5.5, 1.2 /* eyeballed h */);
```

**Visual-center alignment trick** (fixes "circled-number + label" misalignment, e.g. ① above its caption):

For "big top + small bottom centered" composites — **don't draw two independent textboxes**:
- Each textbox does its own `valign:middle`; visual centroid depends on its own content; even if `x`/`w` match, the result looks off.
- Solution: **one rich-text container**, set `valign:middle` on the whole thing, let PowerPoint compute the centroid by paragraphs.

```js
// ✅ Rich-text in a single container
slide.addText([
  { text: '①', options: { fontSize: 80, color: COLORS.accent1, breakLine: true }},
  { text: 'Where the agent paradigm', options: { fontSize: 14, breakLine: true }},
  { text: 'stands today',           options: { fontSize: 14 }}
], { x, y, w, h: totalH, align: 'center', valign: 'middle', margin: 0 });
```

Detailed retro: `.halo/memory/2026-05-09-pptxgenjs-sizing.md` (workspace memory, not shipped with this skill).

### 2.4 Halo-tool ↔ Anthropic-tool mapping (when reading upstream docs)

| What the upstream doc says | What you do in Halo |
|---|---|
| `run_javascript(file='artifacts/foo.js')` | `shell_exec('cd <workspace> && node deck/foo.js')` |
| `run_python(file='...')` | `shell_exec('cd <workspace> && python3 ...')` |
| `file_write('artifacts/...')` | `file_write('deck/...')` |
| `pptx_plan(...)` | Just chat with the user about `outline.md` |
| `open_in_session_tab(...)` | Use the `send-file` skill to push the .pptx to the user |
| `read_binary_docs(...)` | Use the `markitdown` CLI or `python-pptx` directly — **that helper module isn't available** |

## Step 3 — Template: use an existing .pptx as a sample

See `docs/template.md` and the "Template-Based Creation" section of `docs/editing.md`. In Halo:

```bash
# Inspect the template — what layouts / placeholders does it have? (CLI provided)
cd <workspace>
python3 .halo/skills/canvas-pptx/scripts/pptx_inspect.py path/to/template.pptx
# Get a starter patch with the exact shape names
python3 .halo/skills/canvas-pptx/scripts/pptx_inspect.py --edit-patch path/to/template.pptx
```

Then write **your own** Python script (don't put it in `scripts/`; use `deck/build_<name>.py`) that calls `apply_edit_patch`:

```python
# deck/build_xxx.py
import sys, os
sys.path.insert(0, os.path.join(os.environ.get('WORKSPACE_ROOT', '.'),
                                '.halo/skills/canvas-pptx/scripts'))
from pptx_edit import apply_edit_patch

patch = {
  "clone_slides": [
    {"insert_at": 1, "clone_from": 1,
     "content": {"TextBox 3": "New title", "TextBox 5": "Subtitle"}},
    # ...
  ],
  "structure": {"delete_slides": [1, 2, 3]}  # remove the original template slides
}
apply_edit_patch('sources/decks/template.pptx', patch, 'deck/output.pptx')
```

Run: `shell_exec('cd <workspace> && WORKSPACE_ROOT=$(pwd) python3 deck/build_xxx.py')`.

## Step 4 — Editing: change a few slides in an existing .pptx

See the "Editing Workflow" section of `docs/editing.md`. Same pattern: inspect → write a patch → apply:

```bash
cd <workspace>
python3 .halo/skills/canvas-pptx/scripts/pptx_inspect.py --edit-patch path/to/file.pptx
# Read the output, copy out shape names
```

Then write the change patch and run `apply_edit_patch`.

## Step 5 — Visual self-check (**LibreOffice and pdftoppm are available in Halo — use them**)

> ⚠️ The upstream Anthropic doc says "no LibreOffice / pdftoppm in the sandbox, skip post-save QA". **Halo has both** — for any deck of 25 slides or more, an actual visual pass catches overflow / bleeding / palette mistakes the formulas can miss.

### 5.1 File-level validation (do first, ~30s)

```bash
cd <workspace>
ls -la deck/<name>.pptx                                  # > 0 bytes
unzip -t deck/<name>.pptx | tail -3                      # archive integrity
SLIDES=$(unzip -l deck/<name>.pptx | grep -E "slide[0-9]+\.xml$" | wc -l)
NOTES=$(unzip -l deck/<name>.pptx | grep -E "notesSlide[0-9]+\.xml$" | wc -l)
echo "Slides: $SLIDES (expect N), Notes: $NOTES (expect N)"

# Sample slide XML sizes; > 50KB usually means a hidden group/big-table
# (the v1-failure tell)
for n in $(seq 1 25); do
  size=$(unzip -p deck/<name>.pptx ppt/slides/slide$n.xml | wc -c)
  echo "slide$n.xml: $size bytes"
done | sort -t: -k2 -n -r | head -5
# v2 healthy: 8–15 KB per slide; v1 sick: a single slide at 900 KB+
```

### 5.2 Render preview (via PDF)

**Don't `libreoffice --convert-to png` directly** — that exports only the first page; PNG is a single-image format. **Go via PDF**:

```bash
mkdir -p deck/_preview
libreoffice --headless --convert-to pdf --outdir deck/_preview deck/<name>.pptx
pdftoppm -png -r 100 deck/_preview/<name>.pdf deck/_preview/page
ls deck/_preview/page-*.png | wc -l    # should match the slide count
```

`-r 100` = 100 DPI; each PNG is 50–120 KB (well under the `view_image` 5 MB ceiling). Use `-r 150` for sharper, but file sizes climb to 300 KB+.

### 5.3 OCR fallback (**`view_image` parallel calls have a cache-mismatch trap**)

Real bug: when calling `view_image` in parallel for `page-01/02/03`, the **echoed image can be misaligned** — the caller "sees page-02" but it's actually `page-04`. `md5sum` confirms the files are different on disk, but `view_image` has some internal caching that swaps them.

**Defenses**: call `view_image` **one at a time, serially**. In parallel, run OCR pixel-to-text directly — no `view_image` middleman:

```bash
# Crop each title region, invert + scale, OCR
python3 << 'EOF'
from PIL import Image, ImageOps
for n in range(1, 26):
    img = Image.open(f'deck/_preview/page-{n:02d}.png').convert('L')
    crop = ImageOps.invert(img.crop((20, 20, img.width-20, 130)))
    crop.resize((crop.width*2, crop.height*2)).save(f'deck/_preview/title-{n:02d}.png')
EOF

# Tesseract chi_sim+eng on each title
for n in $(seq -w 1 25); do
  echo -n "page-$n: "
  tesseract deck/_preview/title-$n.png - -l chi_sim+eng --psm 6 2>/dev/null | head -1
done
```

That prints 25 titles you can diff against `SPEC.md`. More trustworthy than `view_image` for this — pixels go straight to text, no tooling layer in between.

**Emoji OCR misreads**: `🦞` may be decoded as `¥` or as a CJK character; `✅` / `❌` with VS-16 selectors can decode wrong. When OCR shows something fishy, **fall back to a single `view_image` call** to confirm — don't over-trust OCR.

### 5.4 Full self-check pipeline (copy-paste for a 25-page deck)

```bash
cd <workspace>

# 1. Build
node deck/build.js || { echo "❌ build failed"; exit 1; }

# 2. File-level validation (see 5.1)
unzip -t deck/<name>.pptx | tail -3

# 3. Render preview (see 5.2)
mkdir -p deck/_preview
libreoffice --headless --convert-to pdf --outdir deck/_preview deck/<name>.pptx
pdftoppm -png -r 100 deck/_preview/<name>.pdf deck/_preview/page

# 4. OCR title sample (see 5.3)

# 5. view_image the key pages (cover / dividers / pull-quotes / closing
#    + a handful of content pages), one at a time.
```

## Step 6 — Ship it

1. Use the **`send-file` skill** to push `deck/<name>.pptx` to the user.
2. Report any visual issues your self-check found (overflow / bleed / wrong palette) so the user can decide: iterate or accept.

---

## Resource Files

Browse `docs/` for the full API reference (**don't read everything every time — grep for what you need**):

| File | When to read | Contents |
|---|---|---|
| `base.md` | For general design principles, palette tables, font tables, common pitfalls | Anthropic's original `base.md` |
| `docs/creation.md` | Creation workflow | pptxgenjs API (~28 KB; for writing code, read setup + the section you need) |
| `docs/editing.md` | Template or Editing workflow | python-pptx + patch JSON format |
| `docs/template.md` | Template workflow (deeper dive) | python-pptx template-reuse details |
| `scripts/pptx_inspect.py` | Inspect templates / produce starter patches | CLI: `python3 ... path/to.pptx [--edit-patch]` |
| `scripts/pptx_edit.py` | Apply patches | Imported as a Python module; not used as a CLI directly |

**Narrow the conversation to one or two sections, then `file_read` just that part** — reading the full ~70 KB is wasted context.

## Color Palettes (lifted from `base.md`; this is the most-used part)

| Theme | Primary | Secondary | Accent |
|---|---|---|---|
| **Midnight Executive** | `1E2761` (navy) | `CADCFC` (ice blue) | `FFFFFF` (white) |
| **Forest & Moss** | `2C5F2D` (forest) | `97BC62` (moss) | `F5F5F5` (cream) |
| **Coral Energy** | `F96167` (coral) | `F9E795` (gold) | `2F3C7E` (navy) |
| **Warm Terracotta** | `B85042` (terracotta) | `E7E8D1` (sand) | `A7BEAE` (sage) |
| **Ocean Gradient** | `065A82` (deep blue) | `1C7293` (teal) | `21295C` (midnight) |
| **Charcoal Minimal** | `36454F` (charcoal) | `F2F2F2` (off-white) | `212121` (black) |
| **Teal Trust** | `028090` (teal) | `00A896` (seafoam) | `02C39A` (mint) |
| **Berry & Cream** | `6D2E46` (berry) | `A26769` (dusty rose) | `ECE2D0` (cream) |
| **Sage Calm** | `84B59F` (sage) | `69A297` (eucalyptus) | `50808E` (slate) |
| **Cherry Bold** | `990011` (cherry) | `FCF6F5` (off-white) | `2F3C7E` (navy) |

**For AWS-themed projects** (added here, not in upstream `base.md`):

| Theme | Primary | Secondary | Accent |
|---|---|---|---|
| **AWS Squid** | `232F3E` (deep blue) | `FF9900` (orange) | `FFFFFF` |
| **AWS Smile** | `FF9900` (orange) | `232F3E` (deep blue) | `F2F4F7` (light gray) |
| **OpenClaw Lobster** | `B43838` (lobster red) | `F4E4C1` (shell beige) | `2C3E50` (deep ocean blue) |

---

## Engineer Retro: 25-page BD deck, one-shot success

> Distilled from the v2 OpenClaw on AWS BD deck (25 slides, succeeded on first run). Non-obvious lessons that actually paid off.

### How detailed should `SPEC.md` be?

**Most useful fields**:
- Per-slide field name + full final copy (zero cognitive load — agent doesn't pick wording).
- Coordinates + font sizes (locks 25-page visual consistency: every page header at the same position, same size, no flicker on flip-through).
- `color: accent2 green` already mapped per card (no "should it be green or teal" wavering).
- Layout-helper interfaces (signatures or pseudocode) — agent implements adaptive grids without re-architecting.

**Fields that became liabilities**:
- "Layout E variants" with vague descriptions — P1/P5/P16/P25 all said "Layout E" but had different needs. **Better: each variant gets its own helper**, no "variant" overloading.
- "See `creation.md`'s alternating row colors pattern" cross-references — **better: paste the 6-line example into SPEC** directly.
- "Use 2 columns or all 5 in a row" — ambiguity makes the agent hesitate. Say `colCount: 5` and move on.

**SPEC writing rules**:
1. Every slide **must** have: layout template name + helper-call name.
2. Full field table (title / subtitle / cards array / KPI / banner text).
3. Use color references like `COLORS.accent5`, not "color #1 blue".
4. **No "or" options** — `colCount: 3` means 3, not "3 or 4".
5. Common rules (footer / decorative line / default font sizes) declared once in a helper, omitted on each slide.

### Helper-function boundaries

**Three repetitions before extraction; fewer than three, don't (YAGNI)**.

The v2 SPEC defined 5 helpers (`addPageHeader` / `addCardGrid` / `addKPI` / `addCompareTable` / `addBigCenter`). The agent itself extracted 3 more during the run:
- `addFooter` (used 25 times)
- `addBanner` (used 7 times)
- `addCaseDivider` (used 3 times)

### One-shot vs incremental

**Detailed SPEC + clear globals → write the entire ~970-line `build.js`, then run** — actually more reliable for the LLM:
- Single point of failure is easy to localize; bad helper → rewrite that helper.
- No mid-run `pres` corruption.
- No double `writeFile()` invoking the unit-conversion bug.

**Vague SPEC / uncertain visuals → write a helper + one sample slide + run it**, then batch out the rest.

### When to write speaker notes

**Add `slide.addNotes(...)` at the end of each builder, don't backfill.**

When the slide's fields are still hot in memory, the notes naturally match. Backfilling produces "small essays unrelated to the on-slide content".

**Best practice**: add a final column to each slide's SPEC field table called "notes bullets" — 5–7 bullet points (under ~100 chars) that the builder can copy verbatim.

### One-line advice for the next agent

> **Read the 17 Common Pitfalls at the bottom of `docs/creation.md` (10 minutes) before touching the keyboard.** The debugging time saved is 10x. One-shot success is 80% pre-reading those 17, 20% a detailed `SPEC.md`.

### Stable recipe

**SPEC-driven + Creation-from-scratch + 17-pitfall checklist + PDF-via-OCR validation = 25 complex slides on first try.**
