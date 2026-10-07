@echo off
rem Touchstone Windows 启停入口：转发到同目录 touchstone.py（start/stop/restart/status/build）
python "%~dp0touchstone.py" %*
