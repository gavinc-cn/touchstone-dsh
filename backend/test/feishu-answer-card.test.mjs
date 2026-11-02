/**
 * 作答后置灰（2026-10-30）单测：`feishu.js` 新加的登记表 + 卡片变换 + 关闭补丁。
 *
 * 被测面（纯函数为主，零网络）：
 *   - `answeredCard(card, {name, lang, statusText, kind})`：2.0 卡 → 置灰卡（深拷贝、
 *     header 换绿、body 顶部插状态行、所有交互组件 `disabled: true`）；
 *   - `rememberInteractionCard` / `interactionCardEntry` / `answeredCardResponse`：
 *     登记键（提问用 qid、审批用 approval_id）与查不到时的 no-op；
 *   - `interactionClosed`：按 message_id 调 `PATCH /open-apis/im/v1/messages/:id`，
 *     成功后幂等（第二次不再打）、失败不置 answered（留给回调路径/下次兜底）。
 *
 * 外部依赖全部注入（`options.rest`），**零真实网络**；判据只看「发出去了什么」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as feishu from '../lib/feishu.js';

// --------------------------------------------------------------------------
// 夹具
// --------------------------------------------------------------------------

/** 一条覆盖四类交互组件的 2.0 卡（根级 select / 多选 mini 表单 / 输入 mini 表单 / 按钮） */
function sampleCard() {
  return {
    schema: '2.0',
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: '🤔 卡片等待回复 [演示项目]' },
    },
    body: {
      elements: [
        { tag: 'markdown', content: '**agent 提问**：用哪个方案？' },
        {
          tag: 'select_static',
          name: 'mq7_1',
          options: [{ text: { tag: 'plain_text', content: '甲' }, value: '1' }],
          behaviors: [{ type: 'callback', value: { t: 'mq', c: 7, n: 1 } }],
        },
        {
          tag: 'form',
          name: 'mqf7_2',
          elements: [
            { tag: 'multi_select_static', name: 'mq7_2', options: [] },
            {
              tag: 'button',
              name: 'mqs7_2',
              form_action_type: 'submit',
              text: { tag: 'plain_text', content: '提交第 2 题' },
            },
          ],
        },
        {
          tag: 'form',
          name: 'aof7_2',
          elements: [
            { tag: 'input', name: 'ao7_2', max_length: 1000 },
            {
              tag: 'button',
              name: 'aos7_2',
              form_action_type: 'submit',
              text: { tag: 'plain_text', content: '提交自定义回答' },
            },
          ],
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '1) 甲' },
          behaviors: [{ type: 'callback', value: { t: 'a', c: 7, i: 1 } }],
        },
      ],
    },
  };
}

/** 递归收集所有交互组件（判 disable 用） */
function interactiveEls(elements, acc = []) {
  for (const el of elements || []) {
    if (el === null || typeof el !== 'object') continue;
    if (['button', 'select_static', 'multi_select_static', 'input'].includes(el.tag)) acc.push(el);
    if (Array.isArray(el.elements)) interactiveEls(el.elements, acc);
  }
  return acc;
}

/** 假 REST：记 (method, path, body, cfg)，可注入失败 */
function fakeRest(over = {}) {
  const calls = [];
  return {
    calls,
    async rest(method, path, opts = {}) {
      calls.push([method, path, opts.jsonBody, opts.cfg]);
      if (typeof over.fail === 'function') await over.fail(calls.length);
      return {};
    },
  };
}

/** 一个已发卡登记的夹具（调用方负责在用例开头 `resetInteractionCards`） */
function remembered(over = {}) {
  const card = over.card || sampleCard();
  feishu.rememberInteractionCard({
    cardId: over.cardId === undefined ? 7 : over.cardId,
    qid: over.qid === undefined ? 'call-1' : over.qid,
    approvalId: over.approvalId,
    messageId: over.messageId === undefined ? 'om_9' : over.messageId,
    card,
    name: over.name === undefined ? '演示项目' : over.name,
    openId: 'ou_a',
    userId: 1,
    cfg: over.cfg || { app_id: 'cli_x', app_secret: 'sec_x' },
    lang: over.lang === undefined ? 'zh' : over.lang,
  });
  return card;
}

const tick = () => new Promise((r) => setImmediate(r));

// --------------------------------------------------------------------------
// ① 卡片变换（纯函数）
// --------------------------------------------------------------------------

test('answeredCard：header 换绿/标题改写/顶部状态行/四类交互组件全 disabled，原卡不动', () => {
  const card = sampleCard();
  const out = feishu.answeredCard(card, {
    name: '演示项目', lang: 'zh', statusText: '✅ 已作答', kind: 'question',
  });
  assert.notEqual(out, card, '必须是深拷贝（原卡要留给登记表/回调路径复用）');
  assert.equal(out.schema, '2.0');                       // 2.0 → 2.0（飞书硬约束）
  assert.equal(out.header.template, 'green');
  assert.equal(out.header.title.content, '✅ 卡片已作答 [演示项目]');
  assert.deepEqual(out.config, { update_multi: true });   // PATCH 前置
  assert.equal(out.body.elements[0].tag, 'markdown');
  assert.equal(out.body.elements[0].content, '✅ 已作答');
  const interactive = interactiveEls(out.body.elements);
  assert.equal(interactive.length, 6, '按钮 3 + 下拉 2 + 输入 1 全在');
  for (const el of interactive) assert.equal(el.disabled, true, `${el.tag} 应 disabled`);
  // 非交互内容原样保留（题面/选项/方案摘要都还看得见）
  assert.equal(out.body.elements[1].content, '**agent 提问**：用哪个方案？');
  // 原卡零副作用（disabled 不能漏回原对象）
  assert.equal(interactiveEls(card.body.elements).some((el) => 'disabled' in el), false);
  assert.equal(card.header.template, 'orange');
});

test('answeredCard：审批卡用「已处理」文案；英文走 i18n 词条', () => {
  const approval = feishu.answeredCard(sampleCard(), {
    name: 'P', lang: 'zh', statusText: '✅ 审批已处理', kind: 'approval',
  });
  assert.equal(approval.header.title.content, '✅ 卡片已处理 [P]');
  const en = feishu.answeredCard(sampleCard(), {
    name: 'Demo', lang: 'en', statusText: '✅ Answered', kind: 'question',
  });
  assert.equal(en.header.title.content, '✅ Card answered [Demo]');
  assert.equal(feishu.answeredStatusText('question', 'en'), '✅ Answered');
  assert.equal(feishu.answeredStatusText('approval', 'en'), '✅ Approval handled');
  assert.equal(feishu.answeredStatusText('question', 'zh'), '✅ 已作答');
  assert.equal(feishu.answeredStatusText('approval', 'zh'), '✅ 审批已处理');
});

// --------------------------------------------------------------------------
// ② 登记表（提问 qid / 审批 approval_id 两把键）
// --------------------------------------------------------------------------

test('登记表：无 message_id 不登记；提问按 qid、审批按 approval_id 命中；reset 清空', () => {
  feishu.resetInteractionCards();
  feishu.rememberInteractionCard({
    cardId: 1, qid: 'q1', messageId: '', card: sampleCard(), name: 'P',
    openId: 'ou', userId: 1, cfg: {}, lang: 'zh',
  });
  assert.equal(feishu.interactionCardEntry(1, { qid: 'q1' }), null, '拿不到 message_id 就不登记');

  remembered({ cardId: 2, qid: 'q1' });
  assert.ok(feishu.interactionCardEntry(2, { qid: 'q1' }));
  assert.equal(feishu.interactionCardEntry(2, { qid: 'q2' }), null, 'qid 不同不命中');
  assert.equal(feishu.interactionCardEntry(3, { qid: 'q1' }), null, '卡号不同不命中');

  remembered({ cardId: 4, qid: null, approvalId: 'ap-1' });
  assert.ok(feishu.interactionCardEntry(4, { qid: null, approval_id: 'ap-1' }));
  assert.equal(feishu.interactionCardEntry(4, { qid: null, approval_id: 'ap-2' }), null);

  // 重复登记同一键 ⇒ 覆盖（LRU 里只保留一份）
  remembered({ cardId: 5, qid: 'q1', messageId: 'om_old' });
  remembered({ cardId: 5, qid: 'q1', messageId: 'om_new' });
  assert.equal(feishu.interactionCardEntry(5, { qid: 'q1' }).messageId, 'om_new');
  assert.equal(feishu.interactionCards().size, 3);

  feishu.resetInteractionCards();
  assert.equal(feishu.interactionCards().size, 0);
});

test('answeredCardResponse：命中 ⇒ {type:raw,data:置灰卡}；未登记 ⇒ null', () => {
  feishu.resetInteractionCards();
  remembered({ cardId: 6, qid: 'q1' });
  const resp = feishu.answeredCardResponse(6, { qid: 'q1' });
  assert.equal(resp.type, 'raw');
  assert.equal(resp.data.header.template, 'green');
  assert.equal(resp.data.body.elements[0].content, '✅ 已作答');
  assert.equal(feishu.answeredCardResponse(6, { qid: 'nope' }), null);
  feishu.resetInteractionCards();
});

// --------------------------------------------------------------------------
// ③ 关闭补丁（站点/DSH 作答通道）
// --------------------------------------------------------------------------

test('interactionClosed：PATCH 置灰一次；重复调用幂等；未登记 ⇒ 不打请求', async () => {
  feishu.resetInteractionCards();
  remembered({ cardId: 11, qid: 'call-1' });
  const rest = fakeRest();
  feishu.interactionClosed(11, { qid: 'call-1' }, { rest });
  await tick();
  assert.equal(rest.calls.length, 1);
  const [method, path, body, cfg] = rest.calls[0];
  assert.equal(method, 'PATCH');
  assert.equal(path, '/open-apis/im/v1/messages/om_9');
  const card = JSON.parse(body.content);
  assert.equal(card.header.template, 'green');
  assert.equal(card.body.elements[0].content, '✅ 已作答');
  assert.equal(interactiveEls(card.body.elements).every((el) => el.disabled === true), true);
  assert.deepEqual(cfg, { app_id: 'cli_x', app_secret: 'sec_x' });

  feishu.interactionClosed(11, { qid: 'call-1' }, { rest });
  await tick();
  assert.equal(rest.calls.length, 1, '已置灰 ⇒ 第二次是 no-op');

  feishu.interactionClosed(12, { qid: 'call-1' }, { rest });
  await tick();
  assert.equal(rest.calls.length, 1, '未登记的卡不打扰飞书');

  feishu.resetInteractionCards();
});

test('interactionClosed：审批卡按 approval_id 键 + 文案「审批已处理」', async () => {
  feishu.resetInteractionCards();
  remembered({ cardId: 13, qid: null, approvalId: 'ap-9' });
  const rest = fakeRest();
  feishu.interactionClosed(13, { approval_id: 'ap-9' }, { rest });
  await tick();
  assert.equal(rest.calls.length, 1);
  const card = JSON.parse(rest.calls[0][2].content);
  assert.equal(card.header.title.content, '✅ 卡片已处理 [演示项目]');
  assert.equal(card.body.elements[0].content, '✅ 审批已处理');
  feishu.resetInteractionCards();
});

test('interactionClosed：PATCH 失败 ⇒ 只留痕不外抛，且不标 answered（下次还能补）', async () => {
  feishu.resetInteractionCards();
  remembered({ cardId: 14, qid: 'q-fail' });
  const logs = [];
  let fail = true;
  const rest = fakeRest({
    fail: async () => { if (fail) throw new Error('boom'); },
  });
  feishu.interactionClosed(14, { qid: 'q-fail' }, { rest, log: (l) => logs.push(l) });
  await tick();
  assert.equal(rest.calls.length, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /作答.*置灰失败.*boom/);
  assert.equal(feishu.interactionCardEntry(14, { qid: 'q-fail' }).answered, false);
  fail = false;
  feishu.interactionClosed(14, { qid: 'q-fail' }, { rest, log: (l) => logs.push(l) });
  await tick();
  assert.equal(rest.calls.length, 2, '失败后重试仍会打补丁');
  assert.equal(feishu.interactionCardEntry(14, { qid: 'q-fail' }).answered, true);
  feishu.resetInteractionCards();
});
