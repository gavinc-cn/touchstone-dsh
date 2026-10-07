# 图表声明模板（charts.json）

> 写在方案包目录 `<案例库根>/load/task_<任务id>/charts.json`。
> 不写本文件时平台画默认面板（吞吐 RPS / 延迟分位 / 错误率 + KPI 卡 + 分接口表）。
> 本文件写错（JSON 非法或字段不合法）时平台整份回退默认面板，并在发压日志记一行原因。

## 完整示例

```json
{
  "version": 1,
  "title": "下单链路压测",
  "panels": [
    {
      "id": "rps",
      "type": "line",
      "title": "吞吐 RPS",
      "width": "full",
      "series": [
        {"metric": "rps", "label": "总 RPS"},
        {"metric": "rps", "match": {"group": "下单接口"}, "label": "下单"}
      ]
    },
    {
      "id": "lat",
      "type": "line",
      "title": "延迟分位 (ms)",
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
      "title": "错误率 (%)",
      "width": "half",
      "series": [{"metric": "err.rate", "label": "错误率", "scale": 100}]
    },
    {
      "id": "order_status",
      "type": "stacked_bar",
      "title": "委托状态分布",
      "width": "half",
      "metric": "order.status",
      "groupBy": "status"
    },
    {
      "id": "order_type",
      "type": "donut",
      "title": "委托类型占比",
      "width": "half",
      "metric": "order.count",
      "groupBy": "type"
    },
    {
      "id": "kpi",
      "type": "stat",
      "title": "关键指标",
      "width": "full",
      "stats": [
        {"metric": "req.total", "label": "总请求", "agg": "last"},
        {"metric": "lat.p95", "label": "P95 (ms)", "agg": "last"},
        {"metric": "err.rate", "label": "错误率 (%)", "agg": "last", "scale": 100},
        {"metric": "conc", "label": "并发", "agg": "max"}
      ]
    },
    {
      "id": "groups",
      "type": "table",
      "title": "分接口",
      "width": "full",
      "source": "series",
      "metric": "rps",
      "groupBy": "group"
    }
  ]
}
```

## 面板类型速查

| type | 画什么 | 必填字段 | 可选字段 |
|------|--------|----------|----------|
| `line` | 多序列折线（时间轴） | `series[]`（每项 `metric`） | `label`、`match`（按 labels 筛选目标序列）、`scale`（数值放大，如 0→1 错误率乘 100） |
| `bar` | 柱状（按时间或按 label 维度） | `metric` | `by` = `time`(默认) / `label`、`groupBy` |
| `stacked_bar` | 堆叠柱（label 维度随时间堆叠） | `metric`、`groupBy` | — |
| `donut` | 环图（label 维度末值占比） | `metric`、`groupBy` | — |
| `stat` | 单值卡（一行数字卡片） | `stats[]`（每项 `metric`）或单个 `metric` | 每项 `label`、`agg`=`last`(默认)/`avg`/`max`/`min`/`sum`、`unit`、`scale` |
| `table` | 表格 | `source`=`series`/`summary` | `metric`（source=series 时必填）、`groupBy` |

公共字段：`id`（唯一，必填）、`title`、`width`=`half`(默认)/`full`、`hint`（面板下方一行说明）。
面板上限 24 个，折线序列上限 12 条，单值卡上限 8 张。

## 使用建议

- `counter` 类型的指标（委托数、完成数）平台按**窗口增量**画速率/柱高，不要自己算差分再上报；
- 「每个状态各有多少」用 `counter` + `labels`（字段名与 `groupBy` 一致），如
  `w.counter("order.status", 120, status="已成交")` 配 `{"metric":"order.status","groupBy":"status"}`；
- 延迟分位若脚本自己算，用 `gauge` 上报（`lat.p50`/`lat.p95`/`lat.p99`）；
- 同一个 metric 的全局值与分组值靠 `labels` 区分：全局不带 labels，分组带 `group` 等维度；
- 图表里引用的 metric 必须在场景/脚本里真的上报，否则面板显示为空。
