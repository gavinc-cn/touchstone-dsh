# Load test scenario JSON template

```json
{
  "base_url": "http://127.0.0.1:8080",
  "name": "Order service load test",
  "timeout_ms": 10000,
  "groups": [
    {
      "name": "place-order API",
      "method": "POST",
      "path": "/api/order",
      "headers": {"Content-Type": "application/json"},
      "body": "{\"sku\":\"A1\",\"num\":1}",
      "weight": 3
    },
    {
      "name": "query-order API",
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

## Field reference (failed validation fails the task immediately; check every item)

| Field | Required | Description and allowed range |
|-------|----------|-------------------------------|
| base_url | Yes | http(s)://host[:port], **without path/query** (the engine only uses host:port; a path prefix is rejected; the user:pass@ form is not supported, use headers for auth) |
| name | Yes | scenario name (non-empty) |
| timeout_ms | No | per-request timeout, 100~60000, default 10000 |
| groups[].name | Yes | interface group name, globally unique and non-empty |
| groups[].method | No | default GET; GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS |
| groups[].path | Yes | starts with `/`, may carry a query string |
| groups[].headers | No | object; **values must be scalars** (string/number; booleans and nested structures are rejected), values are converted to strings |
| groups[].body | No | string (a JSON request body must itself be an escaped string); ignored for GET/HEAD |
| groups[].weight | No | default 1; integer ≥1, picks the group at random by weight |
| stages[].conc | Yes | concurrency, 1~512 (platform capacity boundary; above that validation fails) |
| stages[].seconds | Yes | stage duration, 5~3600 seconds |
| groups / stages | Yes | groups 1~16, stages 1~8 (outside that validation fails) |

Note: `body` is a string — if the request body is JSON, write `"{\"k\":1}"` (escaped quotes).
