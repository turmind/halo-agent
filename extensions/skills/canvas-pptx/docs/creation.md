# PPTX Creation Guide

> **IMPORTANT — Use the template file pattern:** Write your JS code to a `_template.js` file with `file_write`, then run with `run_javascript(file='artifacts/<name>_template.js')`. Use `file_edit` + `run_javascript(file=...)` for each subsequent layer. Do NOT pass inline code to `run_javascript`. See SKILL.md step 5 for the full workflow.

This is the **API reference** for pptxgenjs. The code examples below show the API syntax — write them into your template file, not as inline `run_javascript` calls.

> **CRITICAL RULES:**
> 1. **NEVER use `#` with hex colors** — causes file corruption. Use `'FF0000'` not `'#FF0000'`
> 2. **NEVER reuse option objects across calls** — pptxgenjs mutates objects in-place (e.g. converting shadow values to EMU). Use factory functions: `const makeShadow = () => ({ type: 'outer', blur: 6, offset: 2, color: '000000', opacity: 0.15 });`
> 3. **Use `const` by default** — all declarations (`const`, `let`, `var`) are scoped per execution. Nothing persists across `run_javascript` calls. For cross-call state, use `session.myKey = value`.
> 4. **Use single quotes for ALL text content** — prevents quote-in-quote JS errors

---

## Setup & Basic Structure

```javascript
var pptxgen = require('pptxgenjs');

var pres = new pptxgen();
pres.layout = 'LAYOUT_16x9';
pres.author = 'Your Name';
pres.title = 'Presentation Title';

var slide = pres.addSlide();
slide.addText('Hello World!', { x: 0.5, y: 0.5, fontSize: 36, color: '363636' });

pres.writeFile({ fileName: 'Presentation.pptx' });
```

Custom slide dimensions:

```javascript
pres.defineLayout({ name: 'CUSTOM', width: 12, height: 7.5 });
pres.layout = 'CUSTOM';
```

---

## Layout Dimensions

Slide dimensions (coordinates in inches):
- `LAYOUT_16x9`: 10" x 5.625" (default)
- `LAYOUT_16x10`: 10" x 6.25"
- `LAYOUT_4x3`: 10" x 7.5"
- `LAYOUT_WIDE`: 13.3" x 7.5"

---

## Slide Properties

```javascript
// Slide numbers — position and style
slide.slideNumber = { x: 0.3, y: '95%', fontSize: 10, color: '999999', fontFace: 'Arial' };

// Speaker notes
slide.addNotes('Key talking point: mention quarterly growth figures here.');

// Hidden slide (skipped during presentation)
slide.hidden = true;

// Section dividers (organize slides into groups in PowerPoint)
pres.addSection({ title: 'Introduction' });
var slide1 = pres.addSlide({ sectionTitle: 'Introduction' });

pres.addSection({ title: 'Analysis' });
var slide2 = pres.addSlide({ sectionTitle: 'Analysis' });
```

**Note:** Slide transitions are NOT supported by pptxgenjs. There is no API for adding transition effects between slides.

---

## Text & Formatting

```javascript
// Basic text
slide.addText('Simple Text', {
  x: 1, y: 1, w: 8, h: 2, fontSize: 24, fontFace: 'Arial',
  color: '363636', bold: true, align: 'center', valign: 'middle'
});

// Character spacing (use charSpacing, not letterSpacing which is silently ignored)
slide.addText('SPACED TEXT', { x: 1, y: 1, w: 8, h: 1, charSpacing: 6 });

// Rich text arrays (mix bold, italic, color, links, sub/superscript, strikethrough)
slide.addText([
  { text: 'Bold ', options: { bold: true } },
  { text: 'Italic ', options: { italic: true } },
  { text: 'Colored', options: { color: 'FF0000', underline: { style: 'heavy', color: 'FF0000' } } },
  { text: ' Link', options: { hyperlink: { url: 'https://example.com', tooltip: 'Open' } } },
  { text: ' H', options: { breakLine: false } },
  { text: '2', options: { subscript: true } },
  { text: 'O E=mc' },
  { text: '2', options: { superscript: true } },
  { text: ' deleted', options: { strike: 'sngStrike' } }
], { x: 1, y: 3, w: 8, h: 1 });
// strike: 'sngStrike' | 'dblStrike' | true    hyperlink: { slide: 5 } for internal links

// Multi-line text (requires breakLine: true)
slide.addText([
  { text: 'Line 1', options: { breakLine: true } },
  { text: 'Line 2', options: { breakLine: true } },
  { text: 'Line 3' }
], { x: 0.5, y: 0.5, w: 8, h: 2 });

// Paragraph spacing
slide.addText('Spaced paragraph', {
  x: 1, y: 1, w: 8, h: 2,
  paraSpaceBefore: 12, paraSpaceAfter: 6, lineSpacing: 28
  // lineSpacingMultiple: 1.5 — alternative to fixed lineSpacing
});

// Text box margin — set 0 when aligning text with shapes/icons at same x
slide.addText('Title', { x: 0.5, y: 0.3, w: 9, h: 0.6, margin: 0 });

// Text fit and wrapping
slide.addText('Long text...', { x: 1, y: 1, w: 4, h: 1, fit: 'shrink' });
// fit: 'none' (overflow) | 'shrink' (reduce font) | 'resize' (resize on edit)
// wrap: false — disable text wrapping
```

**Note:** Text columns (multiple columns within one text box) are NOT supported. Use a table with invisible borders as a workaround.

---

## Lists & Bullets

```javascript
// Multiple bullets
slide.addText([
  { text: 'First item', options: { bullet: true, breakLine: true } },
  { text: 'Second item', options: { bullet: true, breakLine: true } },
  { text: 'Third item', options: { bullet: true } }
], { x: 0.5, y: 0.5, w: 8, h: 3 });

// NEVER use unicode bullets — creates double bullets
// slide.addText('• First item', { ... });  // WRONG

// Sub-items with indentation
{ text: 'Sub-point', options: { bullet: true, indentLevel: 1, breakLine: true } }

// Numbered lists
{ text: 'First', options: { bullet: { type: 'number' }, breakLine: true } }

// Custom bullet characters
{ text: 'Snowman', options: { bullet: { characterCode: '2603' }, breakLine: true } }
```

Numbered list styles: `'arabicPeriod'`, `'arabicParenR'`, `'romanUcPeriod'`, `'alphaLcPeriod'`, `'alphaUcPeriod'`. Set via `bullet: { type: 'number', numberType: 'romanUcPeriod' }`.

---

## Shapes

```javascript
slide.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 0.8, w: 1.5, h: 3.0,
  fill: { color: 'FF0000' }, line: { color: '000000', width: 2 }
});

slide.addShape(pres.shapes.OVAL, { x: 4, y: 1, w: 2, h: 2, fill: { color: '0000FF' } });

slide.addShape(pres.shapes.LINE, {
  x: 1, y: 3, w: 5, h: 0,
  line: { color: 'FF0000', width: 3, dashType: 'dash' }
});

// With transparency
slide.addShape(pres.shapes.RECTANGLE, {
  x: 1, y: 1, w: 3, h: 2,
  fill: { color: '0088CC', transparency: 50 }
});

// Rounded rectangle (rectRadius only works with ROUNDED_RECTANGLE, not RECTANGLE)
slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
  x: 1, y: 1, w: 3, h: 2,
  fill: { color: 'FFFFFF' }, rectRadius: 0.1
});

// With shadow
slide.addShape(pres.shapes.RECTANGLE, {
  x: 1, y: 1, w: 3, h: 2,
  fill: { color: 'FFFFFF' },
  shadow: { type: 'outer', color: '000000', blur: 6, offset: 2, angle: 135, opacity: 0.15 }
});

// Arrow heads on lines
slide.addShape(pres.shapes.LINE, {
  x: 1, y: 2, w: 5, h: 0,
  line: { color: '333333', width: 2, beginArrowType: 'none', endArrowType: 'arrow' }
  // endArrowType: 'none' | 'arrow' | 'diamond' | 'oval' | 'stealth' | 'triangle'
});

// Text inside shapes (use addText with shape param instead of addShape)
slide.addText('Click Here', {
  x: 2, y: 2, w: 3, h: 1.5, shape: pres.shapes.ROUNDED_RECTANGLE,
  fill: { color: '0088CC' }, color: 'FFFFFF', fontSize: 18, bold: true,
  align: 'center', valign: 'middle', rectRadius: 0.2
});
```

Shadow options:

| Property | Type | Range | Notes |
|----------|------|-------|-------|
| `type` | string | `'outer'`, `'inner'` | |
| `color` | string | 6-char hex (e.g. `'000000'`) | No `#` prefix, no 8-char hex |
| `blur` | number | 0-100 pt | |
| `offset` | number | 0-200 pt | **Must be non-negative** — negative values corrupt the file |
| `angle` | number | 0-359 degrees | Direction the shadow falls (135 = bottom-right, 270 = upward) |
| `opacity` | number | 0.0-1.0 | Use this for transparency, never encode in color string |

To cast a shadow upward (e.g. on a footer bar), use `angle: 270` with a positive offset — do **not** use a negative offset.

Line `dashType` options: `'solid'`, `'dash'`, `'dashDot'`, `'lgDash'`, `'lgDashDot'`, `'lgDashDotDot'`, `'sysDash'`, `'sysDot'`

**Common shapes:** RECTANGLE, ROUNDED_RECTANGLE, OVAL, LINE, DIAMOND, ISOSCELES_TRIANGLE, RIGHT_TRIANGLE, DOWN_ARROW, RIGHT_ARROW, UP_ARROW, LEFT_ARROW, STAR_5_POINT, STAR_4_POINT, HEART, CLOUD, LIGHTNING_BOLT, CHEVRON, REGULAR_PENTAGON, HEXAGON, DONUT, ROUNDED_RECTANGULAR_CALLOUT, OVAL_CALLOUT, DOUBLE_BRACE, DOUBLE_BRACKET, CUBE — over 180 available via `pres.shapes.<NAME>`.

**Note:** Gradient fills are not natively supported. Use a gradient image as a background instead. Shape grouping is NOT supported — render shapes individually; first drawn = bottom layer (z-ordering).

---

## Images

### Image Sources

```javascript
// From file path
slide.addImage({ path: 'chart.png', x: 1, y: 1, w: 5, h: 3 });

// From URL
slide.addImage({ path: 'https://example.com/image.jpg', x: 1, y: 1, w: 5, h: 3 });

// From base64 (faster, no file I/O)
slide.addImage({ data: 'image/png;base64,iVBORw0KGgo...', x: 1, y: 1, w: 5, h: 3 });
```

### Image Options

```javascript
slide.addImage({
  path: 'image.png',
  x: 1, y: 1, w: 5, h: 3,
  rotate: 45,              // 0-359 degrees
  rounding: true,          // Circular crop
  transparency: 50,        // 0-100
  flipH: true,             // Horizontal flip
  flipV: false,            // Vertical flip
  altText: 'Description',  // Accessibility
  hyperlink: { url: 'https://example.com' }
});
```

### Image Sizing Modes

```javascript
// Contain — fit inside, preserve ratio
{ sizing: { type: 'contain', w: 4, h: 3 } }

// Cover — fill area, preserve ratio (may crop)
{ sizing: { type: 'cover', w: 4, h: 3 } }

// Crop — cut specific portion
{ sizing: { type: 'crop', x: 0.5, y: 0.5, w: 2, h: 2 } }
```

### Calculate Dimensions (preserve aspect ratio)

```javascript
var origWidth = 1978, origHeight = 923, maxHeight = 3.0;
var calcWidth = maxHeight * (origWidth / origHeight);
var centerX = (10 - calcWidth) / 2;

slide.addImage({ path: 'image.png', x: centerX, y: 1.2, w: calcWidth, h: maxHeight });
```

### Supported Formats

- **Standard**: PNG, JPG, GIF (animated GIFs work in Microsoft 365)
- **SVG**: Works in modern PowerPoint/Microsoft 365

---

## Icons

Use react-icons to render SVG icons directly — no external rasterization needed.

```javascript
var React = require('react');
var ReactDOMServer = require('react-dom/server');
var fs = require('fs');
var { FaCheckCircle, FaChartLine, FaRocket } = require('react-icons/fa');

// Render icon component to SVG string
function renderIconSvg(IconComponent, color, size) {
  color = color || '#000000';
  size = size || 256;
  return ReactDOMServer.renderToStaticMarkup(
    React.createElement(IconComponent, { color: color, size: String(size) })
  );
}

// Write SVG to temp file and add to slide
function addIcon(slide, IconComponent, color, x, y, w, h) {
  var svg = renderIconSvg(IconComponent, color, 256);
  var iconPath = 'icon_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.svg';
  fs.writeFileSync(iconPath, svg, { encoding: 'utf8' });
  slide.addImage({ path: iconPath, x: x, y: y, w: w, h: h });
}

// Usage — add icons to slides
// Note: '#' prefix is correct here (SVG color) — but NEVER use '#' in pptxgenjs colors
addIcon(slide, FaCheckCircle, '#0D9488', 1, 1, 0.5, 0.5);
addIcon(slide, FaChartLine, '#4472C4', 2, 1, 0.5, 0.5);
addIcon(slide, FaRocket, '#FF6B35', 3, 1, 0.5, 0.5);
```

**Note:** SVG icons require modern PowerPoint (Microsoft 365). The size parameter in `renderIconSvg` controls SVG viewport resolution, not display size on the slide (set by `w`/`h` in inches). Use size 256+ for crisp rendering.

Popular icon sets in react-icons:
- `react-icons/fa` — Font Awesome (most popular, broadest coverage)
- `react-icons/md` — Material Design
- `react-icons/hi` — Heroicons
- `react-icons/bi` — Bootstrap Icons

---

## Slide Backgrounds

```javascript
// Solid color
slide.background = { color: 'F1F1F1' };

// Color with transparency
slide.background = { color: 'FF3399', transparency: 50 };

// Image from URL
slide.background = { path: 'https://example.com/bg.jpg' };

// Image from base64
slide.background = { data: 'image/png;base64,iVBORw0KGgo...' };
```

---

## Tables

```javascript
// Basic table
slide.addTable([
  ['Header 1', 'Header 2', 'Header 3'],
  ['Cell 1', 'Cell 2', 'Cell 3']
], {
  x: 1, y: 1, w: 8,
  border: { pt: 1, color: '999999' }, fill: { color: 'F1F1F1' },
  colW: [2, 3, 3],       // Per-column widths (inches)
  rowH: [0.5, 0.4]       // Per-row heights (inches)
});

// Styled cells with merge
var tableData = [
  [
    { text: 'Category', options: { bold: true, color: 'FFFFFF', fill: { color: '4472C4' }, align: 'center', valign: 'middle' } },
    { text: 'Q1', options: { bold: true, color: 'FFFFFF', fill: { color: '4472C4' }, align: 'center' } },
    { text: 'Q2', options: { bold: true, color: 'FFFFFF', fill: { color: '4472C4' }, align: 'center' } }
  ],
  [{ text: 'Revenue Breakdown', options: { colspan: 3, bold: true, fill: { color: 'D9E2F3' } } }],
  ['Product A', '$2.4M', '$2.8M'],
  ['Product B', '$1.1M', '$1.5M']
];
slide.addTable(tableData, { x: 1, y: 1.5, w: 8, colW: [3, 2.5, 2.5], border: { pt: 1, color: 'CCCCCC' } });

// Rowspan (vertical merge)
{ text: 'Merged', options: { rowspan: 2, fill: { color: '99FFCC' }, valign: 'middle' } }

// Per-edge borders: [top, right, bottom, left] — null to hide an edge
{ border: [{ pt: 2, color: 'FF0000' }, null, { pt: 2, color: '0000FF' }, null] }

// Auto-paging for long tables
{ autoPage: true, autoPageRepeatHeader: true, autoPageHeaderRows: 1, autoPageSlideStartY: 0.5 }
```

Alternating row colors pattern:

```javascript
var data = [['Name', 'Value', 'Status'], ['Alpha', '100', 'Active'], ['Beta', '200', 'Pending'], ['Gamma', '300', 'Active']];
var rows = data.map(function(row, i) {
  var fillColor = i === 0 ? '4472C4' : (i % 2 === 0 ? 'F2F2F2' : 'FFFFFF');
  var fontColor = i === 0 ? 'FFFFFF' : '333333';
  return row.map(function(cell) {
    return { text: cell, options: { fill: { color: fillColor }, color: fontColor, bold: i === 0, fontSize: 11 } };
  });
});
slide.addTable(rows, { x: 0.5, y: 1, w: 9, colW: [3, 3, 3], border: { pt: 1, color: 'CCCCCC' } });
```

---

## Charts

```javascript
// Bar chart (vertical columns)
slide.addChart(pres.charts.BAR, [{
  name: 'Sales', labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: [4500, 5500, 6200, 7100]
}], {
  x: 0.5, y: 0.6, w: 6, h: 3, barDir: 'col',
  showTitle: true, title: 'Quarterly Sales'
});

// Horizontal bar chart
slide.addChart(pres.charts.BAR, [chartData], {
  x: 0.5, y: 0.6, w: 6, h: 3, barDir: 'bar'
});

// Stacked bar chart
slide.addChart(pres.charts.BAR, [series1, series2], {
  x: 0.5, y: 0.6, w: 6, h: 3, barDir: 'col', barGrouping: 'stacked'
});

// Line chart
slide.addChart(pres.charts.LINE, [{
  name: 'Temp', labels: ['Jan', 'Feb', 'Mar'], values: [32, 35, 42]
}], { x: 0.5, y: 4, w: 6, h: 3, lineSize: 3, lineSmooth: true });

// Pie chart
slide.addChart(pres.charts.PIE, [{
  name: 'Share', labels: ['A', 'B', 'Other'], values: [35, 45, 20]
}], { x: 7, y: 1, w: 5, h: 4, showPercent: true });

// Doughnut chart
slide.addChart(pres.charts.DOUGHNUT, [{
  name: 'Status', labels: ['Complete', 'In Progress', 'Not Started'], values: [60, 25, 15]
}], { x: 7, y: 1, w: 5, h: 4, showPercent: true, dataLabelPosition: 'outEnd' });

// Area chart
slide.addChart(pres.charts.AREA, [{
  name: 'Revenue', labels: ['Jan', 'Feb', 'Mar', 'Apr'], values: [100, 120, 115, 140]
}], { x: 0.5, y: 1, w: 6, h: 3, chartColors: ['0D9488'], chartColorsOpacity: 50 });
```

### Better-Looking Charts

Default charts look dated. Apply these options for a modern, clean appearance:

```javascript
slide.addChart(pres.charts.BAR, chartData, {
  x: 0.5, y: 1, w: 9, h: 4, barDir: 'col',

  // Custom colors (match your presentation palette)
  chartColors: ['0D9488', '14B8A6', '5EEAD4'],

  // Clean background
  chartArea: { fill: { color: 'FFFFFF' }, roundedCorners: true },

  // Muted axis labels
  catAxisLabelColor: '64748B',
  valAxisLabelColor: '64748B',

  // Subtle grid (value axis only)
  valGridLine: { color: 'E2E8F0', size: 0.5 },
  catGridLine: { style: 'none' },

  // Data labels on bars
  showValue: true,
  dataLabelPosition: 'outEnd',
  dataLabelColor: '1E293B',

  // Hide legend for single series
  showLegend: false
});
```

---

## Charts — Advanced Types

### Scatter Chart

Scatter charts use X-axis values as the first data series:

```javascript
var scatterData = [
  { name: 'X-Axis', values: [1, 2, 3, 4] },
  { name: 'Series A', values: [33, 20, 51, 65] },
  { name: 'Series B', values: [21, 25, 32, 49] }
];
slide.addChart(pres.charts.SCATTER, scatterData, {
  x: 0.5, y: 0.6, w: 6, h: 4,
  lineSize: 0,                   // 0 = dots only, >0 = connected
  dataLabelPosition: 'r',        // 't' | 'b' | 'l' | 'r' | 'ctr'
  showCatAxisTitle: true, catAxisTitle: 'X Values',
  showValAxisTitle: true, valAxisTitle: 'Y Values'
});
```

### Bubble Chart

Bubble charts add a `sizes` array to each data series:

```javascript
var bubbleData = [
  { name: 'X-Axis', values: [0.3, 0.6, 0.9, 1.2] },
  { name: 'Group A', values: [1.3, 9, 7.5, 2.5], sizes: [1, 4, 2, 3] },
  { name: 'Group B', values: [5.0, 3, 2.0, 7.0], sizes: [9, 7, 9, 2] }
];
slide.addChart(pres.charts.BUBBLE, bubbleData, {
  x: 0.5, y: 0.6, w: 6, h: 4, showLegend: true, legendPos: 'b',
  chartColors: ['4472C4', 'ED7D31'], chartColorsOpacity: 40,
  dataBorder: { pt: 1, color: 'FFFFFF' }
});
```

### Radar Chart

```javascript
var radarData = [
  { name: 'Student 1', labels: ['Logic', 'Coding', 'Results', 'Comments', 'Runtime'], values: [3, 1, 3, 3, 4] },
  { name: 'Student 2', labels: ['Logic', 'Coding', 'Results', 'Comments', 'Runtime'], values: [1, 2, 2, 3, 2] }
];

slide.addChart(pres.charts.RADAR, radarData, {
  x: 0.5, y: 0.6, w: 6, h: 4,
  radarStyle: 'marker',         // 'standard' | 'marker' | 'filled'
  chartColors: ['4472C4', 'ED7D31'],
  showLegend: true, legendPos: 'b'
});
```

### Combo / Dual-Axis Chart

Pass an **array** of chart type objects to `addChart()` instead of a single chart type:

```javascript
var barData = [
  { name: 'Cars (millions)', labels: ['2020', '2021', '2022', '2023'], values: [10, 12, 14, 18] }
];
var lineData = [
  { name: 'Market Share (%)', labels: ['2020', '2021', '2022', '2023'], values: [8, 10, 12, 16] }
];

var comboTypes = [
  {
    type: pres.charts.BAR,
    data: barData,
    options: { chartColors: ['4472C4'] }
  },
  {
    type: pres.charts.LINE,
    data: lineData,
    options: { chartColors: ['F38940'], secondaryValAxis: true, secondaryCatAxis: true }
  }
];

var comboOpts = {
  x: 0.5, y: 0.6, w: 9, h: 4.5,
  barDir: 'col',
  showLegend: true, legendPos: 'b',
  valAxes: [
    { showValAxisTitle: true, valAxisTitle: 'Cars (millions)', valAxisTitleColor: '4472C4', valAxisLabelColor: '4472C4' },
    { showValAxisTitle: true, valAxisTitle: 'Market Share (%)', valAxisTitleColor: 'F38940', valAxisLabelColor: 'F38940', valGridLine: { style: 'none' } }
  ],
  catAxes: [
    { catAxisTitle: 'Year' },
    { catAxisHidden: true }
  ]
};

slide.addChart(comboTypes, comboOpts);
```

**CRITICAL — all three are required for a valid combo chart:**
1. `secondaryValAxis: true` and `secondaryCatAxis: true` on the secondary series options
2. `valAxes: [{...}, {...}]` array with exactly 2 entries in the chart options
3. `catAxes: [{...}, { catAxisHidden: true }]` array with exactly 2 entries in the chart options

Omitting `catAxes` or `valAxes` produces a corrupt file that PowerPoint cannot open without repair. The secondary `catAxes` entry should always have `catAxisHidden: true`.

---

## Charts — Styling Reference

All options below go inside the chart options object passed to `addChart()`:

```javascript
{
  // Axis titles
  showCatAxisTitle: true, catAxisTitle: 'Quarters', catAxisTitleColor: '333333',
  catAxisTitleFontFace: 'Arial', catAxisTitleFontSize: 12,
  showValAxisTitle: true, valAxisTitle: 'Revenue ($M)', valAxisTitleColor: '333333',

  // Axis labels
  catAxisLabelColor: '64748B', catAxisLabelFontSize: 10, catAxisLabelRotate: 45,
  valAxisLabelColor: '64748B', valAxisLabelFontSize: 10,
  valAxisLabelFormatCode: '$#,##0',  // '#,##0' | '#%' | '0.0'
  valAxisDisplayUnit: 'millions',    // 'thousands' | 'millions' | 'billions'
  valAxisMinVal: 0, valAxisMaxVal: 100,

  // Grid lines ('solid' | 'dash' | 'dot' | 'none')
  valGridLine: { color: 'E2E8F0', size: 0.5 },
  catGridLine: { style: 'none' },

  // Legend
  showLegend: true, legendPos: 'b',  // 'b' | 't' | 'l' | 'r' | 'tr'
  legendFontSize: 10, legendColor: '404040',

  // Data labels
  showValue: true, showPercent: true, showSerName: true,
  dataLabelPosition: 'outEnd',       // 'outEnd' | 'inEnd' | 'ctr' | 'bestFit'
  dataLabelColor: '1E293B', dataLabelFontSize: 10, dataLabelFormatCode: '#,##0',

  // Series colors & chart area
  chartColors: ['0D9488', '14B8A6', '5EEAD4'], chartColorsOpacity: 80,
  chartArea: { fill: { color: 'FFFFFF' }, roundedCorners: true },
  plotArea: { fill: { color: 'F8FAFC' } },

  // Log scale
  valAxisLogScaleBase: 10  // Range: 2-99
}
```

---

## Slide Masters

```javascript
pres.defineSlideMaster({
  title: 'TITLE_SLIDE',
  background: { color: '283A5E' },
  objects: [{
    placeholder: {
      options: { name: 'title', type: 'title', x: 1, y: 2, w: 8, h: 2 }
    }
  }]
});

var titleSlide = pres.addSlide({ masterName: 'TITLE_SLIDE' });
titleSlide.addText('My Title', { placeholder: 'title' });
```

Masters support background, slide numbers, and objects (shapes, images, text, placeholders).

---

## Media

```javascript
// Video from file
slide.addMedia({
  type: 'video',
  path: 'video.mp4',
  x: 1, y: 1, w: 6, h: 3.38,
  cover: 'video-cover.png'   // Optional thumbnail image
});

// Audio from file
slide.addMedia({
  type: 'audio',
  path: 'audio.mp3',
  x: 1, y: 1, w: 3, h: 3,
  cover: 'audio-cover.png'
});

// YouTube embed (requires PowerPoint v16+ / Microsoft 365)
slide.addMedia({
  type: 'online',
  link: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
  x: 1, y: 1, w: 8, h: 4.5,
  cover: 'yt-cover.png'
});
```

Supported video formats: MP4, M4V, MOV, AVI. Supported audio formats: MP3, WAV, AIF.

---

## Theme Patterns

Define color and font constants at the top of your code for consistent theming. Use **factory functions**, not shared objects (to avoid mutation — see Common Pitfalls).

```javascript
// Color palette
var COLORS = { primary: '1E2761', secondary: 'CADCFC', accent: 'FFFFFF', text: '333333', muted: '999999' };

// Font theme
var FONTS = { heading: 'Georgia', body: 'Calibri' };

// Style factories (NEVER share objects — always return fresh ones)
var titleStyle = function() {
  return { fontFace: FONTS.heading, fontSize: 36, bold: true, color: COLORS.accent };
};
var bodyStyle = function() {
  return { fontFace: FONTS.body, fontSize: 14, color: COLORS.text };
};
var cardShadow = function() {
  return { type: 'outer', color: '000000', blur: 6, offset: 2, angle: 135, opacity: 0.1 };
};

// Apply to slides
var slide = pres.addSlide();
slide.background = { color: COLORS.primary };
slide.addText('Welcome', Object.assign(titleStyle(), { x: 1, y: 2, w: 8, h: 1.5, align: 'center' }));
```

See `skill.md` Color Palettes table for theme inspiration.

---

## Common Pitfalls

These issues cause file corruption, visual bugs, or broken output. Avoid them.

1. **NEVER use `#` with hex colors** — causes file corruption
   ```javascript
   color: 'FF0000'      // CORRECT
   color: '#FF0000'     // WRONG
   ```

2. **NEVER encode opacity in hex color strings** — 8-char colors (e.g., `'00000020'`) corrupt the file. Use the `opacity` property instead.
   ```javascript
   shadow: { type: 'outer', blur: 6, offset: 2, color: '00000020' }          // CORRUPTS FILE
   shadow: { type: 'outer', blur: 6, offset: 2, color: '000000', opacity: 0.12 }  // CORRECT
   ```

3. **Use `bullet: true`** — NEVER unicode symbols like `'•'` (creates double bullets)

4. **Use `breakLine: true`** between array items or text runs together

5. **Avoid `lineSpacing` with bullets** — causes excessive gaps; use `paraSpaceAfter` instead

6. **Each presentation needs fresh instance** — don't reuse `pptxgen()` objects

7. **NEVER reuse option objects across calls** — pptxgenjs mutates objects in-place (e.g. converting shadow values to EMU). Use factory functions:
   ```javascript
   var shadow = { type: 'outer', blur: 6, color: '000000', opacity: 0.15 };
   slide.addShape(pres.shapes.RECTANGLE, { shadow, ... });  // WRONG — second call gets converted values
   slide.addShape(pres.shapes.RECTANGLE, { shadow, ... });

   var makeShadow = function() { return { type: 'outer', blur: 6, color: '000000', opacity: 0.15 }; };
   slide.addShape(pres.shapes.RECTANGLE, { shadow: makeShadow(), ... });  // CORRECT
   ```

8. **Don't use `ROUNDED_RECTANGLE` with accent borders** — rectangular overlay bars won't cover rounded corners. Use `RECTANGLE` instead.

9. **Slide transitions are NOT supported** — pptxgenjs has no API for transition effects between slides.

10. **Text columns are NOT supported** — use a table with invisible borders as a workaround for multi-column text layouts.

11. **Shape grouping is NOT supported** — render shapes individually; first drawn = bottom layer.

12. **Use `const` by default** — all declarations are scoped per execution (the sandbox wraps code in an IIFE). Nothing persists across `run_javascript` calls. For cross-call state, use `session.myKey = value`.

13. **Use single quotes for text content** — double-quoted strings break when content contains quotes (legal terms like "Amendment", "Provider"). `'This "Amendment" to the...'` is safer than `"This \"Amendment\" to the..."`.

14. **`writeFile` returns a Promise** — use `await` inside an async context or `.then()` to ensure the file is written before the script exits.
    ```javascript
    pres.writeFile({ fileName: 'output.pptx' }).then(function() {
      console.log('File saved');
    });
    ```

15. **NEVER call `writeFile()` more than once** — pptxgenjs mutates shadow objects in-place during `writeFile()`, converting pt→EMU. A second call re-converts the already-converted values, producing absurd values (e.g., `blurRad="967740000"` instead of `76200`). PowerPoint strips elements with these values, causing content loss and "needs repair." If the first `writeFile()` fails (e.g., ENOENT), the `pres` object is already corrupted — you cannot retry. Always ensure the output directory exists before saving.

16. **Use RELATIVE paths for `writeFile()`** — save to the current working directory with `pres.writeFile({ fileName: 'output.pptx' })`. Do NOT use absolute paths like `/tmp/workspace/output.pptx` — the directory may not exist, causing ENOENT errors and the double-write corruption from pitfall #15.

17. **Combo charts REQUIRE `catAxes` and `valAxes` arrays** — using only `secondaryValAxis: true` and `secondaryCatAxis: true` flags without the axis arrays produces a corrupt file. pptxgenjs only generates 2 axis definitions instead of 4, but references 5+ axis IDs. PowerPoint detects the mismatch and triggers "needs repair." Always provide both arrays as shown in the Combo / Dual-Axis Chart example above.

---

## Quick Reference

- **Shapes**: RECTANGLE, ROUNDED_RECTANGLE, OVAL, LINE, DIAMOND, ISOSCELES_TRIANGLE, RIGHT_ARROW, DOWN_ARROW, STAR_5_POINT, HEART, CLOUD, CHEVRON, HEXAGON, CUBE
- **Charts**: BAR, LINE, PIE, DOUGHNUT, AREA, SCATTER, BUBBLE, BUBBLE3D, RADAR, BAR3D
- **Layouts**: LAYOUT_16x9 (10" x 5.625"), LAYOUT_16x10, LAYOUT_4x3, LAYOUT_WIDE
- **Alignment**: `'left'`, `'center'`, `'right'`, `'justify'`
- **Vertical align**: `'top'`, `'middle'`, `'bottom'`
- **Chart data labels**: `'outEnd'`, `'inEnd'`, `'ctr'`, `'bestFit'`
- **Slide properties**: `slide.slideNumber`, `slide.addNotes()`, `slide.hidden`
- **Media types**: `'video'`, `'audio'`, `'online'`
- **Bar directions**: `barDir: 'col'` (vertical), `barDir: 'bar'` (horizontal)
- **Bar grouping**: `barGrouping: 'clustered'` (default), `'stacked'`, `'percentStacked'`
- **Radar styles**: `radarStyle: 'standard'`, `'marker'`, `'filled'`
