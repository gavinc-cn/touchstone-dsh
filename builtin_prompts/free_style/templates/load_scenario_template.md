# 压测场景 JSON 模板

```json
{
  "base_url": "http://127.0.0.1:8080",
  "name": "订单服务压测",
  "timeout_ms": 10000,
  "groups": [
    {
      "name": "下单接口",
      "method": "POST",
      "path": "/api/order",
      "headers": {"Content-Type": "application/json"},
      "body": "{\"sku\":\"A1\",\"num\":1}",
      "weight": 3
    },
    {
      "name": "查询接口",
      "method": "GET",
      "path": "/api/order/123",
      "weight": 7
    }
  ],
  "stages": [
    {"conc": 10, "seconds": 60},
    {"conc": 50, "seconds": 120},
    {"conc": 100, "seconds": 60}
  ]
}
```

## 字段说明（校验不通过任务直接失败，务必逐项对照）

| 字段 | 必填 | 说明与取值范围 |
|------|------|----------------|
| base_url | 是 | http(s)://host[:port]，**不带路径/query**（引擎只用 host:port，路径前缀会被拒绝；不支持 user:pass@ 形式，鉴权走 headers） |
| name | 是 | 场景名（非空） |
| timeout_ms | 否 | 单请求超时，100~60000，缺省 10000 |
| groups[].name | 是 | 接口组名，全局唯一非空 |
| groups[].method | 否 | 默认 GET；GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS |
| groups[].path | 是 | 以 `/` 开头，可带 query |
| groups[].headers | 否 | 对象；**值必须是标量**（字符串/数字；布尔与嵌套结构会被拒绝），值会被转为字符串 |
| groups[].body | 否 | 字符串（JSON 请求体需自身是转义后的字符串）；GET/HEAD 忽略 |
| groups[].weight | 否 | 默认 1；≥1 整数，加权随机选组 |
| stages[].conc | 是 | 并发数，1~512（平台容量边界，超出校验失败） |
| stages[].seconds | 是 | 档位时长，5~3600 秒 |
| groups / stages | 是 | groups 1~16 个、stages 1~8 档（超出校验失败） |

注意：`body` 是字符串——若请求体是 JSON，写成 `"{\"k\":1}"`（引号转义）。
