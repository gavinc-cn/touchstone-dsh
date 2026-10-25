# Load test plan document template (plan.md)

> Written in the plan package directory `<case library root>/load/task_<task id>/plan.md`. This is what people read before the run:
> after reading it one should be able to answer "what is under load, how hard, what to watch, and how pass is decided".

## Format requirements (hard requirement: must be Markdown)

The platform "Load Test Plan" page renders plan.md directly with a markdown renderer; only the syntax below produces layout:

| Syntax | Rendered as |
|--------|-------------|
| `# Title` / `## 1. Section` / `### Subsection` | Document title + chapters (the number in `## 1.` is split into a gold label and a left-hand table of contents is generated automatically) |
| A `- key: value` list right below the title (≥2 items) | Header bar (target service / execution driver / generated at ... shown line by line as pairs) |
| Pipe table (header row + `---` separator row, columns separated by vertical bars) | Table (**must** use pipe tables; space-aligned pseudo tables render only as a wall of text) |
| `- item` / `1. item` | Unordered / ordered list |
| Backtick-wrapped `code` | Inline code (paths, metric names and field names all use it) |
| `> quote` | Callout (use it for the "why designed this way" rationale) |
| Triple-backtick fence | Code block (reproduction commands, request body examples) |

**Do not**: write the whole document as plain text, align pseudo tables with spaces/tabs, draw table borders with `====` or `----`,
or stuff multiple fields into one long sentence. Longer columns in a table (notes / rationale) can be written normally; the renderer lays them out itself.

```markdown
# Load test plan: <system under test / scenario name>

- Target service: http://127.0.0.1:8080 (source: task load test brief / code config)
- Execution driver: scenario.json (built-in HTTP engine) or run.py (custom script)
- Generated at: YYYY-MM-DD HH:MM

## 1. Objective and scope

<why to run load, what is under load, what is not. For example: verify the throughput and latency ceiling of the
ordering chain under high concurrency; payment callbacks are out of scope (sandbox unavailable).>

## 2. Interfaces under test

| Interface | Method | Path | Description | Weight / share |
|-----------|--------|------|-------------|----------------|
| Place order | POST | /api/order | main write path | 3 |
| Query order | GET | /api/order/{id} | read-heavy, write-light | 7 |

<Notes on request body / auth / fixture data preparation; when the brief does not provide something, state "inferred from code in file X".>

## 3. Load model

| Stage | Concurrency | Duration | Description |
|-------|-------------|----------|-------------|
| 1 | 10 | 60s | warm-up |
| 2 | 50 | 120s | steady state |
| 3 | 100 | 60s | push higher |

<Explain when the platform capacity boundary is exceeded (concurrency ≤512).>

## 4. Metric definitions (consistent with charts.json)

| Metric | Type | Meaning | Source |
|--------|------|---------|--------|
| rps | gauge | requests per second | engine / script statistics |
| lat.p95 | gauge | 95th percentile latency (ms) | latency bucket interpolation |
| lat.p50/lat.p90/lat.p99 | gauge | other percentiles | same as above |
| err.rate | gauge | error rate (0~1) | errors / requests |
| req.total / req.errors | counter | cumulative requests / errors | cumulative counters |
| order.status | counter | orders per status (labels.status) | business-side statistics |

<Custom metrics must state clearly "how they are computed", otherwise the numbers on the charts cannot be explained.>

## 5. Chart design

<The charts this plan wants to see on the panels (matching charts.json), one sentence per chart.>

## 6. Pass criteria and risks

- Pass criteria: <e.g. P95 < 200ms and error rate < 1%>
- Known risks: <e.g. the target service has no isolated load test environment, or depends on an external third-party interface>
- Rollback / stop conditions: <e.g. stop manually when the error rate stays above 5% for 30s>
```
