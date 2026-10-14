---
name: dataviz
description: "Chart and data-display reference. Form choice, scale, color, marks, interaction, and the failure modes that make a chart look machine-made. Read before drawing any chart, sparkline, KPI tile, or data table."
when_to_use: Load whenever numbers are being drawn rather than listed — a chart, graph, sparkline, KPI row, dashboard panel, or a data table with totals.
---

A chart is an argument about numbers. Everything below serves that argument; none
of it is decoration. Read this before writing chart code, not after.

## 1. Choose the form from the data, not from taste

| The data is | Draw | Because |
| --- | --- | --- |
| a value changing over time | line (or area when the total matters) | the eye reads slope, not height |
| comparing a few categories | horizontal bars | labels read straight, lengths compare honestly |
| a distribution | histogram, or a strip plot when there are few points | the shape is the finding |
| parts of one whole, 2-4 slices | stacked bar or a labelled set of bars | a pie beyond four slices cannot be read |
| two measures, one driver | scatter, with a fitted line only when it exists | correlation is shown by position, not by ranking |
| rates that vary by a base | a rate chart, not a count chart | counts hide the denominator |

Never choose a form the data cannot reach: a pie for a rate, a line for unordered
categories, a stacked bar for values that cross zero. If the reader must convert
units in their head, the form is wrong.

**One chart, one question.** If two questions need answering, draw two charts.
Dual axes are almost always a way to imply a relationship the data does not show;
use them only when both axes share a unit and you say so in the caption.

## 2. One scale, stated once

- Marks, ticks, and labels come from a single scale. Every label names a value the
  data actually reaches — no rounded-up ceilings that invent headroom, no grids
  whose top line no series touches.
- Bars start at zero. Lines may not, but say so in the axis label when they don't.
- Tick labels are the numbers themselves, formatted for the reader: `1,240`, `1.2k`,
  `€18`, `12ms`. The unit belongs in the axis label, not repeated on every tick.
- Fewer ticks, more precision: 4-6 gridlines beat a dense ruled field. Draw the
  gridlines faint, behind the marks, and omit the vertical ones on a time axis
  unless the periods matter.
- Label directly where the series is short and the lines are distinct: a label at
  the end of a line beats a legend box the eye has to shuttle back and forth to.

## 3. Color: semantics separate from accent

- **Categorical** series get hues that are equally legible and equally distinctive
  in both themes; cap it at six, then group the rest as "other" or split the chart.
- **Sequential** data gets one hue, light to dark. **Diverging** data gets two hues
  meeting at a neutral midpoint, and the midpoint is a real value (zero, budget).
- **Semantic** colors (good / warning / critical) are a separate vocabulary from the
  page's accent and are never used as the accent. A dashboard whose accent is red
  cannot also use red for "critical".
- Pull every chart color from the theme tokens so both themes read. A hard-coded
  `#333` label is invisible in dark mode; a hard-coded white fill is invisible in
  light.
- Never let color carry a distinction alone: pair it with a dash pattern, a marker
  shape, or a direct label, so the chart survives being read in greyscale or by
  someone who cannot separate red from green.
- Chart text sits on the same background as the page. No white boxes behind labels
  unless the labels overlap marks, and then a token-colored halo, not a rectangle.

## 4. Marks and anatomy

Budget for the frame before drawing the data: the drawing area, the axis labels,
the end labels, and the title all need room.

- Lines: 2px, round caps, no shadow. A single emphasized series may be 2.5px with
  the rest at 1.5px — width is a ranking device, so don't use it decoratively.
- Bars: 4px radius at most, gaps about a third of the bar width, and never narrower
  than 6px in a dense series; above ~40 bars, drop to a histogram or aggregate.
- Points: 6-8px markers, and only where a reader needs to see individual readings.
  A line with 400 hidden markers is not a scatter plot.
- Area fills: a 10-20% tint of the line's hue, never a gradient standing in for data.
- Sparklines: no axes, no labels beyond the endpoint value, an area fill, a faint
  baseline, and an emphasized last point. They live in a table cell or a tile, not
  in a card with a title.
- In SVG, leave room in `viewBox` for the outermost labels and give every drawn
  shape an explicit `fill`; a missing fill renders black and reads as a bug.

## 5. Numbers in text and tiles

- KPI tiles open with the figure, then the label, then the comparison and its
  period. A tile whose number is not the point of the page is a decoration with a
  number in it — use a sentence instead.
- Format consistently: the same unit, the same decimal places, the same thousands
  separator, everywhere the number appears. `12.4%` in a tile and `0.124` in the
  table is the same number twice and looks like two.
- Show movement as a signed change with a period (`+8% vs. last month`), never as a
  bare arrow. An arrow without a baseline is a claim with no content.
- Round at the precision the decision needs. A dashboard of percentages does not
  need four decimals.

## 6. States, interaction, accessibility

- Design the four states, not just the full one: loading (a skeleton in the chart's
  own shape), empty (say what would put data here), error (say what failed), and
  partial (mark the gap; interpolating missing time is a lie).
- Tooltips follow the pointer, name the value and the unit, and do not cover the
  point being read. Freeze on click or drag for comparison.
- A filter either keeps the scale (so change is comparable) or explicitly
  re-scales and says so. Silent re-scaling is how a 2% movement looks catastrophic.
- Legend entries toggle series when the chart is the interface; state the disabled
  ones rather than removing them from the legend.
- Give the chart an accessible name and, where the numbers decide anything, a table
  view of the same values. The chart is a summary of data that must exist somewhere.

## 7. Failure modes that make a chart look machine-made

- Decorative gradient fills standing in for data, or a glow on a line.
- 3D bars, tilted pies, drop shadows under marks, rounded "capsule" bars.
- A dual axis implying a correlation the data does not support.
- Y-axes that don't start at zero for bars, or that change between panels meant to
  be compared.
- Rainbow categorical palettes with six equally loud hues and no emphasis.
- Legends for two series that could have been labelled directly.
- Chartjunk tick fields: a gridline every 5px, every value labelled.
- Numbers in the copy that disagree with the chart — a caption saying "roughly
  double" over a chart showing +40%.
- A "live" readout with no timestamp, so it is never clear how old it is.
