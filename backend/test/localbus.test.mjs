/**
 * backend/lib/localbus.js 的测试（node --test，零依赖，不碰 DB/HTTP）。
 *
 * 覆盖三条不变量 + 主题构造/诊断口：
 *   ① 序号单调（多次发布后仍按值判断，漏唤醒只晚一拍不丢）；
 *   ② `wait` 语义：落后立即返回 / 超时返回当前序号（等于 since）/ 被 publish 唤醒；
 *   ③ `publish` 绝不抛（坏 topic 也只吞掉这一次通知）；
 *   ④ topic 隔离、`boardTopic`/`sessionTopic` 归一、`stats()` 形状与 waiters 计数、
 *      模块级单例 `BUS`/`publish`/`seq`/`wait`。
 *
 * 形态差异断言（Node vs Python）：`wait` 返回 Promise<number>；只唤醒该 topic 的等待者
 * （Python 的 notify_all 会提前唤醒其他 topic 的等待者，但返回值不变、调用方按值判断）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  boardTopic, BUS, ChangeBus, publish, seq, sessionTopic, topicKey, wait,
} from '../lib/localbus.js';

/** 断言一个 Promise 在 `ms` 内仍处于 pending（用来证明「没被唤醒/没超时」） */
async function stillPending(promise, ms = 50) {
  const sentinel = new Promise((resolve) => { setTimeout(() => resolve('pending'), ms); });
  const winner = await Promise.race([promise.then(() => 'settled'), sentinel]);
  return winner === 'pending';
}

test('seq：未发布为 0，publish 单调递增（每 topic 独立计数）', () => {
  const bus = new ChangeBus();
  const topic = boardTopic(7);
  assert.equal(bus.seq(topic), 0);
  bus.publish(topic);
  bus.publish(topic);
  assert.equal(bus.seq(topic), 2);
  assert.equal(bus.seq(boardTopic(8)), 0, '另一个项目不受影响');
});

test('wait：超时返回当前序号（等于 since），调用方据此发 keepalive', async () => {
  const bus = new ChangeBus();
  const topic = boardTopic(7);
  const started = Date.now();
  assert.equal(await bus.wait(topic, 0, 40), 0);
  assert.ok(Date.now() - started >= 30, '真的等了窗口，不是立即返回');
});

test('wait：已落后时立即返回当前值（不等待、不注册等待者）', async () => {
  const bus = new ChangeBus();
  const topic = boardTopic(7);
  bus.publish(topic);
  bus.publish(topic);
  const started = Date.now();
  assert.equal(await bus.wait(topic, 0, 5000), 2);
  assert.equal(await bus.wait(topic, 1, 5000), 2, '落后即落后（值 > since）');
  assert.ok(Date.now() - started < 200, '落后分支不等待');
  assert.equal(bus.stats().waiters, 0);
});

test('wait：被 publish 唤醒（不是轮询），返回新序号', async () => {
  const bus = new ChangeBus();
  const topic = boardTopic(7);
  const pending = bus.wait(topic, 0, 5000);
  assert.equal(bus.stats().waiters, 1, '等待者已登记');
  setTimeout(() => bus.publish(topic), 20);
  const started = Date.now();
  assert.equal(await pending, 1);
  assert.ok(Date.now() - started < 1000, '事件到达即唤醒');
  assert.equal(bus.stats().waiters, 0, '结算后登记清零');
});

test('wait：多个订阅者被同一次 publish 全部唤醒', async () => {
  const bus = new ChangeBus();
  const topic = sessionTopic('session-a');
  const a = bus.wait(topic, 0, 5000);
  const b = bus.wait(topic, 0, 5000);
  const c = bus.wait(topic, 0, 5000);
  assert.equal(bus.stats().waiters, 3);
  bus.publish(topic);
  assert.deepEqual(await Promise.all([a, b, c]), [1, 1, 1]);
  assert.equal(bus.stats().waiters, 0);
});

test('wait：别的 topic 发布不唤醒（不被误唤醒；超时后仍返回自己的序号）', async () => {
  const bus = new ChangeBus();
  const mine = boardTopic(1);
  const other = boardTopic(2);
  const pending = bus.wait(mine, 0, 120);
  bus.publish(other);
  assert.equal(await stillPending(pending, 40), true, 'topic 隔离：不提前唤醒');
  assert.equal(await pending, 0, '超时返回自己的当前序号（值未变）');
  assert.equal(bus.seq(other), 1);
});

test('wait：省略 timeout 即无限等待，只可能被 publish 唤醒', async () => {
  const bus = new ChangeBus();
  const topic = boardTopic(3);
  const pending = bus.wait(topic, 0);
  assert.equal(await stillPending(pending, 60), true, '没有超时定时器在跑');
  bus.publish(topic);
  assert.equal(await pending, 1);
});

test('序号只晚一拍不丢：多次发布会合到当前值（调用方按值判断）', async () => {
  const bus = new ChangeBus();
  const topic = boardTopic(4);
  bus.publish(topic);
  bus.publish(topic);
  bus.publish(topic);
  // 订阅者上次看到 0 ⇒ 本次拿到 3（不是 1）；再 wait(3) 才会等下一次变化
  assert.equal(await bus.wait(topic, 0, 20), 3);
  assert.equal(await bus.wait(topic, 3, 30), 3, '没有新变化 ⇒ 超时返回 3');
});

test('publish 绝不抛：坏 topic（循环引用）只吞掉这一次通知', () => {
  const bus = new ChangeBus();
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => bus.publish(circular));
  assert.equal(bus.stats().topics, 0, '坏 topic 不留下任何状态');
  assert.doesNotThrow(() => bus.publish(undefined));
  assert.doesNotThrow(() => bus.publish(boardTopic(1)));
  assert.equal(bus.seq(boardTopic(1)), 1, '坏发布不影响后续正常发布');
});

test('topic 构造：boardTopic 归一到 int，sessionTopic 归一到字符串；topicKey 稳定', () => {
  assert.deepEqual(boardTopic('9'), ['board', 9]);
  assert.deepEqual(boardTopic(9), ['board', 9]);
  assert.deepEqual(sessionTopic('session-a'), ['session', 'session-a']);
  assert.deepEqual(sessionTopic(123), ['session', '123']);
  assert.equal(topicKey(boardTopic(9)), topicKey(['board', 9]), '同 topic 同键');
  assert.notEqual(topicKey(boardTopic(9)), topicKey(boardTopic(10)));
  // 数组 topic 与字符串 topic 不撞键（JSON 文本不会互相同形）
  assert.notEqual(topicKey(['board', 9]), topicKey('board'));
  const bus = new ChangeBus();
  bus.publish(boardTopic('9'));
  assert.equal(bus.seq(['board', 9]), 1, '"9" 与 9 是同一 topic（对齐 Python int() 归一）');
  assert.equal(bus.seq(['board', '9']), 0, '字符串元素不算同一 topic');
});

test('stats：topics/waiters/seq 三项，seq 键为 topicKey 口径', async () => {
  const bus = new ChangeBus();
  assert.deepEqual(bus.stats(), { topics: 0, waiters: 0, seq: {} });
  bus.publish(boardTopic(1));
  bus.publish(sessionTopic('s1'));
  bus.publish(sessionTopic('s1'));
  const stats = bus.stats();
  assert.equal(stats.topics, 2);
  assert.equal(stats.waiters, 0);
  assert.equal(stats.seq[topicKey(boardTopic(1))], 1);
  assert.equal(stats.seq[topicKey(sessionTopic('s1'))], 2);
});

test('模块级单例：BUS/publish/seq/wait 共用同一张表', async () => {
  const topic = boardTopic(88);
  const base = seq(topic);
  publish(topic);
  assert.equal(seq(topic), base + 1);
  assert.equal(BUS.seq(topic), base + 1, '模块级 publish 落在 BUS 上');
  const pending = wait(topic, base + 1, 2000);
  assert.equal(await stillPending(pending, 30), true);
  BUS.publish(topic);
  assert.equal(await pending, base + 2, '模块级 wait 由 BUS.publish 唤醒');
});
