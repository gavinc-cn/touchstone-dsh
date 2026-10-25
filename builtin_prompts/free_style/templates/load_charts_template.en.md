# Chart declaration template (charts.json)

> Written in the plan package directory `<case library root>/load/task_<task id>/charts.json`.
> When this file is absent the platform draws the default panels (throughput RPS / latency percentiles / error rate + KPI cards + per-interface table).
> When this file is invalid (bad JSON or illegal fields) the platform falls back to the whole default panel set and logs the reason in the load generation log.

## Complete example

```json
{
  "version": 1,
  "title": "Ordering chain load test",
  "panels": [
    {
      "id": "rps",
      "type": "line",
      "title": "Throughput RPS",
      "width": "full",
      "series": [
        {"metric": "rps", "label": "Total RPS"},
        {"metric": "rps", "match": {"group": "place-order API"}, "label": "place order"}
      ]
    },
    {
      "id": "lat",
      "type": "line",
      "title": "Latency percentiles (ms)",
      "width": "half",
      "series": [
        {"metric": "lat.p50", "label": "P50"},
        {"metric": "lat.p95", "label": "P95"},
        {"metric": "lat.p99", "label": "P99"}
      ]
    },
    {
      "id": "err",
      "type": "line",
      "title": "Error rate (%)",
      "width": "half",
      "series": [{"metric": "err.rate", "label": "Error rate", "scale": 100}]
    },
    {
      "id": "order_status",
      "type": "stacked_bar",
      "title": "Order status distribution",
      "width": "half",
      "metric": "order.status",
      "groupBy": "status"
    },
    {
      "id": "order_type",
      "type": "donut",
      "title": "Order type share",
      "width": "half",
      "metric": "order.count",
      "groupBy": "type"
    },
    {
      "id": "kpi",
      "type": "stat",
      "title": "Key metrics",
      "width": "full",
      "stats": [
        {"metric": "req.total", "label": "Total requests", "agg": "last"},
        {"metric": "lat.p95", "label": "P95 (ms)", "agg": "last"},
        {"metric": "err.rate", "label": "Error rate (%)", "agg": "last", "scale": 100},
        {"metric": "conc", "label": "Concurrency", "agg": "max"}
      ]
    },
    {
      "id": "groups",
      "type": "table",
      "title": "Per interface",
      "width": "full",
      "source": "series",
      "metric": "rps",
      "groupBy": "group"
    }
  ]
}
```

## Panel type reference

| type | Draws | Required fields | Optional fields |
|------|-------|-----------------|-----------------|
| `line` | multi-series line (time axis) | `series[]` (each item has `metric`) | `label`, `match` (filter target series by labels), `scale` (value multiplier, e.g. 0→1 error rate × 100) |
| `bar` | bar (by time or by label dimension) | `metric` | `by` = `time` (default) / `label`, `groupBy` |
| `stacked_bar` | stacked bars (label dimension stacked over time) | `metric`, `groupBy` | — |
| `donut` | donut (last-value share by label dimension) | `metric`, `groupBy` | — |
| `stat` | single-value cards (one row of number cards) | `stats[]` (each item has `metric`) or a single `metric` | per item `label`, `agg` = `last` (default) / `avg` / `max` / `min` / `sum`, `unit`, `scale` |
| `table` | table | `source` = `series` / `summary` | `metric` (required when source=series), `groupBy` |

Common fields: `id` (unique, required), `title`, `width` = `half` (default) / `full`, `hint` (one-line note under the panel).
Limits: at most 24 panels, at most 12 line series, at most 8 stat cards.

## Usage suggestions

- For `counter` metrics (orders placed, orders completed) the platform draws the rate/bar height from the **window increment**; do not compute the difference yourself and report it;
- For "how many are in each status" use `counter` + `labels` (field names consistent with `groupBy`), e.g.
  `w.counter("order.status", 120, status="filled")` with `{"metric":"order.status","groupBy":"status"}`;
- If the script computes latency percentiles itself, report them as `gauge` (`lat.p50` / `lat.p95` / `lat.p99`);
- The global value and the grouped values of the same metric are distinguished by `labels`: the global one carries no labels, grouped ones carry `group` and other dimensions;
- Every metric referenced by the charts must really be reported by the scenario/script, otherwise the panel stays empty.
