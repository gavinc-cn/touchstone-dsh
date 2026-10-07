#!/usr/bin/env python3
"""Touchstone 内置压测引擎（task_type=stress 专用，纯标准库）。

职责：校验 agent 生成的压测场景 JSON → 线程池并发发压 → 秒级快照落盘 →
汇总报告（JSON+Markdown）。只关心通信量与性能指标，不做响应内容断言。

另有两件事（2026-09-19 压测面板重构批次）：
- `MetricsWriter`：规范指标通道写入器（脚本与内置引擎共用，见 loadcase.py 契约）；
- `run` 子命令（`python3 loadgen.py run --scenario … --metrics …`）：平台发压轮对
  scenario 驱动的统一脚本调用入口（退出码 0 正常 / 2 场景非法 / 3 快速失败 / 4 其它）。

- 并发模型：每档位重建一组工作线程（线程数=档位并发数，档间毫秒级间隙），
  线程内独立 http.client 连接（keep-alive，连接类错误后重建）
- 指标聚合：固定延迟分桶（只收 2xx/3xx 成功请求），内存占用与请求总量无关
- 快照：每秒一行 JSON 追加到 snap_path（半行/坏行由读侧容忍，仅供展示）
- 停止：should_stop() 每请求与每秒各查一次；快速失败：第 10 秒窗口回看
  累计请求全部为连接类错误时中止（目标服务大概率不可达）

容量边界：线程模型定位内网服务、数百并发、数千 RPS 量级；
场景校验把并发钳制在 MAX_CONC 内即为此边界的服务端表达。
"""

import argparse
import bisect
import json
import os
import random
import socket
import sys
import threading
import time
from http.client import HTTPConnection, HTTPSConnection, HTTPException
from urllib.parse import urlsplit

# 延迟分桶上界（ms）：耗时落入首个 >= 耗时的边界桶；超出入 "over"
LAT_BOUNDS = (1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000)
# 场景字段取值范围（并发上限=平台线程模型容量边界）
MAX_CONC = 512
MAX_STAGES = 8
MAX_GROUPS = 16
# 快速失败观察窗（秒）：第 10 秒回看累计，全部为连接类错误则中止
QUICK_FAIL_SECONDS = 10
# 错误分类键（快照 err_breakdown / 报告错误分类使用）
ERR_CLASSES = ("4xx", "5xx", "timeout", "conn_err")


class QuickFailError(Exception):
    """快速失败：目标服务不可达，发压中止（runner 据此把任务标 failed）。"""


# ---------- 场景校验 ----------

def validate_scenario(path):
    """校验压测场景 JSON 文件。返回 (scenario, None) 或 (None, 错误说明)。

    校验通过时对 scenario 做规范化（method 转大写、补默认 timeout_ms），
    调用方（runner）拿到的即可直接发压的对象。规则与设计文档 §4 一致。
    """
    try:
        with open(path, encoding="utf-8") as f:
            sc = json.load(f)
    except OSError as e:
        return None, f"场景文件不存在或不可读: {e}"
    except ValueError as e:
        return None, f"场景不是合法 JSON: {e}"
    if not isinstance(sc, dict):
        return None, "场景顶层必须是 JSON 对象"
    base = str(sc.get("base_url", "")).strip()
    u = urlsplit(base)
    # 只接受 host[:port] 形式：带路径/query/fragment 时前缀会被引擎静默丢弃，压错目标；
    # user:pass@ 的凭据同样会被引擎静默丢弃（产出「看似正常」的报告），username 非空即拒绝
    if u.scheme not in ("http", "https") or not u.hostname or u.username \
            or u.path not in ("", "/") or u.query or u.fragment:
        return None, "base_url 必须是 http(s)://host[:port] 形式（不支持 user:pass@，鉴权走 headers）"
    try:
        u.port  # 端口非法（非数字/越界）访问时才抛：提前判掉，否则工作线程会在
    except ValueError:  # 建连接处静默死掉，产出「0 请求但正常结束」的假报告
        return None, "base_url 端口非法（必须是 1~65535 的整数）"
    sc["base_url"] = base
    if not str(sc.get("name", "")).strip():
        return None, "缺少 name（场景名）"
    groups = sc.get("groups")
    if not isinstance(groups, list) or not (1 <= len(groups) <= MAX_GROUPS):
        return None, f"groups 必须是 1~{MAX_GROUPS} 个的数组"
    seen = set()
    for g in groups:
        if not isinstance(g, dict):
            return None, "groups 元素必须是对象"
        name = str(g.get("name", "")).strip()
        if not name:
            return None, "groups[].name 不能为空"
        if name in seen:
            return None, f"groups[].name 重复: {name}"
        seen.add(name)
        g["name"] = name
        g["method"] = str(g.get("method", "GET")).upper()
        if g["method"] not in ("GET", "POST", "PUT", "PATCH", "DELETE",
                               "HEAD", "OPTIONS"):
            return None, f"{name}: method 非法"
        path_ = str(g.get("path", "")).strip()
        if not path_.startswith("/"):
            return None, f"{name}: path 必须以 / 开头"
        g["path"] = path_
        headers = g.get("headers", {})
        if not isinstance(headers, dict):
            return None, f"{name}: headers 必须是对象"
        # 值必须是标量：嵌套对象传给 http.client 会抛 TypeError 使工作线程静默死亡
        if any(not isinstance(v, (str, int, float)) or isinstance(v, bool)
               for v in headers.values()):
            return None, f"{name}: headers 的值必须是标量"
        w = g.get("weight", 1)
        if not isinstance(w, int) or isinstance(w, bool) or w < 1:
            return None, f"{name}: weight 必须是 >=1 的整数"
        g["weight"] = w  # 缺省时补默认值写回，否则 run_load 的 _pick_group 会 KeyError
        if "body" in g and not isinstance(g["body"], str):
            return None, f"{name}: body 必须是字符串"
    stages = sc.get("stages")
    if not isinstance(stages, list) or not (1 <= len(stages) <= MAX_STAGES):
        return None, f"stages 必须是 1~{MAX_STAGES} 档的数组"
    for s in stages:
        if not isinstance(s, dict):
            return None, "stages 元素必须是对象"
        c, sec = s.get("conc"), s.get("seconds")
        if not isinstance(c, int) or isinstance(c, bool) or not (1 <= c <= MAX_CONC):
            return None, f"conc 必须是 1~{MAX_CONC} 的整数（平台容量边界）"
        if not isinstance(sec, int) or isinstance(sec, bool) or not (5 <= sec <= 3600):
            return None, "seconds 必须是 5~3600 的整数"
    t = sc.get("timeout_ms", 10000)
    if not isinstance(t, int) or isinstance(t, bool) or not (100 <= t <= 60000):
        return None, "timeout_ms 必须是 100~60000 的整数"
    sc["timeout_ms"] = t
    return sc, None


# ---------- 分桶与统计 ----------

def _bucket_of(ms):
    """耗时（ms）→ 分桶键：首个 >= 耗时的边界值字符串；超出归 "over"。"""
    i = bisect.bisect_left(LAT_BOUNDS, ms)
    return str(LAT_BOUNDS[i]) if i < len(LAT_BOUNDS) else "over"


def _pct_from_buckets(buckets, pct):
    """分桶累计 + 桶内线性插值取分位数（ms）；无成功请求返回 None。"""
    total = sum(buckets.values())
    if not total:
        return None
    target = total * pct / 100.0
    cum, prev_upper = 0, 0
    for b in [str(x) for x in LAT_BOUNDS] + ["over"]:
        c = buckets.get(b, 0)
        if c and cum + c >= target:
            upper = LAT_BOUNDS[-1] if b == "over" else int(b)
            frac = (target - cum) / c
            return round(prev_upper + (upper - prev_upper) * frac, 1)
        cum += c
        prev_upper = LAT_BOUNDS[-1] if b == "over" else int(b)
    return None


def _max_from_buckets(buckets):
    """max 近似：最大非空桶的上界（引擎不存逐请求样本，接受近似）。"""
    for b in reversed([str(x) for x in LAT_BOUNDS] + ["over"]):
        if buckets.get(b, 0):
            return LAT_BOUNDS[-1] if b == "over" else int(b)
    return None


def _metrics(stat, duration_s, peak_rps=None):
    """从一组累计计数算指标 dict（分位数由分桶插值近似）。"""
    m = {
        "total": stat["count"], "errors": stat["err"],
        "err_rate": round(stat["err"] / stat["count"], 4) if stat["count"] else 0.0,
        "rps_avg": round(stat["count"] / duration_s, 2) if duration_s > 0 else 0.0,
        "err_breakdown": dict(stat["err_cls"]),
        "p50": _pct_from_buckets(stat["buckets"], 50),
        "p90": _pct_from_buckets(stat["buckets"], 90),
        "p99": _pct_from_buckets(stat["buckets"], 99),
        "max": _max_from_buckets(stat["buckets"]),
    }
    if peak_rps is not None:
        m["rps_peak"] = round(peak_rps, 2)
    return m


class _Agg:
    """线程安全计数器：累计（报告用）+ 当秒窗口（快照用）。

    结构：{组名 或 "__all__": {"count", "err", "err_cls", "buckets"}}；
    延迟分桶只收成功请求，错误按 4xx/5xx/timeout/conn_err 分类计数。
    """

    def __init__(self, group_names):
        keys = list(group_names) + ["__all__"]
        self.lock = threading.Lock()
        self.total = {k: self._new_group() for k in keys}
        self.window = {k: self._new_group() for k in keys}

    @staticmethod
    def _new_group():
        return {"count": 0, "err": 0,
                "err_cls": {k: 0 for k in ERR_CLASSES},
                "buckets": {str(b): 0 for b in LAT_BOUNDS + ("over",)}}

    def add(self, group, ok, bucket=None, err_cls=None):
        """记一次请求结果（成功带分桶键，失败带错误分类），累计+当秒窗口各记一次。"""
        with self.lock:
            for tgt in (self.total, self.window):
                for key in (group, "__all__"):
                    g = tgt[key]
                    g["count"] += 1
                    if ok:
                        g["buckets"][bucket] += 1
                    else:
                        g["err"] += 1
                        g["err_cls"][err_cls] += 1

    def take_window(self):
        """原子取走当秒窗口并换新，返回窗口快照 dict。"""
        with self.lock:
            win, self.window = self.window, {
                k: self._new_group() for k in self.window}
        return win

    def copy_total(self):
        """累计计数的深拷贝（阶段差值/最终报告用）。"""
        with self.lock:
            return {k: {"count": v["count"], "err": v["err"],
                        "err_cls": dict(v["err_cls"]), "buckets": dict(v["buckets"])}
                    for k, v in self.total.items()}


# ---------- 规范指标通道 ----------

class MetricsWriter:
    """规范化指标通道写入器（一行一样本，线程安全，逐行 flush）。

    契约（与解析侧 loadcase.normalize_line 一致）：
    - `sample(metric, value, type=…)`：point 样本，`gauge`=瞬时值 / `counter`=单调
      递增累计值（图表按窗口增量换算速率）；
    - `meta(**fields)`：上下文行（目标地址、档位等），可省略；
    - `summary(values)`：收尾 KPI 字典，取最后一条。

    压测脚本用 `from loadgen import MetricsWriter` 直接复用（平台把项目根放进
    PYTHONPATH，并经 TS_METRICS_FILE 给出输出路径）。通道不可写时静默降级——
    指标落盘失败不该中断压测本身。
    """

    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()
        self._f = None
        try:
            self._f = open(path, "ab")
        except OSError:
            self._f = None

    def close(self):
        """关闭底层文件（幂等；重复调用安全）。"""
        with self._lock:
            if self._f is not None:
                try:
                    self._f.close()
                except OSError:
                    pass
                self._f = None

    def _write(self, obj):
        """加锁写一行 JSON（失败静默，通道是尽力而为的附属产物）。"""
        with self._lock:
            if self._f is None:
                return
            try:
                self._f.write(json.dumps(obj, ensure_ascii=False).encode("utf-8") + b"\n")
                self._f.flush()
            except OSError:
                pass

    @staticmethod
    def _norm_labels(labels):
        """标签归一：只保留标量值并统一键为字符串（与校验/解析口径一致）。"""
        out = {}
        for k, v in (labels or {}).items():
            if isinstance(v, bool) or not isinstance(v, (str, int, float)):
                continue
            out[str(k)] = v
        return out

    def sample(self, metric, value, *, type="gauge", labels=None, ts=None):
        """写一条样本；value 非数字或 type 非法时丢弃（不抛异常给压测主流程）。"""
        if type not in ("gauge", "counter"):
            type = "gauge"
        try:
            val = float(value)
        except (TypeError, ValueError):
            return
        obj = {"ts": float(ts) if ts is not None else time.time(),
               "metric": str(metric), "value": val, "type": type}
        lb = self._norm_labels(labels)
        if lb:
            obj["labels"] = lb
        self._write(obj)

    def gauge(self, metric, value, ts=None, **labels):
        """瞬时值样本（标签以关键字参数给出，如 w.gauge("rps", 10, group="下单")）。

        `ts` 是**样本时间戳**（缺省取写入时刻），不是标签——它是独立形参，绝不会
        落进 labels（历史缺陷：签名缺 ts 时 `w.gauge(..., ts=t)` 会把 t 写成维度，
        见 bug_report/20261004_2040）。
        """
        self.sample(metric, value, type="gauge", labels=labels, ts=ts)

    def counter(self, metric, value, ts=None, **labels):
        """累计计数样本（值须单调不减，如委托数/总请求数）；`ts` 语义同 gauge。"""
        self.sample(metric, value, type="counter", labels=labels, ts=ts)

    def meta(self, **fields):
        """写一条 meta 上下文行（None 值字段丢弃）。"""
        obj = {"kind": "meta", "ts": time.time()}
        obj.update({k: v for k, v in fields.items() if v is not None})
        self._write(obj)

    def summary(self, values):
        """写收尾 KPI 行（values 必须是 dict；空白/非 dict 忽略）。"""
        if not isinstance(values, dict) or not values:
            return
        self._write({"kind": "summary", "ts": time.time(),
                     "values": {str(k): v for k, v in values.items()}})


def _emit_tick(w, ts, conc, win, total):
    """把当秒窗口 + 累计计数写成一屏规范样本（口径与默认面板/模板一致）。

    全局：rps / err.rate / lat.p50|p90|p99 / conc + 累计 req.total / req.errors；
    分接口：rps / err.rate / lat.p95，带 labels={"group": 组名}。
    """
    allw = win["__all__"]
    count = float(allw["count"])
    w.sample("rps", count, ts=ts)
    w.sample("err.rate", (allw["err"] / count) if count else 0.0, ts=ts)
    w.sample("conc", int(conc), ts=ts)
    for pct in (50, 90, 99):
        val = _pct_from_buckets(allw["buckets"], pct)
        if val is not None:
            w.sample(f"lat.p{pct}", val, ts=ts)
    for name, g in win.items():
        if name == "__all__":
            continue
        g_count = float(g["count"])
        w.sample("rps", g_count, labels={"group": name}, ts=ts)
        w.sample("err.rate", (g["err"] / g_count) if g_count else 0.0,
                 labels={"group": name}, ts=ts)
        g_p95 = _pct_from_buckets(g["buckets"], 95)
        if g_p95 is not None:
            w.sample("lat.p95", g_p95, labels={"group": name}, ts=ts)
    t_all = total["__all__"]
    w.counter("req.total", t_all["count"], ts=ts)
    w.counter("req.errors", t_all["err"], ts=ts)


# ---------- 发压 ----------

def _new_conn(base, timeout_s):
    """按解析后的 base 建一条 keep-alive HTTP(S) 连接。"""
    port = base.port or (443 if base.scheme == "https" else 80)
    cls = HTTPSConnection if base.scheme == "https" else HTTPConnection
    return cls(base.hostname, port, timeout=timeout_s)


def _one_request(base, conn, group, timeout_s):
    """在给定连接上发一次请求，返回 (conn, ok, bucket, err_cls)。

    conn 传 None 或遇到连接类错误时返回 None（调用方下轮重建连接）；
    响应体必须 read 丢弃，否则 keep-alive 连接无法复用。
    """
    if conn is None:
        conn = _new_conn(base, timeout_s)
    method, path = group["method"], group["path"]
    body = group.get("body") if method not in ("GET", "HEAD") else None
    t0 = time.perf_counter()
    try:
        # header 值统一转字符串：http.client 只接受 str/int，float/bool 会让
        # putheader 抛 TypeError 使工作线程静默死亡（校验层已保证值是标量）
        conn.request(method, path, body=body,
                     headers={k: v if isinstance(v, str) else str(v)
                              for k, v in (group.get("headers") or {}).items()})
        resp = conn.getresponse()
        status = resp.status
        resp.read()
        ms = (time.perf_counter() - t0) * 1000.0
        if 200 <= status < 400:  # 3xx 视为成功（压测不跟随重定向）
            return conn, True, _bucket_of(ms), None
        return conn, False, None, ("4xx" if status < 500 else "5xx")
    except (socket.timeout, TimeoutError):
        return conn, False, None, "timeout"
    except (OSError, HTTPException):
        try:
            conn.close()
        except OSError:
            pass
        return None, False, None, "conn_err"


def _pick_group(groups):
    """按 weight 加权随机选一组（权重越大被压得越多）。"""
    x = random.randrange(sum(g["weight"] for g in groups))
    for g in groups:
        x -= g["weight"]
        if x < 0:
            return g
    return groups[-1]


def _worker(base, groups, timeout_s, deadline, agg, stop):
    """单工作线程：keep-alive 连接循环发请求，直到档位截止或 stop() 为真。"""
    conn = None
    while time.time() < deadline and not stop():
        g = _pick_group(groups)
        conn, ok, bucket, err_cls = _one_request(base, conn, g, timeout_s)
        agg.add(g["name"], ok, bucket, err_cls)


def _append(path, text):
    """追加文本到日志文件（utf-8，失败静默——日志是尽力而为的附属产物）。"""
    try:
        with open(path, "ab") as f:
            f.write(text.encode("utf-8", errors="replace"))
    except OSError:
        pass


def run_load(scenario, *, log_path, snap_path, should_stop=None, metrics_path=None):
    """执行压测（阻塞直到全部档位完成 / should_stop / 快速失败）。

    返回 (report, summary_line)。快照每秒一行追加 snap_path（旧格式，保留）；
    metrics_path 非空时同步产出规范指标行（新前端读它），开头补 meta 行、
    收尾补 summary 行（快速失败/停止同样收尾）。人类可读进度每 10 秒追加
    log_path。目标不可达抛 QuickFailError。
    """
    stop = should_stop or (lambda: False)
    base = urlsplit(scenario["base_url"])
    groups, timeout_s = scenario["groups"], scenario["timeout_ms"] / 1000.0
    agg = _Agg([g["name"] for g in groups])
    started = time.time()
    peak_rps = 0.0
    aborted = threading.Event()   # 快速失败标志
    done = threading.Event()      # 整个发压结束标志（通知 ticker 退出）
    cur_stage = [0, 0]            # 当前 [档位号, 并发数]（ticker 读）
    stage_stats = []              # 每档结束时的差值指标

    snapf = open(snap_path, "ab")
    w = MetricsWriter(metrics_path) if metrics_path else None
    if w:
        w.meta(target=scenario["base_url"], case=scenario["name"],
               stages=[{"conc": s["conc"], "seconds": s["seconds"]}
                       for s in scenario["stages"]])

    def ticker():
        """每秒：取走当秒窗口 → 快照行 + 规范指标行 + 每 10s 进度日志 + 快速失败判定。"""
        nonlocal peak_rps
        n = 0
        quick = {"count": 0, "err": 0, "conn_like": 0}
        while not done.is_set():
            time.sleep(1.0)
            if done.is_set():
                break
            win = agg.take_window()
            allw = win["__all__"]
            n += 1
            peak_rps = max(peak_rps, float(allw["count"]))
            now = int(time.time())
            line = {"ts": now, "stage": cur_stage[0],
                    "conc": cur_stage[1], "rps": float(allw["count"]),
                    "err": allw["err"],
                    "groups": {k: {"rps": float(v["count"]), "err": v["err"],
                                   "lat": dict(v["buckets"])}
                               for k, v in win.items() if k != "__all__"}}
            try:
                snapf.write(json.dumps(line, ensure_ascii=False).encode("utf-8") + b"\n")
                snapf.flush()
            except OSError:
                pass
            if w:
                _emit_tick(w, now, cur_stage[1], win, agg.copy_total())
            if n % 10 == 0:
                _append(log_path, f"### 进度 t={n}s 档{cur_stage[0]}"
                                  f" RPS={allw['count']} 错误={allw['err']}\n")
            # 快速失败观察窗累计（连接超时/失败 视为「目标不可达」类）
            if n <= QUICK_FAIL_SECONDS:
                quick["count"] += allw["count"]
                quick["err"] += allw["err"]
                quick["conn_like"] += (allw["err_cls"]["conn_err"]
                                       + allw["err_cls"]["timeout"])
                if n == QUICK_FAIL_SECONDS and quick["count"] > 0 \
                        and quick["err"] == quick["count"] \
                        and quick["conn_like"] == quick["err"]:
                    aborted.set()
                    done.set()

    tick = threading.Thread(target=ticker, daemon=True, name="loadgen-tick")
    tick.start()
    try:
        for i, st in enumerate(scenario["stages"], 1):
            if stop() or aborted.is_set():
                break
            cur_stage[0], cur_stage[1] = i, st["conc"]
            t0_copy = agg.copy_total()
            deadline = time.time() + st["seconds"]
            threads = [threading.Thread(target=_worker, daemon=True,
                                        args=(base, groups, timeout_s, deadline,
                                              agg, lambda: stop() or aborted.is_set()))
                       for _ in range(st["conc"])]
            for t in threads:
                t.start()
            for t in threads:
                t.join()  # 停止时线程至多再跑一个请求周期（受 timeout_s 约束）
            dt = agg.copy_total()
            # 档位指标一律取当档差值（count/err/err_cls/buckets 逐键 dt − t0），
            # 否则多档位时各档分位数/错误分类会混入前档累计数据
            t0a, dta = t0_copy["__all__"], dt["__all__"]
            delta_all = {
                "count": dta["count"] - t0a["count"],
                "err": dta["err"] - t0a["err"],
                "err_cls": {k: dta["err_cls"][k] - t0a["err_cls"][k]
                            for k in dta["err_cls"]},
                "buckets": {k: dta["buckets"][k] - t0a["buckets"][k]
                            for k in dta["buckets"]},
            }
            stage_stats.append({"conc": st["conc"], "seconds": st["seconds"],
                                **_metrics(delta_all, st["seconds"])})
    finally:
        done.set()
        tick.join()
        snapf.close()
    if aborted.is_set():
        if w:
            t = agg.copy_total()["__all__"]
            w.summary({"总请求": t["count"], "错误数": t["err"], "结果": "快速失败"})
            w.close()
        raise QuickFailError("快速失败：发压前 10 秒请求全部为连接超时/失败，"
                             "目标服务可能不可达")

    duration = time.time() - started
    total = agg.copy_total()
    report = {
        "scenario": scenario["name"], "base_url": scenario["base_url"],
        "started_at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(started)),
        "duration_sec": round(duration, 1), "stopped": bool(stop()),
        "stages": stage_stats,
        "overall": _metrics(total["__all__"], duration, peak_rps),
        "groups": {g["name"]: _metrics(total[g["name"]], duration)
                   for g in groups},
    }
    o = report["overall"]
    summary_line = (f"LOAD 总请求={o['total']} 错误率={o['err_rate'] * 100:.1f}%"
                    f" P50={o['p50']}ms P99={o['p99']}ms 平均RPS={o['rps_avg']}"
                    + ("（用户停止）" if report["stopped"] else ""))
    if w:
        # 收尾 KPI：与 report.overall 同源，供面板单值卡与脚本驱动报告共用
        w.summary({"总请求": o["total"], "错误率": f"{o['err_rate'] * 100:.2f}%",
                   "平均RPS": o["rps_avg"], "峰值RPS": o.get("rps_peak", 0),
                   "P50": o["p50"], "P90": o["p90"], "P99": o["p99"]})
        w.close()
    return report, summary_line


# ---------- 报告 ----------

def _fmt_errs(err_cls):
    """错误分类 dict → "4xx=1 5xx=0 超时=2 连接=3" 形式的短文本。"""
    return (f"4xx={err_cls.get('4xx', 0)} 5xx={err_cls.get('5xx', 0)}"
            f" 超时={err_cls.get('timeout', 0)} 连接={err_cls.get('conn_err', 0)}")


def _report_md(report):
    """报告 Markdown 文本：总览 + 档位 + 分接口三张表。"""
    o = report["overall"]
    lines = [
        f"# 压测报告：{report['scenario']}", "",
        f"- 目标：{report['base_url']}",
        f"- 开始：{report['started_at']} · 时长 {report['duration_sec']}s"
        + ("（用户停止，部分结果）" if report.get("stopped") else ""), "",
        "## 总览", "",
        "| 指标 | 值 |", "|---|---|",
        f"| 总请求 | {o['total']} |",
        f"| 错误率 | {o['err_rate'] * 100:.2f}% |",
        f"| 平均 RPS | {o['rps_avg']} |",
        f"| 峰值 RPS | {o.get('rps_peak', '-')} |",
        f"| P50 / P90 / P99 | {o['p50']} / {o['p90']} / {o['p99']} ms |",
        f"| max（近似） | {o['max']} ms |",
        f"| 错误分类 | {_fmt_errs(o['err_breakdown'])} |", "",
        "## 档位", "",
        "| 并发 | 时长(s) | RPS | 错误率 |", "|---|---|---|---|",
    ]
    for s in report["stages"]:
        lines.append(f"| {s['conc']} | {s['seconds']} | {s['rps_avg']}"
                     f" | {s['err_rate'] * 100:.2f}% |")
    lines += ["", "## 分接口", "",
              "| 接口 | 请求 | 错误率 | P50 | P90 | P99 | max |", "|---|---|---|---|---|---|---|"]
    for name, g in report["groups"].items():
        lines.append(f"| {name} | {g['total']} | {g['err_rate'] * 100:.2f}%"
                     f" | {g['p50']} | {g['p90']} | {g['p99']} | {g['max']} |")
    lines.append("")
    return "\n".join(lines)


def write_report_files(report, report_dir, task_id, run_key=""):
    """报告落盘：<report_dir>/task<id>_<运行键>.{json,md}。返回 (json_path, md_path)。

    文件名只含 task id + 运行键（场景名可能含中文/特殊字符，不进文件名）；
    同任务重跑产生新运行键的文件，读侧按运行键/最新取用。
    run_key 为空时回落分钟级命名（存量路径与单测用）。
    """
    os.makedirs(report_dir, exist_ok=True)
    stem = os.path.join(report_dir,
                        f"task{task_id}_{run_key or time.strftime('%Y%m%d_%H%M')}")
    with open(stem + ".json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    with open(stem + ".md", "w", encoding="utf-8") as f:
        f.write(_report_md(report))
    return stem + ".json", stem + ".md"


# ---------- 命令行入口（平台发压轮的 scenario 驱动调用）----------

def _cmd_run(args):
    """run 子命令：校验场景 → 发压 → 报告落盘，返回进程退出码。

    退出码 0=正常 / 2=场景非法 / 3=快速失败 / 4=其它异常（runner 据此判 failed）。
    stdout 输出一行 LOAD 摘要（平台把它留在发压日志里），stderr 输出失败原因。
    """
    scenario, err = validate_scenario(args.scenario)
    if err:
        sys.stderr.write(f"场景校验失败：{err}\n")
        return 2
    should_stop = ((lambda: os.path.exists(args.stop_file))
                   if args.stop_file else None)
    try:
        report, summary_line = run_load(
            scenario, log_path=args.log or os.devnull,
            snap_path=args.snapshot or os.devnull,
            should_stop=should_stop, metrics_path=args.metrics or None)
    except QuickFailError as e:
        sys.stderr.write(f"{e}\n")
        return 3
    except Exception as e:  # 兜底：任何异常都要让调用方拿到非 0 退出码
        sys.stderr.write(f"发压异常：{e}\n")
        return 4
    if args.report_dir and args.task_id:
        try:
            write_report_files(report, args.report_dir, args.task_id,
                               run_key=getattr(args, "run_key", "") or "")
        except OSError as e:
            sys.stderr.write(f"报告写盘失败：{e}\n")
    sys.stdout.write(summary_line + "\n")
    return 0


def main(argv=None):
    """命令行入口：`python3 loadgen.py run --scenario … --metrics …`。"""
    ap = argparse.ArgumentParser(
        prog="loadgen.py", description="Touchstone 内置压测引擎（scenario 驱动）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="按场景 JSON 发压并产出规范指标行")
    r.add_argument("--scenario", required=True, help="场景 JSON 路径")
    r.add_argument("--metrics", default="", help="规范指标通道输出路径")
    r.add_argument("--snapshot", default="", help="旧格式秒级快照输出路径")
    r.add_argument("--log", default="", help="人类可读进度日志路径")
    r.add_argument("--stop-file", default="", help="出现即优雅停止的标志文件")
    r.add_argument("--report-dir", default="", help="报告输出目录")
    r.add_argument("--task-id", type=int, default=0, help="任务 id（报告命名用）")
    r.add_argument("--run-key", default="", help="发压运行键（报告/产物按运行切分用）")
    args = ap.parse_args(argv)
    return _cmd_run(args)


if __name__ == "__main__":
    sys.exit(main())
