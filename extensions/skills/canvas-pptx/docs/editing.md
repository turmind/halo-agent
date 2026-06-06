# Working with Existing Presentations (Editing and Template-Based Creation)

## When to Use
- User provides a .pptx to **edit/update/modify/fix** → follow the **Editing Workflow** below
- User provides a .pptx **as a template** to create a new presentation → follow the **Template-Based Creation** section below

Both cases use this doc. Never use pptxgenjs (creation from scratch) when a .pptx file exists in the workspace.

---

## Template-Based Creation

When creating a **new presentation** using an existing .pptx as the visual template:

### Step T1: Inspect the template

```python
import sys
sys.path.insert(0, '.')
from pptx_inspect import inspect_template, generate_edit_patch
output = inspect_template('template.pptx')
```

Read the output carefully — note layout names, `used_by_slides`, theme fonts, and theme colors.

### Step T2: Map content to layouts

For each section in the user's content source, pick the best-matching layout from the `LAYOUT USAGE` section of the inspect output. Write a slide plan before coding:

```python
slide_plan = [
    {"slide_num": 1, "layout": "Title Slide",       "title": "...", "source": "intro"},
    {"slide_num": 2, "layout": "Section Header",    "title": "Executive Summary"},
    {"slide_num": 3, "layout": "Title and Content", "title": "...", "source": "data.md section 1"},
    # ...
]
```

Rules:
- Use layout names from the inspect output exactly (not by index)
- Use the most-used layout for content slides — matches the template's own pattern
- Never default to "Blank" unless the template itself uses it

### Step T3: Build patch — clone template slides, fill content, delete originals

`clone_slides` deep-copies a template slide's full visual design (backgrounds, branded shapes, decorative bars, images, etc.) into a new slide, then lets you replace text by shape name. Always use `apply_edit_patch` with `clone_slides` — **never write your own clone_slide function**.

**First, call `generate_edit_patch()` and read the output** to get exact shape names:
```python
from pptx_inspect import generate_edit_patch
patch_template = generate_edit_patch('template.pptx')
# Read the printed output — note the shape names exactly as printed, e.g. "TextBox 3", "Title 1"
```

Use those exact shape names in the `content` dict. Then build your patch:
```python
# N = number of original slides (from generate_edit_patch output)

patch = {
  "clone_slides": [
    {"insert_at": 1, "clone_from": 1,
     "content": {"TextBox 3": "My New Presentation", "TextBox 5": "Q1 2024"}},
    {"insert_at": 2, "clone_from": 3,
     "content": {"TextBox 1": "Executive Summary",
                 "TextBox 2": "Bullet point 1\nBullet point 2\nBullet point 3"}},
    # ... one entry per output slide; reuse any template slide as clone_from source
  ],
  "structure": {
    "delete_slides": list(range(1, N + 1))  # delete all N original template slides
  }
}

from pptx_edit import apply_edit_patch
apply_edit_patch('template.pptx', patch, 'output.pptx')
```

**Critical rules:**
- `clone_from` is the 1-based slide number in the **original** template (before any deletes)
- `delete_slides` indices also refer to the **original** template slides
- List every original slide in `delete_slides` so the output contains only your new content
- Shape names in `content` **must match exactly** what `generate_edit_patch` printed — check the output carefully
- If a shape name is not found, the WARNING is printed but the slide still has the template's original text — **this means you used a wrong shape name, not that the patch system is broken**. Fix it by re-running `generate_edit_patch()`, reading the printed shape names carefully, and correcting the `content` dict. Do NOT switch to custom python-pptx code or write your own clone function.
- **NEVER write your own clone_slide/clone_slides helper function** — use `apply_edit_patch` with `clone_slides`. If text replacement appears to fail, the root cause is always a shape name mismatch — debug the names, do not abandon the patch system.
- **`delete_slides` uses 1-based positions in the original input file**, not in the final slide order. This works correctly even after `clone_slides`/`add_slides` are repositioned — do not adjust the numbers to account for inserted slides.
- **If `apply_edit_patch` produces unexpected slide order or missing content**, check your `insert_at` values (they are the desired position in the final output after originals are deleted) and re-run. Do NOT rewrite using custom python-pptx code or a custom clone function.
- For slides with no close template match, `add_slides` (with `style_from_slide`) is the fallback

### Step T4: Data rule

When content comes from a source file (markdown, CSV, Excel):
- **Copy values exactly** — do NOT round, paraphrase, or expand abbreviations
- "$42.3M" stays "$42.3M" — not "$42.3 Million" or "$42M"
- "92.1%" stays "92.1%" — not "~92%" or "92%"
- Use `set_chart_from` / `set_table_from` to reference files directly — do NOT retype numbers

### Step T4b: Charts

**⚠️ `matplotlib` is NOT authorized.** For charts in template-based creation use one of:

**Option A — `set_chart_from` in the patch (preferred):** Embed a native PowerPoint chart using the source file directly:
```python
{"insert_at": 4, "layout": "Title and Content",
 "style_from_slide": 3,
 "content": {
   "Title 1": "Quarterly Revenue",
   "set_chart_from": {
     "source": "data.md",
     "table_index": 0,
     "chart_type": "BAR",
     "category_column": "Quarter",
     "series_columns": {"Revenue": "Revenue ($M)"}
   }
 }}
```

**Option B — matplotlib for complex/multi-series charts:**
```python
import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(9, 5))
ax.bar(["Q1","Q2","Q3","Q4"], [12.3, 14.1, 13.8, 16.2])
fig.savefig("chart_revenue.png", dpi=200, bbox_inches='tight')
plt.close(fig)
```
Then reference in the patch: `"set_image": "chart_revenue.png"`

**Never switch to pptxgenjs because a chart is needed.** Use Option A or B above.

### Step T5: Return artifact immediately after apply.

---

## Editing Workflow

### Step 1: Generate edit template

```python
import sys
sys.path.insert(0, '.')
from pptx_inspect import generate_edit_patch
patch = generate_edit_patch('input.pptx')
```

This prints a JSON showing every slide, shape, and current content.
Copy the JSON -- this is your editing interface.

### Step 2a: Modify existing slides (patch)

Keep only the slides/shapes you want to change. Set values on `set_*` fields:

- **Text**: `"set_text": "New title"` or `"set_text": ["Bullet 1", "Bullet 2"]`
- **Chart (from source file)**: `"set_chart_from": {"source": "data.md", "table_index": 0, "category_column": "Quarter", "series_columns": {"Revenue": "Revenue"}}`
- **Chart (inline)**: `"set_categories": ["Q1", "Q2"], "set_series": {"Revenue": [10, 20]}`
- **Table (from source file)**: `"set_table_from": {"source": "data.md", "table_index": 0, "columns": ["Col1", "Col2"]}`
- **Table (inline)**: `"set_data": [["Header1", "Header2"], ["val1", "val2"]]`
- **Font name**: `"set_font_name": "Georgia"` -- changes font on all runs in shape
- **Font size**: `"set_font_size": 24` -- size in points
- **Font bold**: `"set_font_bold": true`
- **Font italic**: `"set_font_italic": true`
- **Font color**: `"set_font_color": "FF0000"` -- hex color, no '#' prefix
- **Image**: `"set_image": "new_photo.png"`
- **Color replace (slide-level)**: `"color_replace": {"4338CA": "EA580C", "EEF2FF": "FFF7ED"}` -- replaces hex colors across all shapes on the slide. Use `current_colors` from the patch template to see what colors exist.
- **Background color**: To change a slide's background color, use custom python-pptx code (see Fallback section). **IMPORTANT**: Check if the slide has a full-bleed background image first — many PPTX files use a large `PICTURE` shape covering the entire slide as the visual background instead of `<p:bg>`. If a background image exists, you must remove or recolor it; setting `<p:bg>` alone will be invisible behind the image.
- **Structure**: `"delete_slides": [5, 6]` or `"reorder": [1, 3, 2, 4]`

Leave `set_*` as `null` or delete the entry to keep unchanged.

### Step 2b: Add new slides (if needed)

If you need to add slides:

**Option A -- Layout-based (use for ALL new slides by default):** Pick a layout from `available_layouts` in the patch template, fill placeholder content by name. Always set `style_from_slide` to clone styling from a similar existing slide:

```json
"add_slides": [{"insert_at": 3, "layout": "Title and Content",
  "style_from_slide": 13,
  "content": {"Title 1": "New Slide", "Content Placeholder 2": ["Item 1", "Item 2"]}}]
```

The `available_layouts` section shows each layout's placeholder types, font formatting, and which slides use it — use this to pick the best layout and `style_from_slide` value. When a placeholder is missing, the system creates a textbox and applies the referenced slide's font (name, size, bold, color) instead of plain defaults.

**Use Option A for:** Executive Summaries, agendas, recommendations, next steps, key findings, conclusions, any new slide that is primarily text and/or bullets. This covers the vast majority of new slides in edit scenarios.

**Option B -- Creative slide (pptxgenjs):** ONLY use when the user **explicitly requests** custom visual design elements that cannot be expressed as text/bullets (KPI dashboard boxes, infographics, frosted glass effects, icon grids, custom graphical timelines). **Never** use Option B just because the slide content is important or detailed — use Option A.

If you must use Option B, you **MUST**:
1. Read `slide_dimensions` from the patch template and set matching layout:
   `pres.defineLayout({ name: 'CUSTOM', width: <width_inches>, height: <height_inches> }); pres.layout = 'CUSTOM';`
   **Never assume standard 16:9 (10×5.63").** Many decks use non-standard sizes (e.g., 20×11.25", 13.33×7.5").
2. Inspect existing slides for **exact** background color, font name, font size, and accent colors using `current_colors` from the patch template. Do **NOT** guess or invent colors.
3. After creation, merge into the output:

```python
from pptx_edit import merge_slides
merge_slides('output.pptx', '/tmp/new_slide.pptx', 'output.pptx', insert_at=10)
```

### Data Rule

When chart/table data comes from a source file (markdown, CSV, Excel), ALWAYS use `set_chart_from` / `set_table_from` to reference the file. Do NOT read the file and type the numbers into `set_series` / `set_data`. The applier reads the file directly.

Only use inline `set_series` / `set_data` when the user provides specific values in their prompt (e.g., "change Q4 revenue to 70").

### Step 3: Apply edits

```python
from pptx_edit import apply_edit_patch
apply_edit_patch('input.pptx', patch, 'output.pptx')
```

### Step 3b: Merge creative slides (if Option B was used)

If you created new slides with pptxgenjs in Step 2b Option B, merge them now:

```python
from pptx_edit import merge_slides
merge_slides('output.pptx', '/tmp/new_slide.pptx', 'output.pptx', insert_at=10)
```

### Step 4: Return artifact immediately after apply (and merge, if applicable).

---

## Complete Example

User says: "Update the title on slide 1 and refresh the chart on slide 3 with data from quarterly_report.md"

```python
import sys
sys.path.insert(0, '.')
from pptx_inspect import generate_edit_patch
patch = generate_edit_patch('input.pptx')
```

Then modify the patch (keep only what changes):

```python
patch = {
  "slides": [
    {
      "slide": 1,
      "shapes": [{"name": "Title 1", "type": "TEXT", "set_text": "Updated Q1 Report"}]
    },
    {
      "slide": 3,
      "shapes": [{
        "name": "Chart 5",
        "type": "CHART",
        "set_chart_from": {
          "source": "quarterly_report.md",
          "table_index": 0,
          "category_column": "Quarter",
          "series_columns": {"Revenue ($M)": "Revenue", "Profit ($M)": "Net Profit"}
        }
      }]
    }
  ]
}

from pptx_edit import apply_edit_patch
apply_edit_patch('input.pptx', patch, 'output.pptx')
```

---

## Example: Adding a Creative Summary Slide

User says: "Edit the title on slide 1 and add a summary slide at the end with KPI boxes"

```python
# Step 1: Generate patch and apply text edit
import sys
sys.path.insert(0, '.')
from pptx_inspect import generate_edit_patch
patch = generate_edit_patch('input.pptx')
```

```python
# Step 2a: Edit existing slide
patch = {
  "slides": [
    {"slide": 1, "shapes": [{"name": "Title 1", "type": "TEXT", "set_text": "Updated Title"}]}
  ]
}
from pptx_edit import apply_edit_patch
apply_edit_patch('input.pptx', patch, 'output.pptx')
```

```javascript
// Step 2b: Create creative slide with pptxgenjs (via run_javascript)
var pptxgen = require('pptxgenjs');
var pres = new pptxgen();
pres.layout = 'LAYOUT_16x9';
var slide = pres.addSlide();
slide.background = { fill: '1a1a2e' };
slide.addText('Executive Summary', { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 32, color: 'FFFFFF', bold: true });
// ... add KPI boxes, shapes, etc. using creation.md patterns ...
pres.writeFile({ fileName: '/tmp/workspace/summary_slide.pptx' });
```

```python
# Step 3b: Merge the creative slide into the output
from pptx_edit import merge_slides
merge_slides('output.pptx', '/tmp/workspace/summary_slide.pptx', 'output.pptx', insert_at=10)
```

---

## Rules
- ALWAYS call generate_edit_patch() first -- do NOT guess shape names
- ONLY modify set_* fields -- do NOT add new keys
- For chart/table data from files: ALWAYS use set_chart_from / set_table_from
- For charts: if using inline values, provide both set_categories and set_series
- For new slides in template scenarios: **always prefer `clone_slides`** (deep-copies the full design). Only use `add_slides` as a fallback when no template slide matches the required layout. Never use pptxgenjs when a .pptx template exists.
- When using `clone_slides`, `clone_from` must be a valid 1-based slide number in the original template.
- When using `add_slides` as fallback, **`style_from_slide` is MANDATORY** — never omit it.

## Style Preservation Rules

When rewriting, condensing, or generating new content (e.g., "rewrite to be more concise", "add an Executive Summary slide", "generate an agenda"):

**For modifying existing shapes via patch (`set_text`):**
- The patch system automatically preserves formatting from the original shape (fonts, colors, bullet styles, margins, indents). Just provide the new text — formatting is carried over from the original paragraphs.
- When the new bullet count differs from the original, formatting from the closest original paragraph is reused.

**For adding new slides in template scenarios (`clone_slides` preferred):**
- `clone_slides` deep-copies the entire source slide (all shapes, backgrounds, decorative elements). Provide `content` dict to replace text in named shapes after cloning. Shape names come from `generate_edit_patch()` output.
- `add_slides` (layout-based) is only a fallback when no template slide matches. When using it, always set `style_from_slide`; the system clones font/color from that slide onto fallback textboxes.

**For custom python-pptx code (fallback):**
- **Always match the existing slide style.** Before writing new content, inspect a representative existing content slide to extract: font name, font size, font color, bullet indent/margin, line spacing, and alignment.
- Use `generate_edit_patch()` output to see `current_font_name`, `current_font_size`, and `current_colors` for reference.
- **Never create unstyled textboxes.** Always set font name, size, color, bold, and paragraph-level margins/spacing to match the deck's existing style.
- When adding a new slide (e.g., Executive Summary), find a similar existing slide (e.g., "Key Insights") and clone its text formatting:

```python
# Extract style from an existing content slide
ref_slide = prs.slides[7]  # e.g., "Key Insights" slide
ref_shape = None
for s in ref_slide.shapes:
    if s.has_text_frame and len(s.text_frame.paragraphs) > 1:
        ref_shape = s
        break

# Apply the same style to new content
if ref_shape:
    ref_p = ref_shape.text_frame.paragraphs[0]
    ref_run = ref_p.runs[0] if ref_p.runs else None
    # Use ref_run.font.name, .size, .color.rgb, .bold on your new runs
```

## Fallback: Custom python-pptx Code

The patch system covers common edits (text, charts, tables, fonts, colors, images, slide structure). If the user requests something **not supported by the patch** — e.g., adding/removing shapes, editing SmartArt, adjusting animations, modifying shape positions/sizes, editing connectors, changing slide transitions, or any other advanced manipulation — you may write custom python-pptx code directly.

**When to use fallback:**
- The edit cannot be expressed via any `set_*` field or `color_replace`
- You need to add, remove, resize, or reposition shapes
- The user asks for structural changes to individual shapes (grouping, z-order, etc.)
- Any operation not listed in Step 2a above

**CRITICAL — Layout Safety:**
Many PPTX files (especially branded/corporate templates) have only 1-2 slide layouts, NOT the standard 11. Before accessing `prs.slide_layouts[index]`:
1. **Always check** `len(prs.slide_layouts)` first
2. **Never assume** standard indices (e.g., `[1]` = "Title and Content", `[5]` = "Blank") — these are NOT universal
3. **Use names, not indices**: `{layout.name: layout for layout in prs.slide_layouts}` to find the right layout
4. **Check for title placeholder** before accessing `slide.shapes.title` — it returns `None` on layouts without one. Use `if slide.shapes.title:` before setting `.text`
5. If no suitable layout exists, use `prs.slide_layouts[0]` and add content via `shapes.add_textbox()`

**Fallback workflow:**
1. Still run `generate_edit_patch()` first — use its output to understand shape names, indices, and slide structure (including `available_layouts` which lists all layouts and their placeholders)
2. Apply any patch-supported edits via `apply_edit_patch()` first
3. Then open the output with python-pptx for the remaining custom edits:

```python
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor

prs = Presentation('output.pptx')
slide = prs.slides[0]  # 0-indexed

# Example: resize a shape
for shape in slide.shapes:
    if shape.name == 'Title 1':
        shape.left = Inches(0.5)
        shape.width = Inches(9)

prs.save('output.pptx')
```

**Fallback rules:**
- Always use unit helpers: `Inches()`, `Pt()`, `Emu()` — raw integers are EMU
- `RGBColor(0xFF, 0x00, 0x00)` takes three ints — NOT a hex string
- Reference shape names from `generate_edit_patch()` output — do NOT guess
- Apply patch edits first, then custom code — don't mix approaches on the same shape
- **Never access `slide_layouts` by hardcoded index** — always check `len()` or use a name-based lookup
- **Always guard `slide.shapes.title`** with a None check before accessing `.text`
- **Always check `slide_dimensions`** from the patch template. Many decks use non-standard sizes (e.g., 20"x11.25"). When adding textboxes or shapes via custom code, scale positions and widths to the actual slide dimensions — never hardcode 10" or 9" widths.
- **Background image check**: Before changing a slide's background color, check if a full-bleed image covers the slide. In `generate_edit_patch()` output, look for PICTURE shapes with dimensions matching the slide size. If present, remove the image or apply color changes to the image shape, not `<p:bg>`.
