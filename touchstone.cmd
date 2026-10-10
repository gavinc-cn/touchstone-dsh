@echo off
rem Touchstone Windows 启停入口：转发到同目录 touchstone.py（start/stop/restart/status/build/test...）
rem
rem 解释器解析（2026-10-11）：优先 `python`，其次 `python3`，都没有就报明确的错。
rem 为什么不写死一个：官方 Windows 安装器只装 python.exe（没有 python3.exe），而少数发行版/Store
rem 别名形态又只有 python3；这里与插件薄壳（dsh-plugin/lib/index.js 的 PYTHON_CANDIDATES）同序，
rem 免得出现「面板里能跑、命令行跑不起来」两种口径。缺解释器时给出可执行的下一步，
rem 而不是让 cmd 抛「'python' 不是内部或外部命令」。
set "TS_PY="
where python >nul 2>nul && set "TS_PY=python"
if not defined TS_PY where python3 >nul 2>nul && set "TS_PY=python3"
if not defined TS_PY (
  echo 错误: 未找到 Python 解释器^(先试 python, 再试 python3^)。>&2
  echo 请安装 Python 3.12+ 并勾选 "Add python.exe to PATH"，或先设置 TS_PYTHON 指定解释器。>&2
  exit /b 1
)
"%TS_PY%" "%~dp0touchstone.py" %*
