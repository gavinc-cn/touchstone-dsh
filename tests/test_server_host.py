#!/usr/bin/env python3
"""server.py 启动参数默认值测试：默认监听回环 127.0.0.1，0.0.0.0 须显式指定。

背景（2026-09-27 批次）：默认监听从 0.0.0.0 收敛为 127.0.0.1（安全默认，防局域网
意外暴露），需要对外提供服务时经 --host 0.0.0.0（或启动器 TS_HOST 环境变量）显式
指定。argparse 构造抽为模块级 _build_arg_parser() 以便进程内断言（不必真起实例）。

运行: python -m pytest tests/test_server_host.py -v
"""


def test_default_host_loopback():
    """默认监听 127.0.0.1：仅本机可访问，对外监听必须显式指定。"""
    import server
    assert server._build_arg_parser().get_default("host") == "127.0.0.1"


def test_default_port_unchanged():
    """端口默认 4601 不变（回归保护）。"""
    import server
    assert server._build_arg_parser().get_default("port") == 4601
