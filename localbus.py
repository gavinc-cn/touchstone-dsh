#!/usr/bin/env python3
"""进程内变更总线（路线 A P4：把「服务端改了什么」变成推给前端的信号）。

用途：看板前端原先每 5s 拉一次全量 board payload；事件化后由本总线唤醒——
写路径（卡片增删改列、行收口）与 dsh 状态帧（会话忙闲/交互变化会带动卡片列流转）
各发一次「值得重取」信号，前端在事件到达时才重取，静置期零请求。

设计要点：

- **只发信号不带载荷**：topic 是 `("board", project_id)`，载荷恒空。携带差异
  载荷需要维护增量协议与丢失补发，而看板 payload 本身很小——「信号 + 客户端
  重取」是最简且不会错的形态（HTTP 语义天然幂等）。
- **单调序号 + 条件变量**：订阅者（SSE handler）记住自己上次看到的 seq，
  `wait(topic, since, timeout)` 等到变化或超时（超时用于发 keepalive）。
  序号单调 ⇒ 漏唤醒只会晚一拍，不会永久丢失。
- **发布 O(1) 且不抛**：发布点散布在 DB 写路径与 dsh 消费线程里，任何异常都
  必须被吞掉（通知失败绝不能影响业务写）。
"""

import threading


class ChangeBus:
    """按 topic 计数的进程内变更总线（topic 为可哈希元组）。"""

    def __init__(self):
        self._cond = threading.Condition()
        self._seq = {}                       # topic -> 单调序号（从 1 开始）
        self._waiters = 0                    # 诊断：当前等待者数

    def publish(self, topic):
        """发布一次变更：序号 +1 并唤醒所有等待者（O(1)、不抛）。"""
        try:
            with self._cond:
                self._seq[topic] = self._seq.get(topic, 0) + 1
                self._cond.notify_all()
        except Exception:                    # noqa: BLE001 — 通知失败不影响业务
            pass

    def seq(self, topic):
        """当前序号（订阅者用它做「从这里之后的变化」的基准）。"""
        with self._cond:
            return self._seq.get(topic, 0)

    def wait(self, topic, since, timeout):
        """等到 `seq(topic) != since` 或超时；返回当前 seq。

        调用方拿返回值与 `since` 比较即可判断「有无变化」（超时时相等）。
        """
        with self._cond:
            current = self._seq.get(topic, 0)
            if current != since:
                return current
            self._waiters += 1
            try:
                self._cond.wait(timeout)
            finally:
                self._waiters -= 1
            return self._seq.get(topic, 0)

    def stats(self):
        """诊断（/api 健康、测试断言用）。"""
        with self._cond:
            return {"topics": len(self._seq), "waiters": self._waiters,
                    "seq": dict(self._seq)}


# 模块级单例：进程内唯一总线（server 与 db 共用）
BUS = ChangeBus()


def publish(topic):
    BUS.publish(topic)


def seq(topic):
    return BUS.seq(topic)


def wait(topic, since, timeout):
    return BUS.wait(topic, since, timeout)


def board_topic(project_id):
    """看板 topic 构造（单一出口，防各处拼错）。"""
    return ("board", int(project_id))


def session_topic(session_id):
    """单会话 topic（会话窗口事件流用；sid 为字符串，逐字符可比）。"""
    return ("session", str(session_id))
