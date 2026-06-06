# python-pptx Template Tutorial

## Workflow

1. **Inspect template** (one call — returns dimensions, fonts, colors, layouts, shapes, tables):
   ```python
   import sys
   sys.path.insert(0, '.')
   from pptx_inspect import inspect_template
   output = inspect_template('template.pptx')
   ```
   Read the output carefully — it contains everything you need.

2. **Plan layout mapping** — study the `LAYOUT USAGE` section to see which layouts the template uses for its slides. Map each of your new slides to the best-matching template layout:
   - Title/cover slides → use the same layout as the template's title slide
   - Content slides → use the same layout as the template's content slides (usually the most-used layout)
   - Section dividers → use cover/gradient layouts if available
   - **Never default to "Blank"** unless the template itself uses "Blank" for its slides

3. **Build slides** using the mapped layouts + patterns from this doc. The template's visual design (backgrounds, gradients, decorative elements) comes from the **layout** — using the right layout inherits all of it automatically.

4. **Delete original template slides** (see Setup section below).

5. **Save and return immediately**:
   ```python
   prs.save('output.pptx')
   ```
   Do NOT run post-save QA. Return the artifact tag.

---

## Setup & Template Loading

```python
from pptx import Presentation
from pptx.util import Inches, Pt, Cm, Emu
from pptx.dml.color import RGBColor

# Load template — inherits theme, masters, layouts, colors, fonts
prs = Presentation('template.pptx')
original_count = len(prs.slides)

# Discover available layouts (or use inspect_template() from pptx_inspect.py)
for i, layout in enumerate(prs.slide_layouts):
    print(f"Layout {i}: {layout.name} ({len(layout.placeholders)} placeholders)")

# Add new slides using template layouts
slide = prs.slides.add_slide(prs.slide_layouts[1])
# ... add more slides, populate content ...

# Delete template's original sample slides (work backwards to avoid index shift)
for i in range(original_count - 1, -1, -1):
    rId = prs.slides._sldIdLst[i].rId
    prs.part.drop_rel(rId)
    del prs.slides._sldIdLst[i]

prs.save('output.pptx')
```

**Critical:** `Presentation('template.pptx')` loads ALL existing slides. After adding your new slides, delete the originals using the loop above.

---

## Slide Layouts & Placeholders

```python
# Find layout by name (more robust than hardcoded index)
def get_layout(prs, name):
    for layout in prs.slide_layouts:
        if layout.name == name:
            return layout
    return None

slide = prs.slides.add_slide(get_layout(prs, "Title and Content"))

# IMPORTANT: Layout identification - correct vs incorrect
# ✅ CORRECT ways to identify/reference layouts:
#    - By index: for i, layout in enumerate(prs.slide_layouts)
#    - By name: layout.name → "Title Slide", "Title and Content", etc.
#    - Internal ID (rarely needed): layout.slide_layout.id (note: TWO levels)
# ❌ WRONG - Does NOT exist (will cause AttributeError):
#    - layout.slide_layout_id  # No such attribute!

# add_slide() clones all layout placeholders onto the slide automatically
# Enumerate to discover available placeholders
for ph in slide.placeholders:
    print(f"  ph[{ph.placeholder_format.idx}] {ph.placeholder_format.type}: "
          f"{ph.name}  {ph.width/914400:.1f}\" x {ph.height/914400:.1f}\"")

# Common layout names (vary by template):
#   "Title Slide"        — big centered title + subtitle
#   "Title and Content"  — title bar + body area
#   "Section Header"     — section divider
#   "Two Content"        — title + two columns
#   "Comparison"         — title + two labeled columns
#   "Title Only"         — just a title bar
#   "Blank"              — empty slide with theme background

# Placeholder insertion (replaces the placeholder with the inserted object)
pic = slide.placeholders[10].insert_picture('photo.png')  # PicturePlaceholder
graphic = slide.placeholders[10].insert_chart(chart_type, chart_data)  # ChartPlaceholder
graphic = slide.placeholders[10].insert_table(rows=3, cols=4)  # TablePlaceholder
# ⚠️ After insert_*(), the original placeholder reference is replaced.
# Capture the return value — the old placeholder object is invalid.
```

---

## Text & Formatting

```python
from pptx.util import Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN

# Simple: set placeholder text directly (inherits template styling)
slide.placeholders[0].text = "Quarterly Review"
slide.placeholders[1].text = "Finance Team — Q4 2025"

# Rich text: text_frame → paragraphs → runs
tf = slide.placeholders[1].text_frame
tf.clear()  # removes all paragraphs except one empty one

p = tf.paragraphs[0]
p.alignment = PP_ALIGN.LEFT
run = p.add_run()
run.text = "Revenue grew 15% year-over-year"
run.font.size = Pt(18)
run.font.bold = True
run.font.color.rgb = RGBColor(0x1E, 0x29, 0x3B)

# Add another paragraph
p2 = tf.add_paragraph()
p2.alignment = PP_ALIGN.LEFT
run2 = p2.add_run()
run2.text = "Driven by expansion in APAC markets"
run2.font.size = Pt(14)

# Multi-style text in one paragraph
p3 = tf.add_paragraph()
r1 = p3.add_run()
r1.text = "Status: "
r1.font.bold = True
r2 = p3.add_run()
r2.text = "On Track"
r2.font.color.rgb = RGBColor(0x22, 0x8B, 0x22)

# Hyperlinks
run.hyperlink.address = "https://example.com"

# Spacing
p.space_before = Pt(6)
p.space_after = Pt(12)
p.line_spacing = 1.5      # proportional (1.5 lines)
p.line_spacing = Pt(20)   # OR fixed (20pt)

# Vertical alignment
from pptx.enum.text import MSO_ANCHOR
shape.text_frame.word_wrap = True
shape.text_frame.auto_size = None  # disable auto-fit
```

**Font properties:** `bold`, `italic`, `underline`, `strikethrough`, `size` (Pt), `name` (font family), `color.rgb` (RGBColor), `color.theme_color` (MSO_THEME_COLOR)

---

## Lists & Bullets

```python
tf = slide.placeholders[1].text_frame
tf.clear()

# Bullet list (template body placeholders usually auto-bullet)
items = ["Revenue up 15%", "New markets opened", "Margin improvement"]
for i, item in enumerate(items):
    p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
    p.text = item
    p.level = 0  # indentation level (0-8)

# Sub-items
p_sub = tf.add_paragraph()
p_sub.text = "APAC grew 32%"
p_sub.level = 1

# Numbered list (no high-level API — use XML)
from pptx.oxml.ns import qn
from lxml import etree

p_num = tf.add_paragraph()
p_num.text = "First step"
p_num.level = 0
pPr = p_num._p.get_or_add_pPr()
# Remove any existing bullet
for tag in ('a:buNone', 'a:buAutoNum', 'a:buChar'):
    for existing in pPr.findall(qn(tag)):
        pPr.remove(existing)
buAutoNum = etree.SubElement(pPr, qn('a:buAutoNum'))
buAutoNum.set('type', 'arabicPeriod')  # 1. 2. 3.
# Other types: arabicParenR (1) 2) 3)), romanUcPeriod (I. II. III.)
#              alphaLcPeriod (a. b. c.), alphaUcPeriod (A. B. C.)
```

---

## Tables

```python
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN

rows, cols = 4, 3
table_shape = slide.shapes.add_table(
    rows, cols, Inches(0.5), Inches(1.5), Inches(9), Inches(3))
table = table_shape.table

# Column widths
table.columns[0].width = Inches(3)
table.columns[1].width = Inches(3)
table.columns[2].width = Inches(3)

# Header row
headers = ["Region", "Revenue", "Growth"]
for j, header in enumerate(headers):
    cell = table.cell(0, j)
    cell.text = header
    p = cell.text_frame.paragraphs[0]
    p.font.bold = True
    p.font.size = Pt(14)
    p.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
    p.alignment = PP_ALIGN.CENTER
    cell.fill.solid()
    cell.fill.fore_color.rgb = RGBColor(0x2C, 0x3E, 0x50)

# Data rows
data = [
    ["North America", "$42.3M", "+12%"],
    ["EMEA", "$28.1M", "+8%"],
    ["APAC", "$19.7M", "+32%"],
]
for i, row_data in enumerate(data):
    for j, val in enumerate(row_data):
        cell = table.cell(i + 1, j)
        cell.text = val
        cell.text_frame.paragraphs[0].font.size = Pt(12)

# Alternating row shading
for i in range(1, rows):
    for j in range(cols):
        cell = table.cell(i, j)
        cell.fill.solid()
        color = RGBColor(0xF2, 0xF2, 0xF2) if i % 2 == 0 else RGBColor(0xFF, 0xFF, 0xFF)
        cell.fill.fore_color.rgb = color

# Cell merging
table.cell(1, 0).merge(table.cell(2, 0))

# Cell margins
from pptx.util import Emu
cell._tc.marL = Emu(91440)  # left margin (~0.1")
cell._tc.marR = Emu(91440)
cell._tc.marT = Emu(45720)  # top margin (~0.05")
cell._tc.marB = Emu(45720)
```

### Table Borders (XML required)

python-pptx has no high-level border API. Use XML:

```python
from pptx.oxml.ns import qn
from lxml import etree

def set_cell_border(cell, color="000000", width="12700"):
    """Set all borders on a cell. width: EMU (12700 = 1pt)."""
    tc = cell._tc
    tcPr = tc.get_or_add_tcPr()
    for old in tcPr.findall(qn('a:tcBdr')):
        tcPr.remove(old)
    tcBdr = etree.SubElement(tcPr, qn('a:tcBdr'))
    for edge in ('lnL', 'lnR', 'lnT', 'lnB'):
        ln = etree.SubElement(tcBdr, qn(f'a:{edge}'), w=width)
        fill = etree.SubElement(ln, qn('a:solidFill'))
        etree.SubElement(fill, qn('a:srgbClr'), val=color)

# Apply to all cells
for i in range(rows):
    for j in range(cols):
        set_cell_border(table.cell(i, j), color="CCCCCC")
```

---

## Charts

```python
from pptx.chart.data import CategoryChartData, XyChartData, BubbleChartData
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION
from pptx.util import Inches, Pt

# Bar / Column chart
chart_data = CategoryChartData()
chart_data.categories = ['Q1', 'Q2', 'Q3', 'Q4']
chart_data.add_series('Revenue ($M)', (42.3, 48.7, 51.2, 55.8))
chart_data.add_series('Profit ($M)', (12.1, 14.3, 15.8, 18.2))

chart_frame = slide.shapes.add_chart(
    XL_CHART_TYPE.COLUMN_CLUSTERED,
    Inches(0.5), Inches(1.5), Inches(9), Inches(4),
    chart_data
)
chart = chart_frame.chart

# Line chart
chart_data = CategoryChartData()
chart_data.categories = ['Jan', 'Feb', 'Mar', 'Apr', 'May']
chart_data.add_series('Users (K)', (120, 135, 158, 172, 195))
slide.shapes.add_chart(
    XL_CHART_TYPE.LINE_MARKERS,
    Inches(0.5), Inches(1.5), Inches(9), Inches(4), chart_data)

# Pie chart
chart_data = CategoryChartData()
chart_data.categories = ['Product A', 'Product B', 'Services', 'Other']
chart_data.add_series('Revenue Split', (35, 30, 25, 10))
slide.shapes.add_chart(
    XL_CHART_TYPE.PIE,
    Inches(3), Inches(1.5), Inches(4), Inches(4), chart_data)

# Scatter chart
chart_data = XyChartData()
series = chart_data.add_series('Performance')
series.add_data_point(72, 85)
series.add_data_point(88, 92)
series.add_data_point(65, 70)
slide.shapes.add_chart(
    XL_CHART_TYPE.XY_SCATTER,
    Inches(0.5), Inches(1.5), Inches(9), Inches(4), chart_data)

# Bubble chart
chart_data = BubbleChartData()
series = chart_data.add_series('Markets')
series.add_data_point(10, 25, 15)   # x, y, size
series.add_data_point(20, 40, 30)
slide.shapes.add_chart(
    XL_CHART_TYPE.BUBBLE,
    Inches(0.5), Inches(1.5), Inches(9), Inches(4), chart_data)
```

### Chart Styling

```python
# Title
chart.has_title = True
chart.chart_title.text_frame.paragraphs[0].text = "Revenue by Quarter"
chart.chart_title.text_frame.paragraphs[0].font.size = Pt(14)

# Legend
chart.has_legend = True
chart.legend.include_in_layout = False
chart.legend.position = 2  # XL_LEGEND_POSITION: 2=bottom, -1=right, etc.

# Axis formatting
value_axis = chart.value_axis
value_axis.has_title = True
value_axis.axis_title.text_frame.paragraphs[0].text = "Revenue ($M)"
value_axis.major_gridlines.format.line.color.rgb = RGBColor(0xE2, 0xE8, 0xF0)

category_axis = chart.category_axis
category_axis.has_title = True
category_axis.axis_title.text_frame.paragraphs[0].text = "Quarter"
category_axis.tick_labels.font.size = Pt(10)

# Series colors
plot = chart.plots[0]
series = plot.series[0]
series.format.fill.solid()
series.format.fill.fore_color.rgb = RGBColor(0x0D, 0x94, 0x88)

# Data labels
plot.has_data_labels = True
data_labels = plot.data_labels
data_labels.show_value = True
data_labels.font.size = Pt(10)
data_labels.number_format = '0.0'
data_labels.position = XL_LABEL_POSITION.OUTSIDE_END
```

### Chart Type Reference

| Type | XL_CHART_TYPE | Data Class |
|------|---------------|------------|
| Column (clustered) | `COLUMN_CLUSTERED` | CategoryChartData |
| Column (stacked) | `COLUMN_STACKED` | CategoryChartData |
| Bar (horizontal) | `BAR_CLUSTERED` | CategoryChartData |
| Line | `LINE` | CategoryChartData |
| Line (markers) | `LINE_MARKERS` | CategoryChartData |
| Pie | `PIE` | CategoryChartData |
| Doughnut | `DOUGHNUT` | CategoryChartData |
| Area | `AREA` | CategoryChartData |
| Area (stacked) | `AREA_STACKED` | CategoryChartData |
| Scatter | `XY_SCATTER` | XyChartData |
| Scatter (lines) | `XY_SCATTER_LINES` | XyChartData |
| Bubble | `BUBBLE` | BubbleChartData |
| Radar | `RADAR` | CategoryChartData |

---

## Images

```python
from pptx.util import Inches

# From file path (specify both w and h)
slide.shapes.add_picture('chart.png', Inches(1), Inches(1.5), Inches(5), Inches(3))

# Preserve aspect ratio: specify width only, omit height
slide.shapes.add_picture('photo.jpg', Inches(1), Inches(1.5), width=Inches(4))

# Into a picture placeholder (inherits template positioning)
pic = slide.placeholders[10].insert_picture('photo.jpg')

# From BytesIO stream (base64 images, generated charts, etc.)
import base64, io
img_data = base64.b64decode(b64_string)
img_stream = io.BytesIO(img_data)
slide.shapes.add_picture(img_stream, Inches(1), Inches(1.5), Inches(5), Inches(3))
```

---

## Shapes

```python
from pptx.util import Inches, Pt
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN

# Rectangle
shape = slide.shapes.add_shape(
    MSO_SHAPE.RECTANGLE, Inches(1), Inches(1), Inches(3), Inches(2))
shape.fill.solid()
shape.fill.fore_color.rgb = RGBColor(0x28, 0x3A, 0x5E)

# Rounded rectangle
shape = slide.shapes.add_shape(
    MSO_SHAPE.ROUNDED_RECTANGLE, Inches(1), Inches(1), Inches(3), Inches(2))

# Oval / Circle
shape = slide.shapes.add_shape(
    MSO_SHAPE.OVAL, Inches(5), Inches(1), Inches(2), Inches(2))

# Line / Connector (start_x, start_y, end_x, end_y)
connector = slide.shapes.add_connector(
    MSO_CONNECTOR.STRAIGHT, Inches(1), Inches(3), Inches(9), Inches(3))
connector.line.color.rgb = RGBColor(0xCC, 0xCC, 0xCC)
connector.line.width = Pt(1)

# Text inside shapes
shape = slide.shapes.add_shape(
    MSO_SHAPE.ROUNDED_RECTANGLE, Inches(1), Inches(1), Inches(3), Inches(1.5))
tf = shape.text_frame
tf.word_wrap = True
p = tf.paragraphs[0]
p.text = "Key Insight"
p.font.size = Pt(16)
p.font.bold = True
p.alignment = PP_ALIGN.CENTER

# Shape borders
shape.line.color.rgb = RGBColor(0x00, 0x00, 0x00)
shape.line.width = Pt(2)

# No fill (transparent)
shape.fill.background()
```

---

## ⚠️ CRITICAL: Shape Type Compatibility

**IMPORTANT:** Not all shapes support `.fill` and `.line` properties. Accessing these properties on incompatible shape types will cause `AttributeError`.

### Shape Types That Support .fill and .line

**✅ THESE WORK:**
```python
from pptx.enum.shapes import MSO_SHAPE_TYPE

# Only these shape types support .fill and .line:
supported_types = [
    MSO_SHAPE_TYPE.AUTO_SHAPE,   # Rectangles, circles, arrows, etc.
    MSO_SHAPE_TYPE.TEXT_BOX,      # Text boxes
    MSO_SHAPE_TYPE.FREEFORM,      # Custom drawn shapes
]
```

### Shape Types That DON'T Support .fill

**❌ THESE WILL CAUSE AttributeError:**
```python
# DO NOT use .fill or .line on these:
MSO_SHAPE_TYPE.GROUP       # 'GroupShape' has no .fill attribute
MSO_SHAPE_TYPE.CHART       # 'GraphicFrame' has no .fill attribute
MSO_SHAPE_TYPE.TABLE       # 'GraphicFrame' has no .fill attribute
MSO_SHAPE_TYPE.PICTURE     # 'Picture' has no .fill attribute
```

### Safe Iteration Pattern (ALWAYS USE THIS)

**❌ WRONG - Will crash on groups, pictures, charts, tables:**
```python
# DO NOT DO THIS:
for shape in slide.shapes:
    shape.fill.solid()  # AttributeError on GroupShape!
    shape.fill.fore_color.rgb = RGBColor(0xFF, 0x00, 0x00)
```

**✅ CORRECT - Check shape type first:**
```python
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.dml.color import RGBColor

# Safe approach: Check before accessing
for shape in slide.shapes:
    # Skip unsupported shape types
    if shape.shape_type in [MSO_SHAPE_TYPE.GROUP,
                            MSO_SHAPE_TYPE.PICTURE,
                            MSO_SHAPE_TYPE.CHART,
                            MSO_SHAPE_TYPE.TABLE]:
        continue  # Skip these - they don't support .fill

    # Check if shape has fill property
    if hasattr(shape, 'fill'):
        shape.fill.solid()
        shape.fill.fore_color.rgb = RGBColor(0x28, 0x3A, 0x5E)
```

### Chart-Specific Errors

**❌ WRONG - Accessing chart_type from plot:**
```python
# DO NOT DO THIS:
chart = slide.shapes[5].chart
plot = chart.plots[0]
if plot.chart_type == XL_CHART_TYPE.COLUMN_CLUSTERED:  # AttributeError!
    pass
```

**✅ CORRECT - Access chart_type from chart object:**
```python
from pptx.enum.chart import XL_CHART_TYPE

chart = slide.shapes[5].chart
# Access from chart, not plot
if chart.chart_type == XL_CHART_TYPE.COLUMN_CLUSTERED:
    plot = chart.plots[0]
    for series in plot.series:
        series.format.fill.solid()
        series.format.fill.fore_color.rgb = RGBColor(0x0D, 0x94, 0x88)
```

### Color Type Checking

**❌ WRONG - Assuming all colors have .rgb:**
```python
# DO NOT DO THIS:
color = shape.fill.fore_color
rgb = color.rgb  # AttributeError if color is theme-based (_SchemeColor)
```

**✅ CORRECT - Check color type first:**
```python
color = shape.fill.fore_color

# Theme colors don't have .rgb property
if hasattr(color, 'rgb'):
    rgb = color.rgb  # Only if RGB color
    print(f"RGB: {rgb}")
elif hasattr(color, 'theme_color'):
    print(f"Theme color: {color.theme_color}")
    # Leave theme color as-is or convert to RGB:
    color.rgb = RGBColor(0x28, 0x3A, 0x5E)
```

### Why These Errors Happen

python-pptx uses **different classes for different shape types**:

| Shape Type | Class | Properties Available |
|------------|-------|---------------------|
| Auto shapes, text boxes | `Shape` | `.fill`, `.line` ✅ |
| Grouped objects | `GroupShape` | `.shapes` (children only) ❌ |
| Charts, tables | `GraphicFrame` | `.chart` or `.table` ❌ |
| Images | `Picture` | `.image` ❌ |

**Not all classes implement the same properties.** Always use `hasattr()` or check `shape.shape_type` before accessing shape-specific properties.

### Common AttributeErrors and Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `'GroupShape' has no 'fill'` | Accessing `.fill` on grouped shapes | Check `shape.shape_type != MSO_SHAPE_TYPE.GROUP` |
| `'GraphicFrame' has no 'fill'` | Accessing `.fill` on charts/tables | Check `hasattr(shape, 'fill')` first |
| `'Picture' has no 'fill'` | Accessing `.fill` on images | Skip `MSO_SHAPE_TYPE.PICTURE` |
| `'BarPlot' has no 'chart_type'` | Accessing `plot.chart_type` | Use `chart.chart_type` instead |
| `no .rgb property` | Theme color type | Check `hasattr(color, 'rgb')` first |

---

### Shape Types

| Shape | MSO_SHAPE Constant |
|-------|-------------------|
| Rectangle | `RECTANGLE` |
| Rounded Rectangle | `ROUNDED_RECTANGLE` |
| Oval / Circle | `OVAL` |
| Triangle | `ISOSCELES_TRIANGLE` |
| Right Arrow | `RIGHT_ARROW` |
| Chevron | `CHEVRON` |
| Pentagon | `PENTAGON` |
| Hexagon | `HEXAGON` |
| Star (5-point) | `STAR_5_POINT` |
| Callout | `CALLOUT_1` |

---

## Slide Properties

```python
# Speaker notes
notes_slide = slide.notes_slide
tf = notes_slide.notes_text_frame
if tf is not None:
    tf.text = "Key talking points:\n- Revenue grew 15%\n- New APAC markets"

# Slide dimensions (set by template — read only to calculate positions)
width_inches = prs.slide_width / 914400
height_inches = prs.slide_height / 914400

# Slide numbers are controlled by the template's slide master (not set per-slide)
```

---

## Common Pitfalls

| # | Issue | Wrong | Correct |
|---|-------|-------|---------|
| 1 | Units | `shape.left = 1` (1 EMU = invisible) | `shape.left = Inches(1)` |
| 2 | Font size | `run.font.size = 18` (18 EMU = invisible) | `run.font.size = Pt(18)` |
| 3 | Theme color read | `run.font.color.rgb` on theme color → error | Check `run.font.color.type` first |
| 4 | Chart data class | `CategoryChartData()` for scatter | `XyChartData()` for scatter, `BubbleChartData()` for bubble |
| 5 | Hex color format | `RGBColor("FF0000")` | `RGBColor(0xFF, 0x00, 0x00)` — three ints |
| 6 | Layout after creation | `slide.slide_layout = other` (read-only) | Choose correct layout at `add_slide()` time |
| 7 | Placeholder index | Assuming `placeholders[0]` is always title | Enumerate first — indices vary by template |
| 8 | Image stretch | `add_picture(path, x, y, w, h)` distorts | Omit height to auto-calculate from aspect ratio |
| 9 | Template slides | Forgetting to delete template's sample slides | Delete originals after adding new slides (see Setup) |
| 10 | Placeholder insert | Using `ph` after `ph.insert_picture(img)` | `pic = ph.insert_picture(img)` — `ph` is now invalid |
| 11 | Layout by index | `prs.slide_layouts[1]` (brittle across templates) | `get_layout(prs, "Title and Content")` by name |
| 12 | No delete_slide API | `prs.slides.remove(slide)` (doesn't exist) | 3-line XML pattern: `drop_rel` + `del _sldIdLst[i]` |

**EMU (English Metric Units):**
- 1 inch = 914,400 EMU
- Always use `Inches()`, `Pt()`, `Cm()`, or `Emu()` helpers
- Raw integers are EMU — forgetting the unit wrapper is the #1 bug

**Theme colors (inherits template's palette):**
```python
from pptx.enum.dml import MSO_THEME_COLOR
run.font.color.theme_color = MSO_THEME_COLOR.ACCENT_1  # uses template's accent color

# Explicit RGB (overrides theme)
run.font.color.rgb = RGBColor(0xFF, 0x7F, 0x50)
```

---

## Quick Reference

```
# Units
Inches(1) = 914400 EMU       Pt(12) = 12-point font
Cm(2.54) = 1 inch            Emu(914400) = 1 inch

# Navigation
prs.slide_layouts[i]          → SlideLayout
prs.slides.add_slide(layout)  → Slide
slide.shapes                  → list of Shape
slide.placeholders            → list of placeholder shapes (by .placeholder_format.idx)

# Text hierarchy
shape.text_frame              → TextFrame
  .paragraphs[i]              → _Paragraph
    .runs[j]                  → _Run
      .text, .font.bold, .font.italic, .font.size, .font.color

# Placeholder types (PP_PLACEHOLDER)
TITLE, CENTER_TITLE, SUBTITLE, BODY, OBJECT, DATE, FOOTER, SLIDE_NUMBER

# Chart types (XL_CHART_TYPE)
COLUMN_CLUSTERED, BAR_CLUSTERED, LINE, LINE_MARKERS, PIE, DOUGHNUT,
AREA, AREA_STACKED, XY_SCATTER, XY_SCATTER_LINES, BUBBLE, RADAR

# Shape types (MSO_SHAPE)
RECTANGLE, ROUNDED_RECTANGLE, OVAL, ISOSCELES_TRIANGLE,
RIGHT_ARROW, CHEVRON, HEXAGON, STAR_5_POINT, CALLOUT_1

# Key enums
from pptx.enum.text import PP_ALIGN         # LEFT, CENTER, RIGHT, JUSTIFY
from pptx.enum.text import MSO_ANCHOR       # TOP, MIDDLE, BOTTOM
from pptx.enum.dml import MSO_THEME_COLOR   # ACCENT_1..6, DARK_1, LIGHT_1
from pptx.enum.chart import XL_CHART_TYPE
from pptx.enum.chart import XL_LABEL_POSITION  # OUTSIDE_END, CENTER, etc.
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
```

---

## Design Matching

The template's visual identity comes from its **layouts**, not from manually placed shapes. When you use a layout, you inherit its:
- Background fill (gradients, images, solid colors)
- Decorative shapes (corner elements, accent lines)
- Master slide elements (logos, footers, page numbers)

### Rules

1. **Check `LAYOUT USAGE`** in the inspect output. Use the same layouts the template uses.
2. **Most-used layout = your default** for content slides. If the template uses "Blank with Night Light" for 7 of 9 slides, use that layout for your content slides too.
3. **Never use "Blank" or the plainest layout** unless the template itself does. Choosing "Blank" throws away the template's background design.
4. **Use placeholders when available.** If a layout has a TITLE placeholder, set its `.text` instead of adding a textbox. Placeholder text inherits the template's font, size, and position.
5. **Add custom shapes on top of the layout**, not instead of it. The layout provides the background; you add content shapes on top.
6. **Use the template's theme fonts** from `THEME FONTS` in the inspect output — not fonts mentioned in the user's prompt unless they explicitly say to override the template.

---

## Save & Return

After building all slides and deleting the template originals:

```python
prs.save('output.pptx')
```

Return the artifact immediately. Do not run markitdown, image conversion, or visual QA.
