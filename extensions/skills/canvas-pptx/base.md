---
name: pptx-skill
description: For creating and editing professional PowerPoint presentations (.pptx). Supports creating from scratch with pptxgenjs, creating from a .pptx template, editing existing presentations, reading/analyzing content, and visual QA workflows.
version: 2.1.0
---

# PPTX Creation and Editing

## Quick Reference

| Task | Guide |
|------|-------|
| Read/analyze content | `content = read_binary_docs('presentation.pptx')` or `python -m markitdown presentation.pptx` |
| Create from scratch (no .pptx) | Read [creation.md](creation.md) |
| Create from template OR edit existing (.pptx provided) | Read [editing.md](editing.md) |

---

## Available Libraries

**JavaScript:** pptxgenjs, react-icons (SVG icons via react-dom/server)
**Python:** python-pptx, pandas, matplotlib, pillow

---

## Reading Input Documents

When you need to read/analyze input files (docx, pdf, pptx), use the `read_binary_docs` helper:

```python
import sys
sys.path.insert(0, '.')
from document_helper import read_binary_docs

# Read single file - returns markdown content
content = read_binary_docs('presentation.pptx')

# Read multiple files
content = read_binary_docs(['file1.pptx', 'file2.pdf'])
```

---

## Workflow Routing

**Two reference docs uploaded to workspace (read JIT as needed):**

| Doc | When to Read | Contains |
|-----|--------------|----------|
| `creation.md` | No .pptx in workspace — creating from scratch | pptxgenjs API, JavaScript patterns |
| `editing.md` | .pptx exists in workspace — template-based creation OR editing | JSON patch + python-pptx workflow |

**⚠️ If a .pptx file is in your workspace, ALWAYS read `editing.md` — never `creation.md`.**

**How to route:**
- No .pptx provided → `creation.md` (pptxgenjs, create from scratch)
- .pptx provided + "create using this as template" → `editing.md` (Template-Based Creation section)
- .pptx provided + "update/change/edit/fix" → `editing.md` (Editing Workflow section)

### Creating from Scratch (no .pptx in workspace)

**Use the template file pattern** (see SKILL.md and Script Template Workflow below). Do NOT write inline JS in `run_javascript` — instead, build a `_template.js` file with `file_write`, run it with `run_javascript(file='artifacts/<name>_template.js')`, then use `file_edit` + `run_javascript(file=...)` for each subsequent layer. This enables live preview and later edits.

**Mandatory workflow:
1. Read `creation.md` first (`cat creation.md`)
2. Build using the template file pattern from SKILL.md step 5 (file_write → run → file_edit → run cycles)

**Critical rules:**
- **Write code to a `.js` file, then run with `run_javascript(file=...)`** — do NOT pass inline code to `run_javascript`
- Use `require()` (CommonJS) — NOT ES modules
- All declarations (`const`, `let`, `var`) are scoped to each execution — nothing persists across calls. Use `const` by default. For cross-call state, use `session.myKey = value`.
- Use single quotes for ALL text content in JS — prevents quote-in-quote errors
- **After saving, return the artifact immediately** — do NOT run post-save QA, file conversion, or content verification

### .pptx in Workspace (Template-Based Creation OR Editing)

**Mandatory workflow:**
1. Read `editing.md` first (`cat editing.md`)
2. For **template-based creation**: follow the "Template-Based Creation" section — inspect → map content → add_slides → delete originals → apply
3. For **editing**: follow the "Editing Workflow" section — generate_edit_patch → modify → apply

**Critical rules:**
- Use `run_python` — NOT `run_javascript` (except Option B creative slides — see editing.md)
- ALWAYS call `inspect_template()` or `generate_edit_patch()` first — do NOT guess layout names or shape names
- For chart/table data from source files: ALWAYS use `set_chart_from` / `set_table_from`
- **After applying, return the artifact immediately**

---

## Contract / Outline Mode

**Applies to ALL workflows** (creation, template, and editing).

When the prompt includes `[CONTRACT MODE]` or references an approved outline/draft file:

1. **Read the contract file FIRST** — before writing ANY code, `cat` the outline file to understand the required structure
2. **Read ALL data source files** — extract exact values from JSON/CSV/MD sources, never hardcode from memory
   - **Copy values exactly** — do NOT round, paraphrase, or expand abbreviations
   - "$42.3M" stays "$42.3M", not "$42.3 Million" or "$42M"
   - "92.1%" stays "92.1%", not "~92%" or "92%"
3. **Section list is closed** — produce exactly the slides specified, no more, no less
4. **Preserve [Draft] wording verbatim** — do not paraphrase, embellish, or rewrite
5. **Expand [Outline] sections** into professional prose matching stated intent
6. **Replace `<placeholder>` tags** with the described visual (match chart type, data series, layout exactly)
7. **Copy speaker notes exactly**, including source hyperlinks
8. **Count your slides** — outline sections + requested dividers = total slide count

The design guidance below still applies to visual execution (colors, spacing, typography),
but the contract controls structure, content, and slide count.

**For template workflows**: the contract controls content; the template controls visual design.
Read `editing.md` for styling — do NOT read `creation.md` when a .pptx template exists.

---

## Design Ideas

**Don't create boring slides.** Plain bullets on a white background won't impress anyone. Consider ideas from this list for each slide.

### Before Starting

- **Pick a bold, content-informed color palette**: The palette should feel designed for THIS topic. If swapping your colors into a completely different presentation would still "work," you haven't made specific enough choices.
- **Dominance over equality**: One color should dominate (60-70% visual weight), with 1-2 supporting tones and one sharp accent. Never give all colors equal weight.
- **Dark/light contrast**: Dark backgrounds for title + conclusion slides, light for content ("sandwich" structure). Or commit to dark throughout for a premium feel.
- **Commit to a visual motif**: Pick ONE distinctive element and repeat it — rounded image frames, icons in colored circles, thick single-side borders. Carry it across every slide.

### Color Palettes

Choose colors that match your topic — don't default to generic blue. Use these palettes as inspiration:

| Theme | Primary | Secondary | Accent |
|-------|---------|-----------|--------|
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

### For Each Slide

**Every slide needs a visual element** — image, chart, icon, or shape. Text-only slides are forgettable.

**Layout options:**
- Two-column (text left, illustration on right)
- Icon + text rows (icon in colored circle, bold header, description below)
- 2x2 or 2x3 grid (image on one side, grid of content blocks on other)
- Half-bleed image (full left or right side) with content overlay

**Data display:**
- Large stat callouts (big numbers 60-72pt with small labels below)
- Comparison columns (before/after, pros/cons, side-by-side options)
- Timeline or process flow (numbered steps, arrows)

**Visual polish:**
- Icons in small colored circles next to section headers
- Italic accent text for key stats or taglines

### Typography

**Choose an interesting font pairing** — don't default to Arial. Pick a header font with personality and pair it with a clean body font.

| Header Font | Body Font |
|-------------|-----------|
| Georgia | Calibri |
| Arial Black | Arial |
| Calibri | Calibri Light |
| Cambria | Calibri |
| Trebuchet MS | Calibri |
| Impact | Arial |
| Palatino | Garamond |
| Consolas | Calibri |

| Element | Size |
|---------|------|
| Slide title | 36-44pt bold |
| Section header | 20-24pt bold |
| Body text | 14-16pt |
| Captions | 10-12pt muted |

### Spacing

- 0.5" minimum margins
- 0.3-0.5" between content blocks
- Leave breathing room — don't fill every inch

### Avoid (Common Mistakes)

- **Don't repeat the same layout** — vary columns, cards, and callouts across slides
- **Don't center body text** — left-align paragraphs and lists; center only titles
- **Don't skimp on size contrast** — titles need 36pt+ to stand out from 14-16pt body
- **Don't default to blue** — pick colors that reflect the specific topic
- **Don't mix spacing randomly** — choose 0.3" or 0.5" gaps and use consistently
- **Don't style one slide and leave the rest plain** — commit fully or keep it simple throughout
- **Don't create text-only slides** — add images, icons, charts, or visual elements; avoid plain title + bullets
- **Don't forget text box padding** — when aligning lines or shapes with text edges, set `margin: 0` on the text box or offset the shape to account for padding
- **Don't use low-contrast elements** — icons AND text need strong contrast against the background; avoid light text on light backgrounds or dark text on dark backgrounds
- **NEVER use accent lines under titles** — these are a hallmark of AI-generated slides; use whitespace or background color instead

---

## After Saving

**Return the artifact immediately after `writeFile()` succeeds.** Do NOT attempt post-save verification — the sandbox does not have LibreOffice, pdftoppm, or other conversion tools.

> Your code IS the QA. Before calling `writeFile()`, review your code for:
> - Overlapping elements (check x/y/w/h math)
> - Text overflow (ensure w/h are large enough for content)
> - Missing content (every user-requested point has a slide/section)
> - Color consistency (all hex values match your palette, no `#` prefix)
