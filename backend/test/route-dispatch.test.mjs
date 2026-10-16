/**
 * `backend/routes/index.js` 的**分派兜底**测试（M3，Lead 补）。
 *
 * 判据来源：Python 侧处理器抛异常时 `socketserver.handle_error` 只断这一条连接、服务继续；
 * Node 侧若不兜就是 `unhandledRejection` 杀进程（M3 实测踩中：一个 ReferenceError 让后端
 * 整个没了、后续请求全 connection refused）。这条差异是**可用性级**的，必须有守卫。
 *
 * 测法：`ROUTES` 是可变数组，往里面塞一条会抛的临时路由——不必真起 HTTP 服务就能钉住
 * 「异常被吞、连接被 destroy、进程不炸」这三件事。用完即 restore（`finally`）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dispatch, dispatchSafely, ROUTES } from '../routes/index.js';

/** 造一个最小 ctx（只需要分派用到的那几个字段与 res 桩） */
function fakeCtx(path, { destroyed = { value: false } } = {}) {
  return {
    req: { method: 'GET' },
    res: {
      destroy() { destroyed.value = true; },
    },
    path,
    destroyed,
  };
}

/** 临时压入一条路由并在退出时还原（保证用例之间互不影响） */
function withRoute(route, fn) {
  const index = ROUTES.length;
  ROUTES.push(route);
  try {
    return fn();
  } finally {
    ROUTES.splice(index, 1);
  }
}

test('dispatchSafely：处理器抛异常 ⇒ 吞掉、destroy 连接、返回 true（不冒泡杀进程）', async () => {
  const errors = [];
  await withRoute({
    method: 'GET',
    path: '/__test_throws__',
    handler: () => { throw new ReferenceError('pyIntStrict is not defined'); },
  }, async () => {
    const ctx = fakeCtx('/__test_throws__');
    let result;
    await assert.doesNotReject(async () => {                    // 关键：绝不能让拒绝冒泡
      result = await dispatchSafely(ctx, { logger: { error: (m) => errors.push(m) } });
    });
    assert.equal(result, true, '已接管这次请求（调用方不得再补 404/静态回退）');
    assert.equal(ctx.destroyed.value, true, '必须关掉这一条连接（Python 同语义）');
    assert.equal(errors.length, 1, '必须留痕一条日志，否则线上只看到「请求莫名失败」');
    assert.match(errors[0], /处理器异常/);
    assert.match(errors[0], /pyIntStrict/, '日志要带原始错误，便于定位');
  });
});

test('dispatchSafely：已响应后再写抛 ERR_HTTP_HEADERS_SENT 也走同一条兜底', async () => {
  const errors = [];
  await withRoute({
    method: 'GET',
    path: '/__test_headers_sent__',
    handler: () => {
      const e = new Error('Cannot set headers after they are sent to the client');
      e.code = 'ERR_HTTP_HEADERS_SENT';
      throw e;
    },
  }, async () => {
    const ctx = fakeCtx('/__test_headers_sent__');
    const result = await dispatchSafely(ctx, { logger: { error: (m) => errors.push(m) } });
    assert.equal(result, true);
    assert.equal(ctx.destroyed.value, true);
    assert.equal(errors.length, 1);
  });
});

test('dispatchSafely：正常命中/未命中语义与 dispatch 一致（兜底不改变分派结果）', async () => {
  await withRoute({
    method: 'GET',
    path: '/__test_ok__',
    handler: (ctx) => { ctx.hit = true; },
  }, async () => {
    const hit = fakeCtx('/__test_ok__');
    assert.equal(await dispatchSafely(hit), true);
    assert.equal(hit.hit, true);
    assert.equal(hit.destroyed.value, false, '正常路径不得 destroy');
    assert.equal(await dispatchSafely(fakeCtx('/__no_such_route__')), false, '未命中返回 false');
  });
});

test('dispatchSafely：res.destroy 自身抛异常也不得冒泡（连接可能已断）', async () => {
  const errors = [];
  await withRoute({
    method: 'GET',
    path: '/__test_destroy_throws__',
    handler: () => { throw new Error('boom'); },
  }, async () => {
    const ctx = {
      req: { method: 'GET' },
      res: { destroy() { throw new Error('socket already closed'); } },
      path: '/__test_destroy_throws__',
    };
    assert.equal(await dispatchSafely(ctx, { logger: { error: (m) => errors.push(m) } }), true);
    assert.equal(errors.length, 1);
  });
});

test('dispatch：裸分派仍会把异常抛给调用方（兜底只存在于 dispatchSafely，别误用）', async () => {
  await withRoute({
    method: 'GET',
    path: '/__test_raw__',
    handler: () => { throw new Error('raw'); },
  }, async () => {
    await assert.rejects(() => dispatch(fakeCtx('/__test_raw__')), /raw/);
  });
});
