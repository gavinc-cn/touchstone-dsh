#!/usr/bin/env python3
"""后端 i18n 运行时（Python）——与 `backend/lib/i18n.js` 同算法、同词典、同期望表。

口径（与前端 `webui/src/utils/i18n.js` 保持一致，只是多了 ns 维度与请求语言解析）：
  - 中文原文即 key：`zh` 直接对 key 插值返回，不查词典；
  - `en` 查 `<repo>/i18n/en.json` 的 `dict[ns][key]`；值是 str 直接用，是 dict 则按
    共享 `_to_plural_number(vars["n"]) == 1` 取 one，否则 other（只有 one/other 两档）；
  - 缺失 key / 缺失 ns / 词条类型非法一律回落插值后的中文 key，`t` 永不抛错；
  - 插值占位符为 `{name}`（仅标识符形状，`re.ASCII` 与 JS 的 `\\w` 对齐）；
    变量缺失/None/对象等保留占位符原样，布尔插 "true"/"false"，数字按 JS String 口径；
  - 语言解析 `resolve_lang` 优先级：`X-TS-Lang` 头 → `?lang=` → `user_pref` → `"zh"`，
    非法值跳过继续下一档；头名大小写不敏感（headers 可为 dict 或 email.message.Message），
    值接受 `zh|en` 及其大小写/地区变体（`ZH`、`zh-CN`、`zh_CN`、`en-US`… 均归一）；
  - 无任何语言信号时默认 `"zh"`（存量行为零变化：老客户端不带 `X-TS-Lang` 仍是中文）；
  - `TS_I18N=0` 是回滚开关：`t`/`resolve_lang` 恒中文（`normalize_lang` 纯函数不受影响）；
  - 词典文件只在首次用到时读一次并缓存（并发首读加锁，只读/只告警一次）；
    读不到/JSON 损坏（含 NaN/Infinity）时 warning 一次后降级为仅中文。

本文件只提供运行时，不含任何调用点（T10/T11/T12/T14 分别消费 api/prompt 词条）。
零新依赖：只用标准库 json/logging/math/os/re/threading/urllib。
"""
import json
import logging
import math
import os
import re
import threading
from urllib.parse import parse_qsl

# 模块 logger：告警走 logging（root 无 handler 时由 lastResort 打到 stderr），
# 既能在生产日志里看到，也能被 pytest caplog 捕获。
_LOG = logging.getLogger(__name__)

# 仓库根定位：本文件在 <repo>/backend_py/ 下，上溯一级（与 prompts.py 的 _ASSET_DIR 同一锚点风格）
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 词典唯一真源：<repo>/i18n/en.json（web/api/prompt 三个命名空间；Node 与 Python 同读一份）
_DICT_PATH = os.path.join(_REPO_ROOT, "i18n", "en.json")

# 插值占位符：{name}，name 仅限标识符形状（re.ASCII 让 \w 与 JS 的 \w 同集）
_PLACEHOLDER = re.compile(r"\{([A-Za-z_]\w*)\}", re.ASCII)
# 空词典哨兵：加载失败后缓存它，保证后续调用不再反复读盘/告警，同时恒走中文
_EMPTY_DICT = {}
# 词典缓存：None = 尚未读取；dict = 已读取（失败时也写入 _EMPTY_DICT）
_DICT = None
# 告警去重标记：一个进程只 warning 一次（reset_cache 供测试重放）
_WARNED = False
# 首读锁：ThreadingHTTPServer 下多个请求可能同时首次触发 en 查表，
# 必须在锁内做「已缓存」复查，避免同一份词典被并发读/解析/告警多次。
_DICT_LOCK = threading.Lock()
# 十进制字面量：两端共用的复数 n 解析口径。
# 只认十进制，避免 JS `Number('0x10') === 16` 与 Python `float('1_0') === 10` 这类分叉；
# 空串/abc/布尔/数组/对象/None 一律视为非法（→ other）。
_DECIMAL_RE = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\Z", re.ASCII)


def _reject_json_constant(value):
    """拒绝 JSON 里的 NaN/Infinity/-Infinity：与 Node JSON.parse 保持一致的严格口径。

    否则同一份被污染的词典在 Python 侧能加载、Node 侧整份降级，双端行为分叉。
    """
    raise ValueError(f"非法 JSON 常量: {value}")


def _warn_once(dict_path, exc):
    """词典加载失败时告警一次（带目标路径与原因），后续失败静默。

    调用方 load_dict 已在 _DICT_LOCK 内，检查与置位天然原子。
    """
    global _WARNED
    if _WARNED:
        return
    _WARNED = True
    _LOG.warning("[i18n] 词典加载失败，已降级为仅中文: %s: %s", dict_path, exc)


def load_dict(dict_path=None):
    """读取并缓存词典。

    :param dict_path: 测试钩子：显式路径（缺省读 <repo>/i18n/en.json）。显式传参会绕过
        「已缓存」短路，便于单测换词典；不传时进程内只读一次。
    :returns: 词典 dict；读取/解析失败返回空 dict（并已警告一次）。

    并发语义：锁外快路径避免热路径抢锁；锁内再做一次「已缓存」复查，
    保证并发首读只读盘/解析/告警一次。
    """
    global _DICT
    if dict_path is None and _DICT is not None:
        return _DICT
    with _DICT_LOCK:
        if dict_path is None and _DICT is not None:
            return _DICT
        target = _DICT_PATH if dict_path is None else dict_path
        try:
            with open(target, "r", encoding="utf-8") as handle:
                # parse_constant 拒绝 NaN/Infinity/-Infinity，与 Node JSON.parse 同口径
                parsed = json.load(handle, parse_constant=_reject_json_constant)
            if not isinstance(parsed, dict):
                raise ValueError("词典根节点必须是对象")
            _DICT = parsed
        except Exception as exc:  # noqa: BLE001 —— 读不到/读坏一律降级，绝不抛给调用方
            _warn_once(target, exc)
            _DICT = _EMPTY_DICT
        return _DICT


def reset_cache():
    """清空词典缓存与告警标记（测试钩子；生产无需调用）。"""
    global _DICT, _WARNED
    with _DICT_LOCK:
        _DICT = None
        _WARNED = False


def normalize_lang(value):
    """语言归一：接受大小写/地区变体（ZH、zh-CN、zh_CN、en-US…）返回 zh/en；
    其余（含非字符串）返回 None。纯函数，不受 TS_I18N 影响。"""
    if not isinstance(value, str):
        return None
    base = re.split(r"[-_]", value.strip().lower(), maxsplit=1)[0]
    return base if base in ("zh", "en") else None


def _is_disabled():
    """回滚开关：TS_I18N=0 时返回 True（t/resolve_lang 恒中文）。每次调用都读环境变量。"""
    return os.environ.get("TS_I18N", "").strip() == "0"


def _shortest_decimal(value):
    """把正有限 float 拆成 (最短 round-trip 有效数字, n)，满足 value = 0.<digits> × 10^n。

    Python 3.1+ 的 repr 与 JS Number.prototype.toString 都采用最短 round-trip 表示，
    这里只把 repr 的「十进制/指数」排版拆成 ECMAScript Number::toString 所需的
    digits/n，再由 _js_number_to_string 统一排版（固定小数点或 e±N）。
    """
    text = repr(value)
    if "e" in text or "E" in text:
        mantissa, exponent_text = re.split("[eE]", text, maxsplit=1)
        exponent = int(exponent_text)
    else:
        mantissa, exponent = text, 0
    if "." in mantissa:
        integer_part, fraction_part = mantissa.split(".", 1)
    else:
        integer_part, fraction_part = mantissa, ""
    combined = integer_part + fraction_part
    significant = combined.lstrip("0")
    if not significant:  # 理论上 value == 0 已在调用方提前返回
        return "0", 1
    # n 用去尾零之前的有效位数计算：尾零不影响 0.<digits> × 10^n 的值
    digits = significant.rstrip("0") or "0"
    n = len(significant) + exponent - len(fraction_part)
    return digits, n


def _js_number_to_string(value):
    """把 Python 数字格式化为 JS `String(number)` 的表示（双端插值契约 A）。

    覆盖 NaN/±Infinity、整数（1.0 → "1"）、固定小数点与指数阈值（1e21 → "1e+21"、
    1e-7 → "1e-7"），规则照 ECMAScript Number::toString。
    残余限制：Python int 是任意精度而 JS Number 只有 float64；超大整数按十进制原样输出。
    """
    if isinstance(value, bool):  # 防御：调用方已先判 bool
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    digits, n = _shortest_decimal(abs(value))
    k = len(digits)
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        exponent = n - 1
        exp_sign = "+" if exponent >= 0 else "-"
        mantissa = digits[0] if k == 1 else digits[0] + "." + digits[1:]
        body = f"{mantissa}e{exp_sign}{abs(exponent)}"
    return sign + body


def _stringify(value, placeholder):
    """把插值变量转成字符串（与 Node `_stringify` 同一口径）。

    - str 原样；bool → "true"/"false"（不是 Python 的 True/False）；
    - int/float → JS 风格数字（1.0 → "1"、NaN/±Infinity 按 JS 拼写）；
    - None 与其余类型（list/dict/异常/抛错对象…）→ 保留占位符（绝不 str(对象)）。
    """
    if value is None:
        return placeholder
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _js_number_to_string(value)
    return placeholder


def js_string(value):
    """把任意值按 JS `String(value)` 的口径强制转成字符串（错误值 coercion 专用）。

    为什么需要它（T11 fix round 1）：Node 的 `ctx.error` 对非字符串 message 不做特殊
    处理，最终由 `respondError`/`respondErrorSpaced` 里的 `String(message)` 转换；Python
    若用 `str(message)` 会在这些边角上分叉：`None` → "None"（Node "null"）、
    `True` → "True"（Node "true"）、`{"a": 1}` → "{'a': 1}"（Node "[object Object]"）。
    驱动 HTTP 错误的非字符串 `detail` 同理：若直接塞进 vars，`_stringify` 对对象会
    保留 `{driver_detail}` 占位符，故调用方应先经本函数转换。

    与 `_stringify` 的区别：`_stringify` 是**插值**口径（对象/None 保留占位符），
    本函数是**强制转换**口径（绝不保留占位符），对应 ECMAScript `ToString`：
      - null → "null"（Python 无 undefined，None 即 null）；
      - bool → "true"/"false"；
      - 数字 → JS 最短 round-trip 表示（1.0 → "1"、NaN/±Infinity 按 JS 拼写）；
      - 数组 → 逐元素 ToString 后逗号连接，null 元素为空串（String([1,null,2]) == "1,,2"）；
      - 普通对象 → "[object Object]"；bytes/bytearray → UTF-8 文本（Node Buffer）；
      - 其余对象 → `str(value)`（对应自定义 toString）。
    残余限制：Python int 任意精度、JS Number 为 float64（超大整数会分叉）；Set/Map
    等 JS 内建对象没有逐一对齐（按自定义 `__str__` 处理）。本函数绝不抛错。
    """
    try:
        if value is None:
            return "null"
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, str):
            return value
        if isinstance(value, (int, float)):
            return _js_number_to_string(value)
        if isinstance(value, (list, tuple)):
            return ",".join("" if item is None else js_string(item) for item in value)
        if isinstance(value, dict):
            return "[object Object]"
        if isinstance(value, (bytes, bytearray)):
            return bytes(value).decode("utf-8", "replace")
        return str(value)
    except Exception:  # noqa: BLE001 —— 错误路径的 coercion 绝不能反过来抛错
        return ""


def _interpolate(text, variables):
    """插值 {name}：变量缺失/None/对象等一律保留占位符原样，绝不抛错。

    逐变量 try/except：dict 子类的 __contains__/get、变量的 __str__ 抛错都只影响
    当前占位符，不影响整条文案。
    """
    if not isinstance(text, str):
        return ""

    def replace(match):
        try:
            name = match.group(1)
            if not isinstance(variables, dict) or name not in variables:
                return match.group(0)
            return _stringify(variables.get(name), match.group(0))
        except Exception:  # noqa: BLE001 —— 单个变量异常保留占位符
            return match.group(0)

    return _PLACEHOLDER.sub(replace, text)


def _to_plural_number(value):
    """复数 n 归一（与 Node `_toPluralNumber` 同一口径）。

    number 原样；string 去首尾空白后按十进制解析；其余类型（布尔/数组/对象/None）
    一律返回 None（非法 → other）。np.nan/±inf 也走「不等于 1」→ other。
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            return float(value)
        except (OverflowError, ValueError):
            return None
    if isinstance(value, str):
        text = value.strip()
        if not text or not _DECIMAL_RE.fullmatch(text):
            return None
        try:
            return float(text)
        except (TypeError, ValueError, OverflowError):
            return None
    return None


def _plural_text(entry, variables):
    """从复数词条取文案：n 恰好等于 1 取 one，否则 other（含非法/缺失）；
    首选缺失回退另一档，两档都不是字符串返回 None（由调用方回落中文 key）。"""
    raw_n = variables.get("n") if isinstance(variables, dict) else None
    n = _to_plural_number(raw_n)
    one = n == 1
    primary = entry.get("one") if one else entry.get("other")
    fallback = entry.get("other") if one else entry.get("one")
    if isinstance(primary, str):
        return primary
    if isinstance(fallback, str):
        return fallback
    return None


def _entry(ns, key):
    """从缓存词典取词条：ns 或 key 缺失/形状非法时返回 None。"""
    table = load_dict()
    if not isinstance(table, dict):
        return None
    try:
        bucket = table.get(ns)
    except TypeError:  # 不可哈希的 ns
        return None
    if not isinstance(bucket, dict):
        return None
    try:
        return bucket.get(key)
    except TypeError:  # 不可哈希的 key
        return None


def _first_value(value):
    """列表/元组取首项（parse_qs、重复头等形态），其余原样返回。"""
    if isinstance(value, (list, tuple)):
        return value[0] if value else None
    return value


def _header_value(headers, name):
    """取头值：headers 可为 dict / email.message.Message / 任何带 items() 或 get() 的对象；
    键名大小写不敏感，重复头取第一个。"""
    if headers is None:
        return None
    lowered = name.lower()
    try:
        items = headers.items()
    except Exception:  # noqa: BLE001 —— 非映射形态，退回 get()
        items = None
    if items is not None:
        try:
            for key, value in items:
                if isinstance(key, str) and key.lower() == lowered:
                    return _first_value(value)
        except Exception:  # noqa: BLE001 —— items() 迭代异常，退回 get()
            pass
    getter = getattr(headers, "get", None)
    if callable(getter):
        try:
            value = getter(name)
        except Exception:  # noqa: BLE001
            value = None
        if value is not None:
            return _first_value(value)
    return None


def _query_value(query):
    """取查询参数 lang：接受字符串（lang=en / ?lang=en）、dict（含 parse_qs 的列表值）
    或带 get() 的映射对象。"""
    if query is None:
        return None
    if isinstance(query, str):
        raw = query[1:] if query.startswith("?") else query
        try:
            pairs = parse_qsl(raw, keep_blank_values=True)
        except Exception:  # noqa: BLE001
            return None
        for key, value in pairs:
            if key == "lang":
                return value
        return None
    getter = getattr(query, "get", None)
    if callable(getter):
        try:
            value = getter("lang")
        except Exception:  # noqa: BLE001
            value = None
        if value is not None:
            return _first_value(value)
    try:
        items = query.items()
    except Exception:  # noqa: BLE001
        return None
    try:
        for key, value in items:
            if key == "lang":
                return _first_value(value)
    except Exception:  # noqa: BLE001
        return None
    return None


def _coerce_lang(value):
    """把候选值归一为语言：支持列表（取首项）、{v: "en"}（账号偏好持久化形状）与裸字符串。"""
    candidate = _first_value(value)
    if isinstance(candidate, dict):
        candidate = candidate.get("v")
    return normalize_lang(candidate)


def is_i18n_disabled():
    """回滚开关的只读视图（供「先判开关、再决定是否读库」的调用方使用）。

    与 Node `isI18nDisabled()` 逐字对应：`TS_I18N=0` 时调用方应跳过用户偏好查询，
    连偏好都不读（见 `server.Handler._request_lang` 的读库顺序）。
    """
    return _is_disabled()


def resolve_lang_signal(headers=None, query=None):
    """解析**显式**语言信号：`X-TS-Lang` 头 → `?lang=`；两档都没有合法值时返回 None。

    为什么要与 `resolve_lang` 拆开（T10 审查 Minor 3 的 Python 镜像）：调用方只有在
    头和 query 都缺席时才需要读库里的用户偏好。`resolve_lang` 无法表达「没信号」
    （它把缺省折叠成 "zh"，与显式 zh 不可区分），所以单独暴露本函数。
    `TS_I18N=0` 时返回 None（回滚开关下连偏好都不读）。

    非法值跳过并继续下一档；任何畸形入参都回落 None（绝不抛错）。
    """
    if _is_disabled():
        return None
    try:
        for raw in (_header_value(headers, "X-TS-Lang"), _query_value(query)):
            lang = _coerce_lang(raw)
            if lang is not None:
                return lang
    except Exception:  # noqa: BLE001 —— 任何畸形入参都按「无显式信号」处理
        pass
    return None


def resolve_lang(headers=None, query=None, user_pref=None):
    """解析请求语言：X-TS-Lang 头 → ?lang= → user_pref → "zh"。

    非法值跳过并继续下一档；TS_I18N=0 时直接返回 "zh"；任何畸形入参都回落 "zh"。
    """
    if _is_disabled():
        return "zh"
    signal = resolve_lang_signal(headers, query)
    if signal is not None:
        return signal
    try:
        pref = _coerce_lang(user_pref)
        if pref is not None:
            return pref
    except Exception:  # noqa: BLE001 —— 偏好 getter 抛错等：按缺省中文处理
        pass
    return "zh"


def _row_lang(row):
    """从任务/卡片行取 `lang` 原始值：dict 与 sqlite3.Row 都兼容，缺失/非字符串 → ""。

    不能直接 `row["lang"]` 的两种情况：dict 缺键抛 KeyError、sqlite3.Row 缺列抛
    IndexError（旧库/测试替身）。两者都按「没有语言」处理（读侧归一 zh）。
    """
    if row is None:
        return ""
    try:
        value = row["lang"]
    except (KeyError, IndexError, TypeError):
        return ""
    return value if isinstance(value, str) else ""


def task_lang(task):
    """任务语言（读侧规范化）：仅当 `lang` 去空白小写后恰好是 `en` 时返回 en，
    其余（`zh`/空串/缺失/未知值如 `en-US`）一律 `zh`。

    与 `backend/lib/i18n.js:taskLang` 逐字对应——**payload / prompts / runner 继承
    共用这一处口径**，不要在调用点各写一份判断。
    """
    return "en" if _row_lang(task).strip().lower() == "en" else "zh"


def card_lang(card):
    """看板卡语言（读侧规范化）：语义与 `task_lang` 完全一致（同一 `lang` 列口径）。"""
    return "en" if _row_lang(card).strip().lower() == "en" else "zh"


def message_vars(message, vars=None):
    """「词条 key + vars」的普通返回值载体（T10 R18 裁决的 Python 镜像）。

    用途：`backend_py/*` 里有些用户可见错误不是抛异常而是**返回字符串**（如
    `answer_interaction` 的 `str|None`、`(ok, err)` 二元组）。带插值的文案不能先
    渲染再交给 `_error*`（渲染后的 key 查不到词条），所以用本函数返回
    `{"message": key, "vars": {...}|None}`：
      - `message` 是中文词条 key（可含 `{name}` 占位符，**不预渲染**）；
      - `vars` 是插值变量（无变量为 None）。
    路由层把该对象原样交给 `self._error(status, value)` / `self._error_spaced(...)`
    即可按请求语言渲染；中文侧插值结果与旧文案逐字节相同。固定文案不需要它
    （字符串本身就是词条 key），保持原有字符串返回形态即可。

    :param message: 中文词条 key（`{name}` 占位符原样保留）
    :param vars: 插值变量（None=无变量）
    :returns: {"message": str, "vars": dict|None}
    """
    return {"message": message, "vars": None if vars is None else vars}


def localizable(error, message, vars=None):
    """给**抛出的错误对象**附加本地化载荷（key+vars 契约的错误侧）。

    与 `message_vars` 的区别：抛错路径的 `.message`/`str(e)` 已被日志/`last_error`
    等既有消费方使用，不能改成未渲染的 `{占位符}` key，否则日志口径会漂移。故本函数
    只附加两个属性：
      - `error.i18n_key`：中文词条 key（可含 `{name}`）；
      - `error.i18n_vars`：插值变量（无变量为 None）。
    `_error*` 收到该异常对象时按 `i18n_key` 本地化；不经过响应层的日志仍用渲染后的
    中文 `.message`，保持原样。固定文案的错误（`.message` 本身就是词条 key）无需调用
    本函数。

    :param error: 异常对象（原样返回，便于 `raise localizable(RuntimeError(...), ...)`）
    :param message: 中文词条 key
    :param vars: 插值变量（None=无变量）
    :returns: error
    """
    try:
        setattr(error, "i18n_key", message)
        setattr(error, "i18n_vars", None if vars is None else vars)
    except Exception:  # noqa: BLE001 —— 附加失败不影响原异常向上抛
        pass
    return error


def detail_text(error, lang="zh"):
    """嵌套错误 detail 的渲染（KB-01 可翻子集）：内层带 `i18n_key` 时按语言渲染。

    外层固定键（`agent 调用失败: {detail}` 等）的 detail 往往来自 `DshDriverError`：
    它自带 `i18n_key`/`i18n_vars`（如驱动 HTTP 错误的 `{driver_detail}`）。本函数是这类
    「嵌套 detail」的唯一渲染口：
      - **zh**（以及任何非法语言）返回 `str(error)`，即旧 `str(e)` 口径——响应字节不变；
      - **en** 且 `error.i18n_key` 是字符串时，按同一 key+vars 渲染英文；无 key 的动态
        异常（OSError/sqlite/网络错误/第三方正文）保持原文（KB-37 口径：不猜译诊断）；
      - 渲染失败/异常对象怪异一律回落 `str(error)`，绝不抛错。

    与 `localizable` / `message_vars` 的分工：那两个负责把「外层固定键 + vars」交给响应层，
    本函数只负责把 **vars 里的内层 detail** 先按请求语言渲染好（响应层不递归）。

    :param error: 内层异常对象（通常 DshDriverError；也接受任意值）
    :param lang: 语言（缺省 "zh"；接受大小写/地区变体）
    :returns: str
    """
    try:
        key = getattr(error, "i18n_key", None)
        if isinstance(key, str) and normalize_lang(lang) == "en":
            return t("api", key, lang, **(getattr(error, "i18n_vars", None) or {}))
    except Exception:  # noqa: BLE001 —— 嵌套 detail 渲染失败必须回落原样
        pass
    try:
        return str(error)
    except Exception:  # noqa: BLE001
        return ""


def t(ns, key, lang="zh", **vars):
    """取文案：zh（或任何非法/缺省语言）返回插值后的中文 key；en 查 dict[ns][key]，
    缺失/类型非法回落插值后的中文 key。TS_I18N=0 恒中文。本函数永不抛错。

    :param ns: 命名空间（web/api/prompt）
    :param key: 中文原文（即词典 key）
    :param lang: 语言（缺省 "zh"；接受大小写/地区变体）
    :param vars: 插值变量（如 n=2, name="Ada"）
    :returns: str
    """
    try:
        text = key if isinstance(key, str) else str(key)
    except Exception:  # noqa: BLE001
        text = ""
    try:
        if _is_disabled() or normalize_lang(lang) != "en":
            return _interpolate(text, vars)
        entry = _entry(ns, text)
        if isinstance(entry, str):
            return _interpolate(entry, vars)
        if isinstance(entry, dict):
            plural = _plural_text(entry, vars)
            if isinstance(plural, str):
                return _interpolate(plural, vars)
    except Exception:  # noqa: BLE001 —— 词典/插值出现任何意外都回落到中文 key
        pass
    try:
        return _interpolate(text, vars)
    except Exception:  # noqa: BLE001 —— 后端错误路径不能因 i18n 再抛错
        return ""
