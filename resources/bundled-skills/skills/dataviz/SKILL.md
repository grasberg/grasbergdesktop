---
name: dataviz
description: Use this skill whenever you are about to create ANY chart, graph, plot, dashboard, or data visualization, in ANY output medium — an HTML or React artifact, inline SVG, plotting code in any library (matplotlib, plotly, d3, Recharts, …), an image/PNG you will render and upload, or a chart shared into Slack. Read it BEFORE writing the first line of chart code, choosing chart colors, building a stat tile / meter / KPI row, or laying out a dashboard. Produces visualizations that read as one system — elegant, accessible, consistent in light and dark — using a brand-neutral placeholder palette you swap for your own. Teaches a design-system-agnostic method: a form heuristic, a color formula with a runnable validator, mark specs, and interaction rules. A validated default palette is documented in `references/palette.md` — swap that file's values for your brand's. Triggers on: "chart", "graph", "plot", "data viz", "visualization", "dashboard", "analytics", "visualize data", "categorical colors", "sequential / diverging palette", "stat tile", "sparkline", "heatmap", "legend", "axis", "tooltip", "chart colors", "color by series".
---

# Data Visualization

A chart is **read by people and executed by you**. This skill turns "make it look
good" into a procedure with checks, so the result is right by construction rather
than by taste.

**The method here is design-system-agnostic.** Nothing in the procedure, the form
heuristic, the six checks, or the mark specs is specific to one product. A design
system supplies a small set of *parameters* (its ramps, a categorical order, a
diverging pair, a status palette, a texture, its surfaces, its filter components);
the method consumes them unchanged. A **validated default palette** is the
reference instance, fully specified in `references/palette.md`. To target your
brand, read that file's structure and substitute its values — touch nothing else.

> The single most important habit: **the color part is computable, so compute it.**
> Never eyeball whether a palette is colorblind-safe — run `scripts/validate_palette.js`.

## The procedure — do these in order

Color comes LAST. Most bad charts pick colors first.

1. **Pick the form.** What is the data's job — magnitude, identity, polarity, a
   single headline, change-over-time? The job picks the chart type, and sometimes
   the answer is *not a chart* (a stat tile or hero number). → `references/choosing-a-form.md`
2. **Assign color by the job it does.** Categorical (identity), sequential
   (magnitude), diverging (polarity), or status (state) — each has one rule.
   Assign categorical hues in fixed order, never cycled. → `references/color-formula.md`
3. **VALIDATE the palette — run the script, don't reason about ΔE.**
   `node scripts/validate_palette.js "<hex,hex,…>" --mode light` (relative to
   this skill's base directory — or load it as `<script type="module">` in the
   chart's own page, where it reads
   `data-palette` off `<body>` and logs a `console.table` report). It returns
   pass/fail on the lightness band, chroma floor, adjacent-pair CVD separation,
   and contrast. Fix anything that FAILs before continuing. Re-run for
   `--mode dark` with that mode's surface.
4. **Apply mark specs & spacers.** Thin marks, 4px rounded data-ends anchored to
   the baseline, 2px lines, ≥8px markers, a 2px surface gap between fills (stacked
   segments and adjacent bars alike) and a 2px surface ring on overlapping marks,
   selective direct labels. → `references/marks-and-anatomy.md`
5. **Add the hover layer — by default.** An HTML/SVG chart *is* interactive; ship
   a crosshair+tooltip on line/area and a per-mark hover tooltip on bar/dot/cell.
   The only form that skips it is a bare stat tile with no plot. Hit targets bigger
   than the mark; filters in one row above the charts. → `references/interaction.md`
6. **Final accessibility pass.** For ≥ 2 series a legend is always present and ≤ 4
   are also direct-labeled (a single series needs no legend box — the title names
   it), so identity is never color-alone; a table view exists; dark mode is **selected** — its own
   steps from the same ramps, validated against the dark surface, not an automatic
   flip; texture is available for the CVD/print/forced-colors case.
7. **Render it and look at it.** The validator checks color, not layout — open or
   screenshot the output and eyeball it for label collisions, geometry, and overflow
   before calling it done.

Then check the result against **`references/anti-patterns.md`** — it is the catalog
of what goes wrong. If your chart matches an entry, it's wrong.

## Non-negotiables (true in every design system)

- **Assign categorical hues in fixed order, never cycled.** A 9th series is never a
  generated hue — it folds into "Other," small multiples, or composite encoding.
- **One axis.** Never a dual-axis chart (two y-scales). Two measures of different
  scale → two charts, small multiples, or indexed to a common base. *(This is the
  #1 chart mistake — see anti-patterns.)*
- **Color follows the entity, never its rank.** A filter that changes the series
  count must not repaint the survivors.
- **Sequential = one hue, light→dark. Diverging = two hues + a neutral gray
  midpoint.** Never a rainbow; never a hue at the diverging midpoint.
- **Run the validator before shipping any categorical palette.** CVD ≥ 12 is the
  target; 8–12 is a floor that is legal ONLY with secondary encoding. A contrast WARN
  obligates visible labels or a table view — it is not dismissable.
- **Thin marks; a legend always present for ≥ 2 series (none for one), with
  selective direct labels (never a number on every point); recessive grid/axes.**
- **Text wears text tokens, never the series color** — values, labels, and legends
  stay in primary/secondary/muted ink; a colored mark beside them carries identity.
- **Status colors are reserved** (good/warning/serious/critical) and never reused
  for "series 4"; they ship with an icon + label, never color alone.

## Plugging in a design system

The method is invariant; only these parameters change per system. The reference
instance — every value filled in — is `references/palette.md`.

| Parameter | What the system provides |
|---|---|
| **Ramps** | the hue scales (named steps) the palette draws from |
| **Categorical theme** | the fixed hue order (a named theme); default + alternates |
| **Sequential hue** | the default single hue for magnitude |
| **Diverging pair** | two warm/cool poles + a neutral midpoint |
| **Status palette** | good / warning / serious / critical — steps distinct from categorical |
| **Texture fill** | one directional hand-drawn fill, used at 45° / 135° |
| **Surfaces** | light & dark chart-surface colors (the validator needs these) |
| **Filter controls** | date-range & dimension controls (behavioral spec in `interaction.md`) |

To onboard a new system: fill those rows, feed its ramps to the validator, and let
it snap each slot to the nearest passing step. Structure and rules stay as written.

## Reference files

| File | What it answers |
|------|-----------------|
| `references/choosing-a-form.md` | Which chart type / is it even a chart? |
| `references/color-formula.md` | The four jobs, the six checks, snap-to-passing |
| `references/marks-and-anatomy.md` | Mark specs, spacers, labels, figures, hero number |
| `references/interaction.md` | Tooltips & hover, filters & time ranges |
| `references/components.md` | The pieces a chart is made of — build each in plain HTML |
| `references/anti-patterns.md` | **What goes wrong — check every chart against this** |
| `references/palette.md` | **The reference palette instance** — every parameter, filled in; swap for your brand's |
| `scripts/validate_palette.js` | Runnable six-checks validator (run it; don't eyeball) |


---

# Appendices

The reference files mentioned in this skill are included below.


---

## Appendix: references/choosing-a-form.md

# Choosing a form

Decide this **before** color. The data's job picks the form — and sometimes the
right form is not a chart.

## Is it even a chart?

| The data is… | Use | Not |
|---|---|---|
| A single current value (+ maybe a trend) | **Stat tile** (value + delta + sparkline) | A one-bar bar chart |
| A handful of headline numbers | **KPI row** of stat tiles | A grouped bar chart |
| The one number a dashboard leads with | **Hero figure** (≥48px, sans) | — |
| A single ratio against a limit | **Meter** (same-ramp track) | A pie of 2 slices |
| More than ~7 classes that all carry meaning | A **table** (or table + chart) | More colors |

If a chart *is* right, pick the type by the job:

## The job → the type

| Job (what the reader must do) | Default form | Color job |
|---|---|---|
| Compare magnitude, low → high | bar / column; **heatmap** for a grid | sequential (one hue) |
| Trend over time | line; area for a single series | sequential or 1 categorical |
| Tell distinct series apart | grouped/stacked bar, multi-line | **categorical** |
| One series is the point, rest are context | **emphasis** (highlight one, gray the rest) | 1 hue + gray |
| Above/below a baseline; Δ to target | diverging bar, or line vs baseline | diverging |
| Part-to-whole | **stacked bar** (go horizontal for many / long-named categories) | categorical |
| Ordered-scale share (Likert, sentiment, agree↔disagree) | **diverging stacked bar**, centered on neutral | diverging |
| Before → after per item | dumbbell | 1 hue, 2 shades |

## The rules behind the table

- **Sequential is the safe default.** One hue, more-is-darker. It stays legible and
  consistent and is hard to misread. Reach for it unless the data's job is
  specifically *identity* or *polarity*.
- **Categorical is for when the series ARE the subject** — and it has a real cost:
  it can bury the one data point that actually matters. If the story is "this one
  went up," that's **emphasis**, not categorical.
- **Emphasis** = the most underused form. One series in the accent hue, the rest in
  the de-emphasis gray. Often the honest answer to "make this chart clearer."
- **Texture is an opt-in expression, not a default form.** It earns its place only
  for accessibility (full CVD), print/export, and `forced-colors`. Never decorative.
  → see `marks-and-anatomy.md`.

## Series-count ladder (categorical)

| Series | Treatment |
|---|---|
| 1–3 | color alone is comfortable for everyone; direct-label |
| 4 | the CVD floor enters — direct labels become mandatory, not a courtesy |
| 5–6 | soft cap; legend or small multiples |
| 7–8 | token ceiling; past it, fold the tail into "Other," facet into small multiples, or use composite encoding (hue × shape) |

Never solve "too many series" by generating more hues. A generated 9th hue is
indistinguishable from an existing one under CVD and breaks every check.

---

## Appendix: references/color-formula.md

# Color formula

Color is **not hand-picked**. Every chart color does exactly one of four jobs, and a
palette is legal only if it passes six checks. The checks are the product — they are
what makes a palette safe to change and what lets the same method run on any design
system's ramps.

## The four jobs

| Job | What it encodes | Structure |
|---|---|---|
| **Categorical** | identity (which series) | 8 hues, fixed order, assigned in sequence, never cycled |
| **Ordinal** | position in a sequence (funnel stage, tier, bucket) | one hue, monotone lightness steps; light end still ≥ 2:1 on surface |
| **Sequential** | magnitude (how much) | one hue, steps 100→700, light→dark; flips anchor in dark |
| **Diverging** | polarity (which side of a baseline) | two hues + a neutral gray midpoint; equal steps per arm |
| **Status** | state (good→critical) | a small fixed scale, reserved meaning, always icon+label |

**Categorical or ordinal?** If swapping the category order would change the
meaning — funnel stages, size tiers (S/M/L), age bands, cohort buckets — it is
**ordinal** and takes a one-hue ramp so the reader sees the order in the color.
If swapping would not — product names, teams, regions, endpoints — it is
**nominal categorical** and each bar takes the *same* slot-1 hue (one series,
so no legend box — the title names it), or slots 1..N when there are N separate
series. Never color nominal bars by their value: that spends the identity channel
re-encoding what bar length already shows.

## The six checks

Every categorical color — current or proposed — must pass all six.

1. **Fixed hue anchors.** Eight families in a fixed order. The order is the
   CVD-safety mechanism; it never changes. *(structural — enforced, not measured)*
2. **Lightness band per mode.** OKLCH L ≈ 0.43–0.77 light; ≈ 0.48–0.67 dark. *(validator)*
3. **Chroma floor.** OKLCH C ≥ ~0.10 — below it a hue reads as gray and stops doing
   identity work. *(validator)*
4. **CVD separation.** Machado-2009 ΔE ≥ 12 target / ≥ 8 floor (floor legal only with
   secondary encoding), under protanopia & deuteranopia. *Adjacent* pairs for
   stacks/bars/lines (only neighbors touch — assignment never skips); **all pairs for
   scatter, bubble, choropleth, and small-multiples**, where any two marks can sit side
   by side — pass `--pairs all` there or a real collapse stays hidden. *(validator)*
5. **Contrast vs surface.** ≥ 3:1 for marks; conditionally relaxed where values are
   readable another way (visible labels or the table view). *(validator)*
6. **Documented palette only.** Every slot is a hex from the instance file
   (`palette.md` or its equivalent) — no eyeballed values. *(structural; for a
   customer's ramps, snap to nearest — below)*

## Run the checks — never eyeball them

```
node scripts/validate_palette.js \
  "#2a78d6,#1baf7a,#eda100,#008300,#4a3aa7,#e34948,#e87ba4,#eb6834" --mode light
```

(`scripts/` is relative to this skill's base directory, shown at the top of the prompt.)

(or load it as `<script type="module">` in the chart's own page — it reads
`data-palette` off `<body>` and logs a `console.table` report)

Reports each computable check (2–5) with PASS / WARN / FAIL plus the worst CVD pair.
Exit 0 = no hard FAIL (WARN bands — floor-band CVD 8–12 and sub-3:1 contrast relief —
still exit 0 and require secondary encoding); exit 1 on any FAIL. Run once per mode
(`--mode dark --surface "#1a1a19"`), and add
`--pairs all` for scatter / bubble / map / small-multiples charts (where any two marks
can be neighbors — the default adjacent check would hide a collapse). For an
**ordinal** ramp pass `--ordinal` — it switches to the ramp checks (monotone L,
adjacent ΔL ≥ 0.06, light-end contrast ≥ 2.0:1, single hue) instead of the
categorical six.
A WARN on CVD (8–12 floor) is legal **only** if you also ship secondary encoding
(direct labels, gaps, or texture). A WARN on contrast is **not dismissable** — it
obligates a relief channel (visible direct labels or the table view); shipping the
sub-3:1 fill with neither is a fail.

**Scope — what the validator does and doesn't cover.** These six checks validate a
*categorical* palette (series identity). They do **not** judge a lone status/text
color or a sequential ramp. For a single status or text color, run a WCAG *text*-
contrast check (4.5:1 normal, 3:1 large) — `validate_palette.js` exports
`contrast(a, b)` for exactly this. For sequential/diverging, the check is lightness
monotonicity across the ramp, not adjacency CVD — running the categorical validator on
a sequential ramp **will FAIL by design** (it spans the band; steps sit close), which
is expected, not a real failure; don't "fix" a good ramp to satisfy it.

## Snap-to-passing (any design system)

Given a customer's ramps and a desired order:
1. For each slot, pick the step whose OKLCH L sits in the mode's band and C ≥ floor.
2. Run the validator. For any adjacent pair below ΔE 12, nudge one slot ± a step
   (hold its hue, move its lightness) and re-run.
3. Repeat until the worst adjacent pair clears the floor. Function preserved, the
   customer's hues kept.

## Themes

The slot **order** is a separable, named choice — a *theme* — on the same hues and
the same six checks. Each design system names a default order and any alternates;
swapping themes tunes the mood without touching the method. A surface adopts one
theme and freezes it; never mix themes within a dashboard. (See `palette.md`.)

**Deriving an order when a system has no theme yet:** don't guess. Enumerate candidate
orderings of the system's hues, run the validator on each, and pick the one that
maximizes the *minimum adjacent* CVD ΔE. (Seeding from a known-good order by hue-family
analogy, then optimizing, is fine — this is exactly how the default in
`palette.md` was derived.)

## Status is fixed

Status never follows the theme — it is a small fixed scale (good → warning → serious
→ critical) with reserved meaning, on steps deliberately distinct from the categorical
slots so a status color never impersonates a series, and always paired with an
icon + label (on a light surface warning and serious sit below 3:1 by design —
the pairing is the mitigation). (Exact steps in `palette.md`.) The collision rule: when a series *means* good/bad (error rate, pass/fail) it wears
status tokens; when it's just "series 4" it wears categorical — never both in one chart.

---

## Appendix: references/palette.md

# Reference palette

This is the **reference instance** of the data-viz method: every parameter the
method needs, filled in with a validated default palette. The rest of the skill
is system-agnostic — **to target your brand, substitute this file's values** and
re-run the validator. Nothing else changes.

## How to use these values

Everything below is plain hex. In an HTML chart, **define the slots you use as
CSS custom properties in a local `<style>` block** at the top of the file, then
reference them by role throughout — so the light/dark values swap in one place,
and the chart body is written against roles rather than raw hex:

```css
.viz-root {
  --surface-1:      #fcfcfb;   /* chart surface */
  --text-primary:   #0b0b0b;
  --text-secondary: #52514e;
  --series-1:       #2a78d6;   /* categorical slot 1 */
  /* …only the roles this chart uses */
}
@media (prefers-color-scheme: dark) {
  .viz-root {
    --surface-1:      #1a1a19;
    --text-primary:   #ffffff;
    --text-secondary: #c3c2b7;
    --series-1:       #3987e5;
  }
}
```

## Categorical palette

Both modes are selected. The dark column is the same eight hues stepped for the
dark surface, not a separate palette:

| Slot | Hue | Light | Dark |
|------|-----|-------|------|
| 1 | blue | `#2a78d6` | `#3987e5` |
| 2 | aqua | `#1baf7a` | `#199e70` |
| 3 | yellow | `#eda100` | `#c98500` |
| 4 | green | `#008300` | `#008300` |
| 5 | violet | `#4a3aa7` | `#9085e9` |
| 6 | red | `#e34948` | `#e66767` |
| 7 | magenta | `#e87ba4` | `#d55181` |
| 8 | orange | `#eb6834` | `#d95926` |

Light-mode worst adjacent CVD ΔE is 24.2 — well clear of the ≥12 target. Three
light-mode slots (aqua, yellow, magenta) sit below 3:1 contrast on the light
surface: the **relief rule** applies (ship visible direct labels or the table
view). The dark steps were chosen for the dark band (OKLCH L ≈ 0.48–0.67, ≥ 3:1
on the dark surface) and validated as a set — worst adjacent ΔE 10.3, the floor
band, so four-plus series lean on direct labels or texture in dark mode too.

The slot **ordering** is the CVD-safety mechanism, not cosmetic — it was derived
by enumerating orderings and picking the one that maximizes the minimum adjacent
ΔE (see `color-formula.md` § Themes). When you swap in your brand's hues, do the
same: run the validator on candidate orderings and keep the best.

## Sequential hue

Default single hue: **blue**, light→dark. When two sequential contexts appear at
once, the second takes the next categorical slot's hue (aqua), each as its own
one-hue ramp.

| step | hex | step | hex | step | hex | step | hex |
|---|---|---|---|---|---|---|---|
| 100 | `#cde2fb` | 250 | `#86b6ef` | 400 | `#3987e5` | 550 | `#1c5cab` |
| 150 | `#b7d3f6` | 300 | `#6da7ec` | 450 | `#2a78d6` | 600 | `#184f95` |
| 200 | `#9ec5f4` | 350 | `#5598e7` | 500 | `#256abf` | 650 | `#104281` |
| | | | | | | 700 | `#0d366b` |

The full 100→700 range is for **sequential** encoding (continuous magnitude —
heatmaps, choropleths) where the lightest step means "near zero" and is allowed
to recede toward the surface. For an **ordinal** ramp (discrete ordered marks —
funnel stages, tiers — validated with `--ordinal`), the step nearest the surface
must still clear 2:1: on light, start no lighter than **step 250** (`#86b6ef`,
2.06:1); on dark, go no darker than **step 600** (`#184f95`, 2.15:1).

## Diverging pair

**blue ↔ red** — warm/cool poles that read as opposite. Neutral midpoint is gray
(light `#f0efec`, dark `#383835`). Equal step count per arm. (blue↔aqua was
rejected — both cool, the midpoint doesn't read as "nothing".)

## Status palette (fixed — never themed)

| role | hex | light-surface contrast | dark-surface contrast |
|---|---|---|---|
| good | `#0ca30c` | 3.27 | 5.19 |
| warning | `#fab219` | 1.79 | 9.49 |
| serious | `#ec835a` | 2.57 | 6.60 |
| critical | `#d03b3b` | 4.68 | 3.62 |

Dark: same four steps — all clear 3:1 on the dark surface (`#1a1a19`) and remain
distinct from the dark categorical slots. On the light surface, warning and
serious are sub-3:1 by design; the **icon + label** pairing is the mitigation, so
a status color never carries meaning alone. These steps are deliberately distinct
from the categorical slots so a status color never impersonates a series.

## Texture fill (the accessibility channel)

One hand-drawn **"Lines"** fill, used at **45° and its 135° mirror only**. Inked
tone-on-tone (a darker step of the fill's own ramp). On value scales it is
*ordered* (rotation steps with magnitude; arm angle carries the diverging sign).
Triggered by the accessibility setting, print, or `forced-colors` — never
decorative, never on by default.

## Surfaces (for the validator)

- Light chart surface: `#fcfcfb`
- Dark chart surface: `#1a1a19`

These are the validator's built-in defaults. **When you swap in your own
palette, re-run against your own surfaces:**
`--surface <your-light> --mode light` and `--surface <your-dark> --mode dark` —
contrast and band results are only meaningful against the surface the chart
actually renders on.

## Chart chrome & ink

| Role | Light | Dark |
|---|---|---|
| Chart surface | `#fcfcfb` | `#1a1a19` |
| Page plane | `#f9f9f7` | `#0d0d0d` |
| Primary ink | `#0b0b0b` | `#ffffff` |
| Secondary ink | `#52514e` | `#c3c2b7` |
| Muted (axis/labels) | `#898781` | `#898781` |
| Gridline (hairline) | `#e1e0d9` | `#2c2c2a` |
| Baseline / axis | `#c3c2b7` | `#383835` |
| Delta ↑ good (success text) | `#006300` | `#0ca30c` |
| Border (hairline ring) | `rgba(11,11,11,0.10)` | `rgba(255,255,255,0.10)` |

## Filter controls

Filters are standard UI, not chart components — the chart layer only adds the
composition rules in `interaction.md`. A date-range control is a list of preset
rows (today, last 7/30/90 days, month-to-date) with selection marked by a 16px
bold check, hover as a ghost wash, and custom range behind a hairline in the
footer. Dimension filters are a standard combobox.

## Typeface & figures

Everything — including the hero figure — stays in the system sans: `system-ui,
-apple-system, "Segoe UI", sans-serif`. No display or serif face anywhere. Large
standalone numbers (hero figure, stat-tile values) use the default proportional
figures; reserve `font-variant-numeric: tabular-nums` for columns that must align
vertically (table rows, axis ticks). Substitute your brand's UI sans here.

---

## Appendix: references/marks-and-anatomy.md

# Marks & anatomy

The quiet, considered look is a few fixed specs plus two pieces of negative space.
The data is the only thing allowed to be loud.

## Mark specs (fixed across every chart)

| Mark | Spec |
|---|---|
| Bar / column | **≤ 24px thick** (cap it — never fill the slot; let the band's leftover be air); **4px rounded data-end, square at the baseline**; grows from a single baseline |
| Line | **2px**, round join/cap |
| Marker / end-dot | **≥ 8px** (r ≥ 4), filled with the series color |
| Area fill | the series hue at **~10% opacity** (a wash, never a saturated block) |
| Gridlines / axes | one-step-off-surface gray, **hairline (1px), solid** (never dashed), recessive |

## The two spacers (white doing the separating)

- **Surface gap.** A **2px gap** in the surface color separates touching marks — every
  segment of a stacked bar, and every adjacent (touching) bar, the same width. Keep it
  one consistent width across a stack; neighbors one step apart read distinct because of
  the gap, not a stroke drawn around them.
- **Surface ring.** Dots and end-markers carry a **2px ring in the surface color**,
  so they stay legible where they cross a line or overlap each other. The ring is part
  of the mark's hover/hit target, not just spacing — see `interaction.md` (small dots
  are easy to under-size for hover).

Never draw a border around a mark to separate it. The gap and the ring are the
mechanism; a stroke adds data-weight ink that isn't data.

## Labels & legend

A **legend is always present for two or more series** — the dependable identity
channel; never make the reader rely on color-matching alone. Direct labels then ride
the marks to *supplement* it. **A single series needs no legend box**: there is only
one color, so the chart's title or subtitle already says what is plotted. A box with
one swatch restates the title and costs space.

- **Label selectively — never a number on every point.** A value beside every dot or
  segment is chaos and goes unread. Label the endpoint, the extreme, or the one series
  the story is about; let the axis, the legend, and the tooltip/table carry the rest.
  Direct labels work *because* they are sparing — flood the chart and they stop working.
- **Direct labels before gridlines; gridlines before a second axis.**
- **A label that won't fit doesn't get clipped — measure first.** Only place a label
  *inside* a bar or stacked segment when the rendered text fits with comfortable
  padding on both sides. If it doesn't fit: for a whole bar/column, move the label
  outside the bar end (or to the tooltip if there's no room outside either); for an
  *interior* stacked segment (which has no free end),
  skip the inline label and let the legend + tooltip carry it. Either way the value
  stays in the table view, so nothing is gated. Never use `overflow: hidden` on the
  segment to "solve" it — that crops the first/last characters and is worse than no
  label. Text never overflows or is clipped by its own mark.
- Bars → value at the tip. Columns → value on the cap. Lines → value at the end.
- Y-axis ticks: round to clean numbers (0 / 1,000 / 2,000), thousands-comma'd; they
  carry the values you didn't directly label, so keep them unless every value is labeled.
- **Text never wears the data color.** Marks — bars, lines, dots, area fills — carry
  the series color; labels, values, legends, and axis text use **text tokens**
  (primary / secondary / muted). A light categorical hue (yellow, aqua) is illegible
  as text on the surface. Identity comes from the colored mark *beside* the text — a
  dot, a short line-key, a swatch — never from coloring the text itself. A label set
  *inside* a colored fill (a stacked segment, a map tile) is the one exception: pick
  white or ink by the fill's luminance so it always clears contrast.
- **When end-labels collide, don't stack them.** Direct end-labels work when series
  separate at the right edge. When lines converge, nudging labels apart vertically
  detaches them from their lines and reads as noise — instead use **leader lines**
  (a thin connector from label to line-end), facet into **small multiples**, or fall
  back to the legend + tooltip. Past ~4 converging series, small multiples is usually right.

## Figures — when the form is a number

- **Stat tile** contract: `label` (sentence case, no trailing colon) · `value` (Sans
  semibold, auto-compact: 1,284 / 12.9K / $4.2M) · `delta` (optional; signed,
  vs a named period; color = direction × whether up is good) · `trend` (optional;
  12-point sparkline in the de-emphasis hue, current period in the accent).
- **Meter:** the fill carries severity (accent → warning → danger); the unfilled
  track is a **lighter step of the same ramp** (blue-on-blue, etc.) so state reads
  across the whole bar.
- **Hero figure.** The single number a dashboard leads with, ≥48px, in the same
  sans as everything else (never a display or serif face — it reads as off-brand
  decoration). Exactly one per view.
- **Proportional figures for big numbers; tabular only in columns.** A large
  standalone value (hero figure, stat-tile value) uses the font's default
  proportional figures — `tabular-nums` gives every digit the width of a `0`, so a
  number like `121` looks loose at display sizes. Reserve
  `font-variant-numeric: tabular-nums` for columns of numbers that must align
  vertically (table rows, axis ticks).

## Texture — the backup channel (opt-in)

Where hue fails — full-severity CVD, grayscale print, `forced-colors` — texture
carries identity. One directional hand-drawn fill, used at **45° and its 135° mirror
only** (never horizontal/vertical — those read as gridlines/bars). Inked tone-on-tone
(a step from the fill's own ramp), equal loudness across slots. On value scales the
texture is *ordered* (rotation steps with magnitude; arm angle carries the diverging
sign) so it never misstates the value. Triggered by an accessibility setting, print,
or `forced-colors` — never on by default. (See `palette.md`.)

---

## Appendix: references/interaction.md

# Interaction — tooltips & filters

An HTML chart is interactive by default — the hover layer is part of the deliverable,
not an upgrade. Omitting it is the exception (a bare stat tile), never the default.
Design it with the same care as the static render.

## Tooltips & hover

Tooltips **enhance, they never gate**: every value a tooltip shows is also reachable
without it, through direct labels or the table view. Same details on keyboard focus
as on hover.

- **The crosshair finds the X.** A vertical hairline tracks the pointer and snaps to
  the nearest data position. Readers aim at a date, never at a 2px line.
- **On bars and cells, the mark is the hit target.** No crosshair — each bar, segment,
  dot, or heat-cell carries its own `pointermove`/`focus` tooltip showing category and
  value, and the hovered mark lifts (slight lighten or outline) so the reader sees it respond.
- **One tooltip, every series.** The readout lists every series at that X — the
  pointer never has to land on a line or a fill to get a value.
- **Labels are untrusted data — use `textContent`.** Series and category names
  often come from CSV headers, tool output, or API responses. Insert them into
  tooltip/legend/table DOM with `textContent` or `createTextNode`, never via
  `innerHTML` string concatenation.
- **Values lead, labels follow.** In the tooltip the value is the Strong,
  high-contrast element and the series name is secondary — the legend's hierarchy
  inverted, because here the reader has the series and wants the number.
- **Line keys, not boxes.** Tooltip rows key their series with a short stroke of the
  series color; at tooltip density a filled box is data-weight ink doing a label's
  job. (Legends still mirror the mark: rect for bars/areas, line for lines.)
- **The hit target is bigger than the mark.** A mark's hover/focus area includes its
  2px surface gap and then some — never only the painted pixels. An 8px scatter dot is a
  pinpoint nobody hits reliably; give each point a transparent hit area of at least
  **24px**, or — for dense scatter — a nearest-point / Voronoi layer so the pointer only
  has to be *closest*, not dead-center. (The crosshair already does this for the X on
  line and bar charts; scatter and bubble need the per-point version.)
- **A value pushed off its mark lives in the tooltip.** When a label won't fit inside a
  small bar (see `marks-and-anatomy.md`), that bar's hit area carries the value on hover
  and focus — the tooltip is its overflow home, and the table view keeps it reachable
  without hovering at all.

## Filters & time ranges

Every monitoring dashboard needs the same controls. These are **standard UI, not
chart marks** — build them with ordinary HTML form controls styled to match the
chart chrome. Dataviz only adds composition rules:

- **One row, above the charts.** Filters sit in a single left-aligned row above the
  content they scope — never inside a chart card, never per-chart. If one chart needs
  its own range, it's a different dashboard.
- **Date range first.** It's the filter every reader reaches for; presets (today,
  last 7 / 30 / 90 days) before a custom range.
- **Filters scope everything below them.** Every chart, stat, and table re-renders
  against the same slice, so the numbers always agree.
- **Refetch keeps the frame.** While data reloads, charts hold their previous render
  at reduced opacity — no skeleton, no layout jump, no flash.

A good date picker lists presets as rows (nobody fights a calendar grid for "last 30
days"), marks selection with a 16px bold check, keeps hover a ghost wash so it never
competes with selection, and tucks the custom range behind a hairline in the footer.
(See `palette.md` for the reference spec.)

---

## Appendix: references/components.md

# Components — the pieces a chart is made of

A chart is built from these parts, assembled in plain HTML/SVG. Tier 0 is the
foundation everything mounts on; the System tier is what makes the method
portable (and is, itself, this skill).

## Tier 0 — Foundations
- **Color roles** — categorical (8 × light/dark), sequential ramps, diverging pairs,
  status (4), de-emphasis / "Other", grayscale chart furniture (axis/grid/label/surface).
  Defined as CSS custom properties at the top of the HTML — see `palette.md`.
- **Texture fill** — the directional fill + 45°/135° rotations.
- **Chart container** — a `<figure>` (or card `<div>`) that owns responsive
  sizing, title/caption, and the **table-view toggle** (the accessibility twin
  of every chart). **Any fixed height includes the x-axis band** (plot height
  + axis labels) so the card never gets a nested vertical scroll; prefer
  letting the container grow with its content.
- **Legend** (toggle-to-isolate, texture-aware swatches) · **Tooltip** · **Axis** · **Data label**.

## Tier 1 — The charts people ask for
- **Bar chart** — grouped + stacked, thin-bar default, horizontal + vertical.
- **Line chart** — multi-series, soft-fill area variant, accessibility markers.
- **Stat tile** — value + delta + optional sparkline (the figure contract).
- **Meter / progress track** — same-ramp tracks.

## Tier 2 — Rounding out the kit
- **Area chart** (stacked, band-edge = line) · **Sparkline** · **Heatmap**
- **Scale legend** (sequential / diverging) · **Chart filters / time range** · **Empty state**

## System tier — becomes the skill
- **Six-checks validator** — `scripts/validate_palette.js` (palette validation).
- **Theming engine** — snap a customer's ramps to passing values (color-formula.md).
- **Chart-type heuristic** — pick the form (choosing-a-form.md).
- **Table-view generator** — the WCAG-clean equivalent of any chart.

Notes: part-to-whole rides on the stacked bar chart; donut stays deprioritized.
Small multiples is a layout pattern over these, not a separate piece. Scatter
joins Tier 2 if scatter-heavy surfaces land.

---

## Appendix: references/anti-patterns.md

# Anti-patterns — what goes wrong

Check every chart against this list. If your output matches an entry, it is wrong —
fix it before shipping. These are real failure modes, each caught in shipping
dashboards.

## Color & encoding

**❌ Dual-axis charts (two y-scales on one plot).**
Why it misleads: the alignment of the two scales is arbitrary, so the chart invents a
correlation that isn't in the data. Real example: an "Adoption" chart plotting Users
(0–30k) against Sessions (0–800k) — a reviewer flagged it as looking "hallucinated."
✅ Do instead: two charts, small multiples, or index both series to a common base
(=100 at t0) on **one** axis.

**❌ Recolor-on-filter.** Assigning colors by current rank, so filtering out a series
repaints the survivors.
Why: a reader who learned "Acme is blue" is now misled.
✅ Color follows the entity, not its row number. Survivors keep their hue.

**❌ Cycling / generating hues past 8.** A 9th categorical color, generated or reused.
Why: indistinguishable from an existing slot under CVD; breaks the order check.
✅ Fold the tail into "Other," facet into small multiples, or use composite encoding.

**❌ Eyeballing colorblind-safety.** "These look different enough."
✅ Run `scripts/validate_palette.js`. Adjacent ΔE ≥ 12, or 8–12 WITH secondary encoding.

**❌ A value-ramp on nominal categories.** Coloring each bar darker-where-bigger
when the categories have no natural order (products, teams, endpoints).
Why: it double-encodes bar length as hue, burns the only free channel on
information the chart already shows, and fails the categorical checks by design
(a ramp spans the lightness band and drops below the chroma floor).
✅ One series → one color (slot 1) for every bar. Ordered categories (funnel,
tiers, age bands) → the ordinal ramp, validated with `--ordinal`.

**❌ Rainbow / non-neighbor sequential.** A multi-hue ramp for magnitude.
✅ One hue, light→dark. (Analogous neighbors or semantic heat are the only multi-hue
sequential exceptions, always with a scale legend.)

**❌ A hue at the diverging midpoint, or two cool hues as the two poles.**
Why: the midpoint must read as "nothing"; poles must read as opposite. blue↔aqua
fails this (both cool); blue↔red or blue↔orange succeed (warm/cool).
✅ Two hues that read as opposite + a neutral gray midpoint.

**❌ Status color used for a non-status series** (or a series color used for status).
✅ Status tokens only when the color *means* good/bad; categorical when it's identity.

## Form

**❌ Eight categorical hues when the story is one number.** The most common way a
chart misses its point.
✅ Emphasis (highlight one, gray the rest), or a stat tile / hero number.

**❌ A one-bar bar chart, or a 2-slice pie.**
✅ A stat tile. The number is the chart.

**❌ A donut/pie for comparing close values.**
✅ A bar, or the numbers. Part-to-whole at a glance only, ≤ 6 segments.

**❌ More than ~7 color classes carrying meaning.**
✅ A table, or table + chart. Past ~7 bins, adjacent classes blur.

## Marks & chrome

**❌ Thick saturated blocks, heavy gridlines, no breathing room.** Reads loud, even
childish, at scale.
✅ Thin marks, hairline recessive grid/axes, generous padding. Saturated fills are
for small marks and accents, never large blocks.

**❌ Dashed gridlines or axis rules.** Dashing adds visual noise and reads as
"projection" or "threshold" when it's just a grid.
✅ Gridlines and axes are solid hairlines, one shade off the surface.

**❌ A number on every data point.** A value beside every dot or segment is chaos and goes unread.
✅ A legend is always present for ≥ 2 series; direct-label *selectively* (the endpoint, the extreme, the one series that matters) and let the axis + tooltip carry the rest.

**❌ A border drawn around marks to separate them.**
✅ A 2px surface gap between fills (stacked segments and adjacent bars alike) and a 2px surface ring (on overlapping markers).

**❌ A label clipped by, or overflowing, a too-small bar or stacked segment** —
including `overflow: hidden` cropping the first/last characters of an in-segment label.
✅ Only render a label inside a mark when it fits with padding; otherwise move it
outside the bar end, or drop it to the tooltip/legend (the value stays in the table view).

**❌ A chart container whose fixed height excludes the x-axis band** — the plot
fits, the axis labels don't, so the card gets a tiny nested vertical scroll.
✅ Size the container to include the axis labels (plot height + x-axis band),
or let the container grow with its content instead of fixing a height.

**❌ A display or serif face on the hero figure.** It reads as off-brand decoration.
✅ The hero figure uses the same sans as everything else.

**❌ `tabular-nums` on a large standalone number.** Equal-width digits make `121`
look loose at display sizes.
✅ Proportional figures on hero and stat-tile values; `tabular-nums` only where
numbers align vertically (table rows, axis ticks).

**❌ Texture on by default, or as decoration.** Dense angled fields are a vestibular
risk and read as noise on value scales.
✅ Texture is opt-in (a11y setting, print, forced-colors), 45°/135° only, ordered on
value scales.

## Interaction & accessibility

**❌ A tooltip as the only way to read a value.**
✅ Tooltips enhance, never gate — every value is also reachable via direct labels or
the table view; keyboard focus shows the same as hover.

**❌ Pinpoint hover targets — an 8px scatter dot you must land on dead-center.**
✅ The hit area includes the 2px gap and meets a ~24px minimum; dense scatter uses a nearest-point / Voronoi layer.

**❌ Per-chart filters, or filters inside a chart card.**
✅ One filter row above everything it scopes; all charts re-render against the same slice.

**❌ Skeleton flash on refetch.**
✅ Hold the previous render at reduced opacity — no layout jump.

**❌ No table view / color-only encoding on a continuous scale.**
✅ Every chart has a table-view twin (the WCAG-clean equivalent).

---

## Appendix: scripts/validate_palette.js

```js
/**
 * Validate a categorical chart palette against the computable data-viz checks.
 *
 * Design-system-agnostic: feed it ANY palette's hex values plus the mode and
 * surface, and it computes — never eyeballs — the four checks that can be
 * measured from color alone:
 *
 *   2. Lightness band   — OKLCH L within the mode's band
 *   3. Chroma floor     — OKLCH C >= floor (below it a hue reads as gray)
 *   4. CVD separation   — Machado-2009 ΔE between slots (protan/deutan/tritan);
 *                         adjacent pairs by default, pairs:"all" for scatter/bubble/maps
 *   5. Contrast vs surface — WCAG ratio of each mark against the chart surface
 *
 * Checks 1 (fixed hue order) and 6 (values are from the documented palette) are
 * structural rules the skill enforces, not measurable from hexes alone.
 *
 * Usage (node):
 *   node validate_palette.js "#2a78d6,#1baf7a,#eda100,#008300,#4a3aa7,#e34948,#e87ba4,#eb6834" --mode light
 *   node validate_palette.js "#256abf,#199e70,..." --mode dark --surface "#1a1a19"
 *   node validate_palette.js "#cde2fb,#9ec5f4,#6da7ec,#3987e5,#256abf" --ordinal
 *
 * Usage (browser — as a module script):
 *   <body data-palette="#2a78d6,#1baf7a,..." data-mode="light">
 *   <script type="module" src="validate_palette.js"></script>
 *   → logs a console.table of the report and console.warn on any FAIL.
 *
 * Exit code 0 unless a check hard-FAILs; 1 on any FAIL. WARN bands do not fail:
 * adjacent CVD in the 8–12 floor band, and contrast in the sub-3:1 relief band,
 * are reported as WARNs and still exit 0 (each is legal only with mandatory
 * secondary encoding: direct labels, gaps, or texture).
 */

// ── thresholds ────────────────────────────────────────────────────────────────
const BAND = { light: [0.43, 0.77], dark: [0.48, 0.67] }; // OKLCH L
const CHROMA_FLOOR = 0.10; // OKLCH C
const CVD_TARGET = 12.0, CVD_FLOOR = 8.0; // CIE76 ΔE on adjacent pairs
const CONTRAST_MIN = 3.0; // WCAG vs surface
const DEFAULT_SURFACE = { light: "#fcfcfb", dark: "#1a1a19" };
const ORDINAL_MIN_DL = 0.06; // min OKLCH ΔL between adjacent steps
const ORDINAL_LIGHT_FLOOR = 2.0; // lightest step: WCAG contrast vs surface

// Machado, Oliveira & Fernandes (2009) CVD transforms at severity 1.0 (linear RGB).
const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868],
           [0.114503, 0.786281, 0.099216],
           [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968],
           [0.280085, 0.672501, 0.047413],
           [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779],
           [-0.078411, 0.930809, 0.147602],
           [0.004733, 0.691367, 0.303900]],
};

// ── color conversions ──────────────────────────────────────────────────────────
const hex2srgb = (h) => { h = h.trim().replace(/^#/, ""); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); };
const s2lin = (c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const lin2s = (c) => { c = Math.max(0, Math.min(1, c)); return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; };
const lin = (h) => hex2srgb(h).map(s2lin);
const relLum = (h) => { const [r, g, b] = lin(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

function oklab(h) {
  const [r, g, b] = lin(h);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, // L
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, // a
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s, // b
  ];
}
const oklch = (h) => { const [L, a, b] = oklab(h); return [L, Math.hypot(a, b)]; };
const okhue = (h) => { const [, a, b] = oklab(h); return ((Math.atan2(b, a) * 180 / Math.PI) % 360 + 360) % 360; };

// CIELAB (D65) for ΔE
function lin2lab(r, g, b) {
  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  const Z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
  const f = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const [fx, fy, fz] = [f(X / 0.95047), f(Y / 1.0), f(Z / 1.08883)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function simulate(h, kind) {
  const [r, g, b] = lin(h), M = MACHADO[kind];
  const clamp = (c) => Math.max(0, Math.min(1, c));
  return [
    clamp(M[0][0] * r + M[0][1] * g + M[0][2] * b),
    clamp(M[1][0] * r + M[1][1] * g + M[1][2] * b),
    clamp(M[2][0] * r + M[2][1] * g + M[2][2] * b),
  ];
}
function deltaE(h1, h2, kind) {
  const a = lin2lab(...(kind ? simulate(h1, kind) : lin(h1)));
  const b = lin2lab(...(kind ? simulate(h2, kind) : lin(h2)));
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// ── checks ─────────────────────────────────────────────────────────────────────
export function validate(palette, { mode = "light", surface, pairs = "adjacent" } = {}) {
  surface ??= DEFAULT_SURFACE[mode];
  const [lo, hi] = BAND[mode];
  const report = [];
  let ok = true;

  // 2. lightness band
  const offband = palette.filter(c => { const L = oklch(c)[0]; return L < lo || L > hi; })
    .map(c => [c, +oklch(c)[0].toFixed(3)]);
  if (offband.length) ok = false;
  report.push(["Lightness band", !offband.length,
    offband.length ? `outside band: ${JSON.stringify(offband)}` : `all ${palette.length} inside L ${lo}–${hi}`]);

  // 3. chroma floor
  const lowc = palette.filter(c => oklch(c)[1] < CHROMA_FLOOR).map(c => [c, +oklch(c)[1].toFixed(3)]);
  if (lowc.length) ok = false;
  report.push(["Chroma floor", !lowc.length,
    lowc.length ? `below floor (reads gray): ${JSON.stringify(lowc)}` : `all ${palette.length} >= ${CHROMA_FLOOR}`]);

  // 4. CVD separation — adjacent for stacks/bars/lines; ALL pairs for scatter/bubble/maps/small-multiples
  const n = palette.length;
  const pairlist = pairs === "all"
    ? Array.from({ length: n }, (_, i) => Array.from({ length: n - i - 1 }, (_, k) => [i, i + 1 + k])).flat()
    : Array.from({ length: n - 1 }, (_, i) => [i, i + 1]);
  const label = pairs === "all" ? "all-pairs" : "adjacent";
  let worst = null;
  for (const kind of ["protan", "deutan"]) {
    for (const [i, j] of pairlist) {
      const d = deltaE(palette[i], palette[j], kind);
      if (worst === null || d < worst[0]) worst = [d, kind, palette[i], palette[j]];
    }
  }
  const tri = pairlist.length ? Math.min(...pairlist.map(([i, j]) => deltaE(palette[i], palette[j], "tritan"))) : 99;
  const nor = pairlist.length ? Math.min(...pairlist.map(([i, j]) => deltaE(palette[i], palette[j]))) : 99;
  const wd = worst ? worst[0] : 99;
  const cvdState = wd >= CVD_TARGET ? "pass" : wd >= CVD_FLOOR ? "floor" : "fail";
  if (cvdState === "fail") ok = false;
  report.push(["CVD separation", cvdState,
    worst ? `worst ${label} ${worst[3]}↔${worst[2]} ΔE ${wd.toFixed(1)} (${worst[1]}) · tritan ${tri.toFixed(1)} · normal ${nor.toFixed(1)}` : "n/a"]);

  // 5. contrast vs surface — sub-3:1 is a documented conditional relax (visible labels / table view), not a hard fail
  const low = palette.filter(c => contrast(c, surface) < CONTRAST_MIN).map(c => [c, +contrast(c, surface).toFixed(2)]);
  report.push(["Contrast vs surface", low.length ? "relief" : "pass",
    low.length ? `below ${CONTRAST_MIN}:1 — relief required (visible labels or table view): ${JSON.stringify(low)}`
               : `all ${palette.length} >= ${CONTRAST_MIN}:1`]);

  return { report, ok };
}

export function validateOrdinal(palette, { mode = "light", surface } = {}) {
  /* Ordered categories (funnel stages, size tiers, time buckets rendered as
     discrete marks) take a one-hue ramp, not categorical hues. The categorical
     checks FAIL a correct ramp by design (it spans the lightness band; light
     steps drop below the chroma floor). The ordinal checks instead verify the
     ramp reads *as a ramp*: one hue, monotone lightness with visible gaps
     between steps, and a lightest step that still clears the surface. */
  surface ??= DEFAULT_SURFACE[mode];
  const report = [];
  let ok = true;
  const Ls = palette.map(c => oklch(c)[0]);

  // Monotone lightness — sorted by L must match input order (or its reverse).
  const order = [...Ls.keys()].sort((a, b) => Ls[a] - Ls[b]);
  const fwd = order.every((v, i) => v === i);
  const rev = order.every((v, i) => v === Ls.length - 1 - i);
  const mono = fwd || rev;
  if (!mono) ok = false;
  report.push(["Lightness monotone", mono,
    mono ? "steps read light→dark" : `out of order — L values ${JSON.stringify(Ls.map(l => +l.toFixed(3)))}`]);

  // Adjacent ΔL — each step must be visibly distinct from its neighbour.
  const gaps = Ls.slice(1).map((l, i) => Math.abs(l - Ls[i]));
  const thin = gaps.map((g, i) => [palette[i], palette[i + 1], +g.toFixed(3)]).filter(([, , g]) => g < ORDINAL_MIN_DL);
  if (thin.length) ok = false;
  report.push(["Adjacent ΔL", !thin.length,
    thin.length ? `steps too close: ${JSON.stringify(thin)}` : `all gaps >= ${ORDINAL_MIN_DL}`]);

  // Lightest step vs surface — the pale end must still read as a mark.
  const byL = [...palette].sort((a, b) => oklch(a)[0] - oklch(b)[0]);
  const lightest = mode === "light" ? byL[byL.length - 1] : byL[0];
  const cr = contrast(lightest, surface);
  if (cr < ORDINAL_LIGHT_FLOOR) ok = false;
  report.push(["Light-end contrast", cr >= ORDINAL_LIGHT_FLOOR,
    `${lightest} at ${cr.toFixed(2)}:1 vs surface` + (cr >= ORDINAL_LIGHT_FLOOR ? "" : ` — below ${ORDINAL_LIGHT_FLOOR}:1 floor`)]);

  // Single hue — an ordinal ramp is one hue; a hue jump means it's categorical.
  const hues = palette.map(okhue);
  let spread = hues.length ? Math.max(...hues) - Math.min(...hues) : 0;
  if (spread > 180) spread = 360 - spread;
  const oneHue = spread <= 40;
  if (!oneHue) ok = false;
  report.push(["Single hue", oneHue,
    `hue spread ${spread.toFixed(0)}°` + (oneHue ? "" : " — >40°, not a one-hue ramp")]);

  return { report, ok };
}

// ── entrypoints ────────────────────────────────────────────────────────────────
const GLYPH = { true: "PASS", false: "FAIL", pass: "PASS", floor: "WARN", fail: "FAIL", relief: "WARN" };

function printReport({ report, ok }, { mode, surface, ordinal, n }) {
  const kind = ordinal ? "ordinal ramp" : "categorical";
  console.log(`\nPalette (${mode}, surface ${surface}, ${kind}): ${n} slots`);
  for (const [name, state, detail] of report) {
    console.log(`  [${(GLYPH[state] ?? state).padEnd(4)}] ${name.padEnd(22)} ${detail}`);
  }
  if (ordinal) {
    console.log(`\n  → ${ok ? "ALL CHECKS PASS" : "FAILED — fix the marked checks"}`
      + "  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)");
  } else {
    console.log(`\n  → ${ok ? "ALL CHECKS PASS" : "FAILED — fix the marked checks"}`
      + "  (CVD in the 8–12 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)");
    console.log("  scope: categorical palettes only. For a lone status/text color check WCAG"
      + " text contrast; for a sequential ramp, lightness monotonicity.\n");
  }
}

// Node CLI
if (typeof process !== "undefined" && process.argv && process.argv[1] && process.argv[1].endsWith("validate_palette.js")) {
  const args = process.argv.slice(2);
  const VALUE_FLAGS = new Set(["--mode", "--surface", "--pairs"]);
  const CHOICES = { mode: ["light", "dark"], pairs: ["adjacent", "all"] };
  const opts = {}; let positional = null;
  for (let i = 0; i < args.length; i++) {
    let a = args[i], val;
    const eq = a.indexOf("="); if (eq > 0) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    if (VALUE_FLAGS.has(a)) { opts[a.slice(2)] = val ?? args[++i]; }
    else if (a === "--ordinal") { opts.ordinal = true; }
    else if (a.startsWith("--")) { console.error(`unknown flag: ${a}`); process.exit(2); }
    else if (positional === null) { positional = a; }
    else { console.error(`unexpected extra positional: ${a}`); process.exit(2); }
  }
  for (const [k, allowed] of Object.entries(CHOICES)) {
    if (opts[k] != null && !allowed.includes(opts[k])) {
      console.error(`--${k} must be one of: ${allowed.join(", ")} (got ${JSON.stringify(opts[k])})`); process.exit(2);
    }
  }
  const palette = (positional || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!palette.length) { console.error("usage: node validate_palette.js \"#hex,#hex,...\" [--mode light|dark] [--surface #hex] [--pairs adjacent|all] [--ordinal]"); process.exit(2); }
  const mode = opts.mode || "light";
  const surface = opts.surface || DEFAULT_SURFACE[mode];
  const pairs = opts.pairs || "adjacent";
  const result = opts.ordinal ? validateOrdinal(palette, { mode, surface }) : validate(palette, { mode, surface, pairs });
  printReport(result, { mode, surface, ordinal: !!opts.ordinal, n: palette.length });
  process.exit(result.ok ? 0 : 1);
}

// Browser auto-run (as a <script type="module">). Fires whenever the page has a
// data-palette attribute on <body>; omit it to import the module without auto-running.
if (typeof document !== "undefined") {
  const b = document.body;
  if (b?.dataset.palette) {
    const palette = b.dataset.palette.split(",").map(s => s.trim()).filter(Boolean);
    const mode = b.dataset.mode || "light";
    const surface = b.dataset.surface || DEFAULT_SURFACE[mode];
    const ordinal = "ordinal" in b.dataset;
    const result = ordinal ? validateOrdinal(palette, { mode, surface }) : validate(palette, { mode, surface, pairs: b.dataset.pairs || "adjacent" });
    console.table(result.report.map(([name, state, detail]) => ({ check: name, result: GLYPH[state] ?? state, detail })));
    if (!result.ok) console.warn("validate_palette: FAILED — fix the marked checks");
  }
}
```