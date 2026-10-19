# Prism: Code Walkthrough

Prism is a single-file React app (`Prism.jsx`) for project-based learning of functional programming. Students load a dataset, build a pipeline of pure transform steps, chart the result and assemble a dashboard. Two "under the hood" views show the generated code and the query plan.

Line numbers below refer to the current `Prism.jsx` (about 2688 lines).

---

## 1. Running it

Prism is one default-exported component, `Prism`. It needs:

| Package | Used for |
|---|---|
| `react` (18) | UI, hooks, context |
| `recharts` | Charts |
| `papaparse` | CSV parsing |
| `@duckdb/duckdb-wasm` (optional) | Real SQL execution and EXPLAIN plans. Loaded lazily with `import()` only when the DuckDB engine is selected. |

Any React host works (Vite, a Claude artifact, CodeSandbox). Fonts (IBM Plex Sans and Mono) load from Google Fonts through a `<style>` tag inside the component.

---

## 2. The big picture

The file is layered from pure logic at the top to UI at the bottom. Nothing in the top half touches React.

| Lines | Layer | Pure? |
|---|---|---|
| 9-63 | Utility functions: `pipe`, `identity`, type inference, stats | yes |
| 65-173 | Engine catalogue: `ENGINES`, `ENGINE_OPS` | data only |
| 175-372 | Sample datasets | data only |
| 374-673 | Step execution: `applyStep`, `buildPipeline` | yes |
| 675-766 | Logical plan, optimizer, physical plan | yes |
| 768-1049 | Code generation (JS/TS) and DuckDB SQL generation | yes |
| 1051-1081 | Pipeline reducer (state transitions) | yes |
| 1083-1252 | Themes, styles, step catalogue, summaries, snippets | yes |
| 1254-1770 | Presentational components | React |
| 1772-2688 | `Prism` app: state, effects, the six views, footer | React |

How data moves through the app:

```
 sample / CSV / JSON
        |
        v
 dataSources { name: rows[] }      (immutable values, one per source)
        |
        v   steps[]  (array of plain step descriptors)
 runs = steps.reduce(applyStep)    (keeps every intermediate result)
        |
        +--> Pipeline view (before/after per step)
        +--> Chart view    render(chartConfig)(output rows)
        +--> Dashboard     charts.map(chart => render(chart.config)(run(chart.steps)))
        +--> Code view     generateCode(steps) / generateDuckDBCode(steps)
        +--> Plan view     buildLogicalPlan -> optimizePipeline -> buildPhysicalPlan
```

The core idea for students: **the pipeline is data**. `steps` is an array of plain objects. Every view is a pure function of that array plus the source rows.

---

## 3. Utility functions (lines 9-63)

- `pipe(...fns)` composes functions left to right with `reduce`. This is the heart of the course:

  $\text{pipe}(f_1, f_2, \ldots, f_n)(x) = f_n(\cdots f_2(f_1(x)))$

- `identity` is the empty pipeline: `pipe()` returns its input unchanged.
- `inferType(values)` decides `number`, `date` or `string` by testing every non-empty value. It is used by the schema panel on the Data view.
- `computeStats(values, type)` returns min/max/mean for numbers, earliest/latest for dates and unique count for strings.
- `deepClone` copies sample data so the original constants are never shared or mutated.

---

## 4. Engines (lines 65-173)

`ENGINES` lists four engines; `ENGINE_OPS` maps each step type to how each engine would perform it.

| Engine | Really executes? |
|---|---|
| JavaScript (Array) | Yes. All pipelines run through `applyStep`. |
| Apache Arrow (columnar, conceptual) | No. Arrow is a columnar memory format, not a query engine, so it has no planner. The view shows Arrow-style operator names. |
| WebGPU (Compute Shaders) | No. Shows the GPU kernel each step would map to. |
| DuckDB (WASM) | Yes, in addition to JS. The pipeline is compiled to SQL and run in DuckDB-WASM, and its real `EXPLAIN` plans are shown. |

Teaching point: the logical pipeline stays the same while the physical execution changes. That is only safe because each step is a pure function of its input.

---

## 5. Step execution (lines 374-673)

### 5.1 Building blocks

- `OPERATORS` (line 378): filter predicates such as `equals`, `greater_than`, `contains`, `between`. Each is a function `(a, b) => boolean`.
- `aggregators` (line 391): `sum`, `count`, `mean`, `median`, `min`, `max`, `first`, `last`. Each is a function `values[] => value`.

Because these are lookup tables of functions, adding an operator is one line: the code is driven by data.

### 5.2 `applyStep(step, data, context)` (line 402)

One `switch` with a case for each of the 16 step types. Every case returns a **new** array and never mutates `data`:

| Step | Functional pattern |
|---|---|
| filter | `data.filter(predicate)` (higher-order function) |
| sort, top_n, sample | copy first (`[...data]`), then sort or shuffle the copy |
| compute, rename, drop, cast_type, fill_null | `data.map(row => newRow)` with spread |
| group_aggregate, pivot | fold rows into groups, then map groups to result rows |
| unpivot | one row becomes many (flatMap-style) |
| window | scan: running state across ordered rows |
| join | build a hash index on the right source, probe it with each left row |
| union | concatenation `[...data, ...other]` |
| distinct | keep the first row per key, tracked with a `Set` |

Notes:

- `context.dataSources` gives join and union access to other named sources without global state.
- An unfinished filter (no column or empty value) passes rows through unchanged, so a newly added step never blanks the table.
- `compute` evaluates the expression by replacing column names with the row's values and calling `new Function`. This suits a teaching tool; do not use it with untrusted input.

### 5.3 Composition (lines 661-673)

```js
const buildPipeline = (steps, context) =>
  steps.filter(enabled).reduce(
    (fn, step) => (data) => applyStep(step, fn(data), context),
    identity
  );
```

`buildPipeline` turns the step array into **one function** by folding the steps with `reduce`, starting from `identity`. With $n$ enabled steps $s_1, \ldots, s_n$:

$\text{run} = s_n \circ \cdots \circ s_2 \circ s_1$

Turning a step off just removes it from the fold. The Dashboard uses `buildPipeline` to re-run each saved chart's own pipeline.

---

## 6. Query plans and optimizer (lines 675-766)

- `buildLogicalPlan(steps, source, rowCount)`: a `Scan` node followed by one node per enabled step, each with a short detail string.
- `optimizePipeline(steps)`: rule-based rewrites on a copy of the steps:
  1. **Predicate pushdown**: move filters before sort, compute and rename when the filter does not depend on that step's output.
  2. **Filter fusion**: consecutive filters can be merged into one AND.
  3. **Sort elimination**: a sort just before an aggregate is wasted work.
  4. **Projection pushdown**: dropped columns could be removed at scan time.
- `buildPhysicalPlan(nodes, engine)`: attaches the engine-specific operator from `ENGINE_OPS` to each logical node.

Teaching point (shown as "referential transparency" on the Plan view): pure steps can be reordered or merged without changing the result. That is what gives an optimizer room to work.

---

## 7. Code and SQL generation (lines 768-1049)

- `generateCode(steps, chartConfig, engine)`: emits a TypeScript-flavoured program with one named function per step, composed with `pipe(...)` at the end. For non-JS engines each step also gets a comment with that engine's operator.
- `stepToSQL(step, fromTable)`: translates one step into a `SELECT` over the previous result.
- `pipelineToSQL(steps, table)`: chains the steps as CTEs: `WITH step_0 AS (...), step_1 AS (...) SELECT * FROM step_n`. This mirrors `pipe` in SQL: each CTE reads only the one before it.
- `generateDuckDBCode`: wraps the SQL with table creation and `EXPLAIN` statements for display.
- `escSQL` and `qid` escape string literals and identifiers.

---

## 8. State transitions: `pipelineReducer` (lines 1051-1081)

All pipeline edits go through one reducer with the signature `(state, action) => newState`. It never mutates `state`:

| Action | Effect |
|---|---|
| `ADD_STEP` | insert a step at `action.index` (or at the end) |
| `REMOVE_STEP` | filter it out |
| `UPDATE_STEP` | map, merging the changed fields into one step |
| `TOGGLE_STEP` | flip `enabled` |
| `REORDER` | move one step from one index to another |
| `LOAD` / `CLEAR` | replace or empty the list |

`nextId` is a small closure that hands out unique step ids.

---

## 9. Themes and styling (lines 1083-1145)

- `THEMES` holds two palettes as plain token objects: **Sorbet** (light pastel) and **Meadow** (dark pastel). Tokens:
  - `bg`, `surf`, `soft`, `ink`, `mute`, `line`: surfaces and text
  - `acc`, `onAcc`, `accSoft`, `accInk`: accent and the text that sits on it
  - `rowsBg/Ink`, `colsBg/Ink`, `sumBg/Ink`, `cmbBg/Ink`, `clnBg/Ink`: one pastel pair per step category
  - `series`: 8 chart colours
- `makeStyles(t)` is a pure function from a theme to a style object (`card`, `btn(variant)`, `pill(on)`, `segBtn(on)`, `th`, `td` and so on).
- `ThemeCtx` (React context) passes `{ t, S }` down; components read it with `useTheme()`. Switching palette changes one state value, and every component re-renders with the new tokens.

---

## 10. Step catalogue and helpers (lines 1147-1252)

- `STEP_META`: for each step type, `[label, category, description, functional idea]`. It drives the step picker, the colours and the "fold: reduce" style tags.
- `STEP_GROUPS`: the five picker groups (Shape rows, Shape columns, Summarize, Combine, Clean).
- `defaultStep(type, rows, sources, active)`: sensible starting settings for a new step, so it has a visible effect immediately. It prefers measure columns over year-like or id-like ones.
- `stepSummary(step)`: a short human label, for example `year equals 2020`.
- `stepSnippet(step)`: a one-line functional JS equivalent, for example `rows.filter(r => r.year === 2020)`.

---

## 11. Components (lines 1254-1770)

| Component | Role |
|---|---|
| `PlanSVG` | Draws the logical and physical plan side by side as SVG, with optimizer notes; can export the SVG. |
| `ChartRenderer` | `config + data -> chart`. Supports bar (vertical, horizontal, stacked, grouped), line, area, scatter, pie and donut. Uses theme colours. |
| `PageTitle`, `EmptyCard`, `Badge`, `RowBar` | Layout and visual helpers. |
| `FlowLink` | The connector between Flow nodes: row count, line and the **+** insert button. |
| `InsertRow` | The Notebook equivalent of `FlowLink`. |
| `Field`, `Choice`, `MultiChoice` | Form controls. `Choice` shows buttons for up to 10 options and a dropdown beyond that. |
| `DataTable` | Scrollable table with optional column highlights (new columns, the column being acted on). |
| `ColumnStats` | Schema list: name, inferred type, range or unique count. |
| `StepLibrary` | The grouped step picker shown when **+** is pressed. |
| `StepEditor` | The settings form for each of the 16 step types. Calls `onUpdate({ field: value })`. |

---

## 12. The `Prism` app (lines 1772-2688)

### 12.1 State

- Data: `dataSources`, `activeSource`, `dataSource` (chosen sample), CSV/JSON text, `newSourceName`
- Pipeline: `steps` (from the reducer), `selectedId`, `insertAt`, `pipeView` (`"flow"` by default, or `"notebook"`), `dragIdx`
- Charts: `chartConfig`, `dashboardCharts`
- Engine and theme: `engine`, `palette`
- DuckDB: a ref to the database plus status, error, result, plans and timing

### 12.2 Derived values (computed, never stored)

- `runs` (line 1856): the pipeline is folded **once**, keeping `{ step, inRows, outRows }` for every step. This is what powers the before/after tables and the row counts on every node.
- `transformedData`: the last `outRows`, or the raw data when there are no steps.
- `nodes` (line 1873): `runs` enriched for display: category, row/column delta, highlight colours and selection flag.

### 12.3 Pipeline editing handlers (lines 1890-1915)

- `addStep(type)`: builds a default step from the rows flowing into the insert position, dispatches `ADD_STEP` with that index and selects the new step.
- `removeStep(id)`: dispatches `REMOVE_STEP` and selects the neighbouring step.
- `moveStep(id, +1 | -1)`: dispatches `REORDER`.
- `updateStep(id)(changes)` and `toggleStep(id)`: dispatch `UPDATE_STEP` and `TOGGLE_STEP`.

### 12.4 Effects (lines 1999-2100)

Side effects are kept in two `useEffect` blocks, away from the pure core:

1. When the engine becomes DuckDB, load DuckDB-WASM once.
2. When DuckDB is ready (and on every pipeline change), load all sources as tables, run `pipelineToSQL`, time it and fetch the `EXPLAIN` plans.

### 12.5 Views

| Lines | Tab | What it shows |
|---|---|---|
| 2138-2216 | Pipeline: Flow | `renderFlow` (node graph with **+** links) and `renderInspector` (settings plus before/after tables) |
| 2220-2281 | Pipeline: Notebook | `renderNotebook`: vertical cards with inline editor, 3-row preview and drag to reorder |
| 2338 | Data | Sample cards, paste/upload, sources, preview table, schema |
| 2427 | Pipeline | Title, Flow/Notebook switch, the whole pipeline as one `pipe(...)` expression |
| 2457 | Chart | Settings, live chart, the chart spec as data, a note on currying |
| 2507 | Dashboard | `charts.map(render)`; each tile re-runs its own saved pipeline |
| 2540 | Code | Engine switch, generated code, patterns used, the pipeline as JSON |
| 2582 | Plan | DuckDB plans, generated SQL, `PlanSVG`, optimizer rules, operator mapping |
| 2682 | Footer | "By SHAURYASHAURYA (c) 2026", 10pt, muted |

The header holds navigation, the engine selector, the palette switch and Save/Load. Save writes `{ dataSources, steps, charts, chartConfig, engine }` as JSON; Load restores it.

---

## 13. Where each functional idea lives

| Concept | Where to point students |
|---|---|
| Pure functions | `applyStep`, `inferType`, `stepToSQL`, `makeStyles` |
| Immutability | spread copies in `applyStep`; `pipelineReducer` never mutates |
| Higher-order functions | `OPERATORS`, `aggregators`, `data.filter(op)` |
| Composition | `pipe`, `buildPipeline`, SQL CTE chaining in `pipelineToSQL` |
| Fold / reduce | `buildPipeline`, the `runs` memo, `group_aggregate` |
| Currying / partial application | `updateStep(id)(changes)`; the chart spec story on the Chart view |
| Data as code | `steps` array; `pipelineJSON` on the Code view |
| Referential transparency | `optimizePipeline` reorders steps safely |
| Isolated side effects | the two DuckDB `useEffect` blocks, file reading, downloads |

---

## 14. Adding a new step type (checklist)

1. `applyStep`: add a `case` that returns a new array.
2. `ENGINE_OPS`: add the four engine mappings.
3. `buildLogicalPlan`: add a label and detail.
4. `generateCode` and `stepToSQL`: add JS and SQL output.
5. `STEP_META`: add `[label, category, description, idea]`.
6. `defaultStep`, `stepSummary`, `stepSnippet`: add a line each.
7. `StepEditor`: add the settings form.

The picker, Flow, Notebook, colours and code views pick it up automatically from `STEP_META`.

---

## 15. Known limitations

- Arrow and WebGPU are conceptual: execution always happens in JS. DuckDB is the only engine with real plans.
- `sample` is random, so its output changes whenever the pipeline re-runs.
- `compute` uses `new Function` on the expression text.
- The palette choice is not included in Save/Load.
- Step ids restart at 1 after a page reload; loading a saved file with high ids can collide with new ones.
