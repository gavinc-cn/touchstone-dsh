/**
 * 飞书出站推送族单测（M7-R2）：`backend/lib/feishu.js`。
 *
 * ## 期望值来源（**不读 Node 实现反推**）
 *   ① **主判据是对拍**：`tools/parity/cases-mod/feishu_outbound.json` 的 72/72（本文件不重复它
 *      已驱动的分支，只补它**没驱动**的面）；
 *   ② 下面 `ORACLE` 表是**真 Python oracle 现算的字节**：一次性脚本 import 真 `feishu.py` +
 *      `db.py`（`TOUCHSTONE_DB` 指临时库，**不碰生产库**；跑前跑后核过生产库 md5 不变），
 *      对同一批输入 `json.dumps(..., ensure_ascii=False)` 落盘后逐条硬编码到这里；Node 侧用
 *      `pyJsonDumps` 生成同形文本，**逐字节相等**才过。覆盖：`_md_plain`/
 *      `_md_blocks`（含 1800 码点切块）、多子题视图/文本行/指令、单题多选 mini 表单、
 *      `_build_interaction_card` 五种形态、plan 族纯函数、`_render` 的四个边界分支。
 *      （生成脚本没入库——**可复现的主判据是对拍用例**，这张表是它的补充证据。）
 *   ③ `_send_one` 的**线上字节**（头序 + body）用原始 TCP 接收器抓真实请求后逐字节断言
 *      ——头序/大小写/值来自 oracle 实测（`doc_ai/plan/202610/20261014_1930_M7…` §1.4），
 *      不是「Node 习惯怎么发就怎么发」。
 *
 * ## 未覆盖（如实登记，别当已验）
 *   - plan 文档族里**要建文档的那一步**（`docxCreate` 的 REST 五步）与 DM 卡片发送：
 *     需要假上游（M7.3 的 `fake_feishu.mjs`），本文件只测到「接口不顺时响亮失败」那一层；
 *   - `_send_loop` 的 **1s 真节拍**与 `startNotifier` 起的线程只测幂等，不等节拍；
 *   - 3xx 重定向（本实现不跟随，见 `feishu.js` 文件头已知分歧）、`SEND_TIMEOUT` 超时分支。
 *
 * 夹具：`m3fixture.freshDb`（临时库；它会把 `process.env.TOUCHSTONE_DB` 指向自己，
 * 一切漏传 options 的调用也落不进生产库）。
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';

import * as db from '../lib/db.js';
import * as feishu from '../lib/feishu.js';
import * as feishuCfg from '../lib/feishu_cfg.js';
import { pyJsonDumps } from '../lib/pyjson.js';
import * as sessparse from '../lib/sessparse.js';
import { freshDb, insertProject } from './m3fixture.mjs';

/** 真 Python oracle 现算的字节（生成脚本见文件头②；键名与下面的用例一一对应） */
const ORACLE = {"md_plain": ["粗 与 斜 与 码 与 删", "abc", "**跨\n行**", "2  3  4", "| --- | --- |"], "md_blocks": "[{\"block_type\": 3, \"heading1\": {\"elements\": [{\"text_run\": {\"content\": \"一级标题\", \"text_element_style\": {\"bold\": true}}}], \"style\": {}}}, {\"block_type\": 4, \"heading2\": {\"elements\": [{\"text_run\": {\"content\": \"二级 加粗\", \"text_element_style\": {\"bold\": true}}}], \"style\": {}}}, {\"block_type\": 5, \"heading3\": {\"elements\": [{\"text_run\": {\"content\": \"三级\", \"text_element_style\": {\"bold\": true}}}], \"style\": {}}}, {\"block_type\": 2, \"text\": {\"elements\": [{\"text_run\": {\"content\": \"正文 粗 行\", \"text_element_style\": {\"bold\": false}}}], \"style\": {}}}, {\"block_type\": 15, \"quote\": {\"elements\": [{\"text_run\": {\"content\": \"引用行\", \"text_element_style\": {\"bold\": false}}}], \"style\": {}}}, {\"block_type\": 12, \"bullet\": {\"elements\": [{\"text_run\": {\"content\": \"项目甲\", \"text_element_style\": {\"bold\": false}}}], \"style\": {}}}, {\"block_type\": 12, \"bullet\": {\"elements\": [{\"text_run\": {\"content\": \"项目乙\", \"text_element_style\": {\"bold\": false}}}], \"style\": {}}}, {\"block_type\": 13, \"ordered\": {\"elements\": [{\"text_run\": {\"content\": \"有序一\", \"text_element_style\": {\"bold\": false}}}], \"style\": {}}}, {\"block_type\": 13, \"ordered\": {\"elements\": [{\"text_run\": {\"content\": \"有序二\", \"text_element_style\": {\"bold\": false}}}], \"style\": {}}}, {\"block_type\": 14, \"code\": {\"elements\": [{\"text_run\": {\"content\": \"code **不**处理\", \"text_element_style\": {\"bold\": false}}}], \"style\": {}}}, {\"block_type\": 2, \"text\": {\"elements\": [{\"text_run\": {\"content\": \"| a | b |\", \"text_element_style\": {\"bold\": false}}}], \"style\": {}}}, {\"block_type\": 22, \"divider\": {}}, {\"block_type\": 2, \"text\": {\"elements\": [{\"text_run\": {\"content\": \"尾行\", \"text_element_style\": {\"bold\": false}}}], \"style\": {}}}]", "question_views": "[{\"no\": 1, \"header\": \"甲题\", \"question\": \"甲？\", \"body\": \"补充甲\", \"options\": [{\"no\": 1, \"label\": \"a\", \"description\": \"\"}, {\"no\": 2, \"label\": \"b\", \"description\": \"描述乙\"}], \"multi_select\": true, \"allow_other\": true, \"other_label\": \"自定义\"}, {\"no\": 2, \"header\": \"\", \"question\": \"乙？\", \"body\": \"\", \"options\": [{\"no\": 1, \"label\": \"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc…\", \"description\": \"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd…\"}], \"multi_select\": false, \"allow_other\": false, \"other_label\": \"其他\"}]", "question_text_lines": "【1/2 甲题】甲？\n  补充甲\n  1) a\n  2) b\n     描述乙\n  （多选；可自定义：自定义）\n【2/2 第 2 题】乙？\n  1) cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc…\n     dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd…", "multi_answer_help": "该提问含 2 道子题：可在卡片上逐题点选（点满自动送达），或回复「作答 15 1:<选项序号> 2:<选项序号>」一次答全；多选写「1:2,3」，自定义写「1:文字」", "multi_click_hint": "逐题选择即可，答满 2 题自动送达 agent。\n第 1 题是多选：勾选后点「提交第 1 题」\n第 1、3 题请回复「作答 15 1:<值> 3:<值>」作答（自定义文字写 <文字>，可选项写序号，多选逗号分隔；已点选的题不用重复给）", "multi_click_hint_bare": "逐题选择即可，答满 1 题自动送达 agent。", "sms_form": "{\"tag\": \"form\", \"name\": \"mqf21_1\", \"elements\": [{\"tag\": \"multi_select_static\", \"name\": \"mq21_1\", \"placeholder\": {\"tag\": \"plain_text\", \"content\": \"请选择（可多选）\"}, \"options\": [{\"text\": {\"tag\": \"plain_text\", \"content\": \"甲\"}, \"value\": \"1\"}, {\"text\": {\"tag\": \"plain_text\", \"content\": \"乙\"}, \"value\": \"2\"}], \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"mq\", \"c\": 21, \"n\": 1}}]}, {\"tag\": \"button\", \"name\": \"mqs21_1\", \"form_action_type\": \"submit\", \"type\": \"primary\", \"text\": {\"tag\": \"plain_text\", \"content\": \"提交作答\"}, \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"mq\", \"c\": 21, \"n\": 1}}]}]}", "sms_hint": "多选题：勾选后点「提交作答」送达；也可回复「作答 21 1,3」（逗号分隔序号）；自定义文字回复「作答 21 <文字>」", "sms_noopt": [null, "请回复「作答 22 <文字>」作答"], "sms_plain": [{"tag": "form", "name": "mqf23_1", "elements": [{"tag": "multi_select_static", "name": "mq23_1", "placeholder": {"tag": "plain_text", "content": "请选择（可多选）"}, "options": [{"text": {"tag": "plain_text", "content": "甲"}, "value": "1"}], "behaviors": [{"type": "callback", "value": {"t": "mq", "c": 23, "n": 1}}]}, {"tag": "button", "name": "mqs23_1", "form_action_type": "submit", "type": "primary", "text": {"tag": "plain_text", "content": "提交作答"}, "behaviors": [{"type": "callback", "value": {"t": "mq", "c": 23, "n": 1}}]}]}, "多选题：勾选后点「提交作答」送达；也可回复「作答 23 1,3」（逗号分隔序号）"], "card_answerable_multi": "{\"schema\": \"2.0\", \"header\": {\"title\": {\"tag\": \"plain_text\", \"content\": \"🤔 卡片等待回复 [对拍项目]\"}, \"template\": \"orange\"}, \"body\": {\"elements\": [{\"tag\": \"markdown\", \"content\": \"**agent 提问（共 2 题）**\\n卡片 #7 登录接口调试\"}, {\"tag\": \"markdown\", \"content\": \"**1/2 甲题**\\n甲？\\n补充甲\\n1) a\\n2) b\\n　　描述乙\\n（多选；可自定义：自定义）\"}, {\"tag\": \"form\", \"name\": \"mqf7_1\", \"elements\": [{\"tag\": \"multi_select_static\", \"name\": \"mq7_1\", \"placeholder\": {\"tag\": \"plain_text\", \"content\": \"请选择（可多选）\"}, \"options\": [{\"text\": {\"tag\": \"plain_text\", \"content\": \"a\"}, \"value\": \"1\"}, {\"text\": {\"tag\": \"plain_text\", \"content\": \"b\"}, \"value\": \"2\"}], \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"mq\", \"c\": 7, \"n\": 1}}]}, {\"tag\": \"button\", \"name\": \"mqs7_1\", \"form_action_type\": \"submit\", \"type\": \"primary\", \"text\": {\"tag\": \"plain_text\", \"content\": \"提交第 1 题\"}, \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"mq\", \"c\": 7, \"n\": 1}}]}]}, {\"tag\": \"form\", \"name\": \"aof7_1\", \"elements\": [{\"tag\": \"input\", \"name\": \"ao7_1\", \"placeholder\": {\"tag\": \"plain_text\", \"content\": \"输入自定义回答\"}, \"max_length\": 1000, \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"ao\", \"c\": 7, \"n\": 1}}]}, {\"tag\": \"button\", \"name\": \"aos7_1\", \"form_action_type\": \"submit\", \"type\": \"primary\", \"text\": {\"tag\": \"plain_text\", \"content\": \"提交自定义回答\"}, \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"ao\", \"c\": 7, \"n\": 1}}]}]}, {\"tag\": \"markdown\", \"content\": \"**2/2 乙？**\\n1) cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc…\\n　　dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd…\"}, {\"tag\": \"select_static\", \"name\": \"mq7_2\", \"placeholder\": {\"tag\": \"plain_text\", \"content\": \"请选择\"}, \"options\": [{\"text\": {\"tag\": \"plain_text\", \"content\": \"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc…\"}, \"value\": \"1\"}], \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"mq\", \"c\": 7, \"n\": 2}}]}, {\"tag\": \"markdown\", \"content\": \"逐题选择即可，答满 2 题自动送达 agent。\\n第 1 题是多选：勾选后点「提交第 1 题」\\n第 1 题可在下方输入框填写自定义回答（点带题号的提交按钮）\"}]}}", "card_readonly_plan": "{\"schema\": \"2.0\", \"header\": {\"title\": {\"tag\": \"plain_text\", \"content\": \"🤔 卡片等待回复 [对拍项目]\"}, \"template\": \"orange\"}, \"body\": {\"elements\": [{\"tag\": \"collapsible_panel\", \"expanded\": true, \"header\": {\"title\": {\"tag\": \"plain_text\", \"content\": \"📄 agent 的方案 / 回答（点标题可折叠）\"}}, \"elements\": [{\"tag\": \"markdown\", \"content\": \"**方案**摘要\"}]}, {\"tag\": \"markdown\", \"content\": \"📄 [查看完整方案（飞书文档）](https://ts.example/docx/1)\"}, {\"tag\": \"markdown\", \"content\": \"**agent 提问（共 2 题）**\\n卡片 #9 只读卡\"}, {\"tag\": \"markdown\", \"content\": \"**1/2 甲题**\\n甲？\\n补充甲\\n1) a\\n2) b\\n　　描述乙\\n（多选；可自定义：自定义）\"}, {\"tag\": \"markdown\", \"content\": \"**2/2 乙？**\\n1) cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc…\\n　　dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd…\"}, {\"tag\": \"markdown\", \"content\": \"该等待不支持远程作答（提问由 dsh 直跑会话发起），请在 dsh 会话窗口作答\"}]}}", "card_single": "{\"schema\": \"2.0\", \"header\": {\"title\": {\"tag\": \"plain_text\", \"content\": \"🤔 卡片等待回复 [#9]\"}, \"template\": \"orange\"}, \"body\": {\"elements\": [{\"tag\": \"markdown\", \"content\": \"**agent 提问**：走哪条？\\n卡片 #11 单选卡\\n1) {}\\n2) 乙\"}, {\"tag\": \"button\", \"type\": \"primary\", \"text\": {\"tag\": \"plain_text\", \"content\": \"1) {}\"}, \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"a\", \"c\": 11, \"i\": 1}}]}, {\"tag\": \"button\", \"type\": \"default\", \"text\": {\"tag\": \"plain_text\", \"content\": \"2) 乙\"}, \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"a\", \"c\": 11, \"i\": 2}}]}, {\"tag\": \"form\", \"name\": \"aof11_1\", \"elements\": [{\"tag\": \"input\", \"name\": \"ao11_1\", \"placeholder\": {\"tag\": \"plain_text\", \"content\": \"输入自定义回答\"}, \"max_length\": 1000, \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"ao\", \"c\": 11, \"n\": 1}}]}, {\"tag\": \"button\", \"name\": \"aos11_1\", \"form_action_type\": \"submit\", \"type\": \"primary\", \"text\": {\"tag\": \"plain_text\", \"content\": \"提交自定义回答\"}, \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"ao\", \"c\": 11, \"n\": 1}}]}]}, {\"tag\": \"markdown\", \"content\": \"自定义回答：在下方输入框填写后点「提交自定义回答」，也可回复「作答 11 <文字>」\"}]}}", "card_approval": "{\"schema\": \"2.0\", \"header\": {\"title\": {\"tag\": \"plain_text\", \"content\": \"🤔 卡片等待回复 [对拍项目]\"}, \"template\": \"orange\"}, \"body\": {\"elements\": [{\"tag\": \"markdown\", \"content\": \"**审批请求**：file_write\\n工具：Write\\n内容：x = 1\\ny = 2\"}, {\"tag\": \"button\", \"type\": \"primary\", \"text\": {\"tag\": \"plain_text\", \"content\": \"✅ 批准\"}, \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"p\", \"c\": 13}}]}, {\"tag\": \"button\", \"type\": \"default\", \"text\": {\"tag\": \"plain_text\", \"content\": \"🔁 会话内批准\"}, \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"s\", \"c\": 13}}]}, {\"tag\": \"button\", \"type\": \"danger\", \"text\": {\"tag\": \"plain_text\", \"content\": \"⛔ 拒绝\"}, \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"d\", \"c\": 13}}]}]}}", "card_multiselect": "{\"schema\": \"2.0\", \"header\": {\"title\": {\"tag\": \"plain_text\", \"content\": \"🤔 卡片等待回复 [对拍项目]\"}, \"template\": \"orange\"}, \"body\": {\"elements\": [{\"tag\": \"markdown\", \"content\": \"**agent 提问**：选哪些？\\n卡片 #17 多选\\n1) 甲\\n2) 乙\"}, {\"tag\": \"form\", \"name\": \"mqf17_1\", \"elements\": [{\"tag\": \"multi_select_static\", \"name\": \"mq17_1\", \"placeholder\": {\"tag\": \"plain_text\", \"content\": \"请选择（可多选）\"}, \"options\": [{\"text\": {\"tag\": \"plain_text\", \"content\": \"甲\"}, \"value\": \"1\"}, {\"text\": {\"tag\": \"plain_text\", \"content\": \"乙\"}, \"value\": \"2\"}], \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"mq\", \"c\": 17, \"n\": 1}}]}, {\"tag\": \"button\", \"name\": \"mqs17_1\", \"form_action_type\": \"submit\", \"type\": \"primary\", \"text\": {\"tag\": \"plain_text\", \"content\": \"提交作答\"}, \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"mq\", \"c\": 17, \"n\": 1}}]}]}, {\"tag\": \"markdown\", \"content\": \"多选题：勾选后点「提交作答」送达；也可回复「作答 17 1,3」（逗号分隔序号）\"}]}}", "plan_question_md": "### 1/2 甲题\n甲？\n补充甲\n1) a\n2) b\n　　描述乙\n（多选；可自定义：自定义）\n### 2/2 乙？\n1) cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\n　　dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", "plan_question_md_flat": "平铺？\n1) 甲\n2) 乙", "plan_doc_title": "卡 31 · 首行标题", "plan_inline_empty": "", "plan_inline_short": "我给一份方案", "plan_inline_long": "答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答答\n\n…（摘要已截断，完整内容见下方飞书文档）", "plan_inline_think_only": "", "plan_doc_markdown_no_time": "# 卡 31 · agent 的方案与提问\n\n- 项目：对拍项目\n- 卡片：方案卡\n- 会话：sid-1\n\n## agent 的方案 / 回答\n\n短答\n\n## 提问（全文）\n\n### 1/2 甲题\n甲？\n补充甲\n1) a\n2) b\n　　描述乙\n（多选；可自定义：自定义）\n### 2/2 乙？\n1) cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\n　　dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\n\n## 如何作答\n\n- 在飞书聊天里点卡片上的选项按钮 / 下拉即完成作答（多选题勾选后点「提交」）；\n- 也可以直接回复：「作答 31 <序号>」（多选逗号分隔，如 `作答 31 1,3`），或「作答 31 <自定义文字>」写自由文本；\n- 点选与文本作答可混用，已点选的题不必重复给。", "plan_doc_markdown_long": 20010, "render_tips": "🤔 卡片等待回复 [对拍项目]\n卡片 #41 多选卡\nagent 提问：选？\n  1) 甲\n  2) 乙\n飞书回复「作答 41 <选项序号>」按选项作答；多选逗号分隔（作答 41 1,3）；「作答 41 <文字>」自定义回答\n详情：https://ts.example", "render_count_only": "🤔 卡片等待回复 [对拍项目]\n卡片 #42 无题\n该提问含 3 道子题：可在卡片上逐题点选（点满自动送达），或回复「作答 42 1:<选项序号> 2:<选项序号> 3:<选项序号>」一次答全；多选写「1:2,3」，自定义写「1:文字」", "render_task_no_skip": "❌ 任务失败 [对拍项目]\n任务 #5 构建（pipeline）\n错误：boom\n详情：https://ts.example", "render_missing_proj": "📋 卡片待审核 [#999]\n卡片 #6 T", "md_blocks_long": "[{\"block_type\": 2, \"text\": {\"elements\": [{\"text_run\": {\"content\": \"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\", \"text_element_style\": {\"bold\": false}}}], \"style\": {}}}, {\"block_type\": 2, \"text\": {\"elements\": [{\"text_run\": {\"content\": \"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\", \"text_element_style\": {\"bold\": false}}}], \"style\": {}}}, {\"block_type\": 2, \"text\": {\"elements\": [{\"text_run\": {\"content\": \"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\", \"text_element_style\": {\"bold\": false}}}], \"style\": {}}}, {\"block_type\": 12, \"bullet\": {\"elements\": [{\"text_run\": {\"content\": \"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\", \"text_element_style\": {\"bold\": false}}}], \"style\": {}}}, {\"block_type\": 12, \"bullet\": {\"elements\": [{\"text_run\": {\"content\": \"yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\", \"text_element_style\": {\"bold\": false}}}], \"style\": {}}}]", "plan_question_md_empty": "", "render_header_only": "❌ 任务失败 [对拍项目]", "render_status_only": "❌ 任务失败 [对拍项目]\n错误：EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE\n详情：https://a/b", "card_single_multiselect_other": "{\"schema\": \"2.0\", \"header\": {\"title\": {\"tag\": \"plain_text\", \"content\": \"🤔 卡片等待回复 [对拍项目]\"}, \"template\": \"orange\"}, \"body\": {\"elements\": [{\"tag\": \"markdown\", \"content\": \"**agent 提问**：选哪些？\\n卡片 #17 多选\\n1) 甲\\n2) 乙\"}, {\"tag\": \"form\", \"name\": \"mqf17_1\", \"elements\": [{\"tag\": \"multi_select_static\", \"name\": \"mq17_1\", \"placeholder\": {\"tag\": \"plain_text\", \"content\": \"请选择（可多选）\"}, \"options\": [{\"text\": {\"tag\": \"plain_text\", \"content\": \"甲\"}, \"value\": \"1\"}, {\"text\": {\"tag\": \"plain_text\", \"content\": \"乙\"}, \"value\": \"2\"}], \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"mq\", \"c\": 17, \"n\": 1}}]}, {\"tag\": \"button\", \"name\": \"mqs17_1\", \"form_action_type\": \"submit\", \"type\": \"primary\", \"text\": {\"tag\": \"plain_text\", \"content\": \"提交作答\"}, \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"mq\", \"c\": 17, \"n\": 1}}]}]}, {\"tag\": \"form\", \"name\": \"aof17_1\", \"elements\": [{\"tag\": \"input\", \"name\": \"ao17_1\", \"placeholder\": {\"tag\": \"plain_text\", \"content\": \"输入自定义回答\"}, \"max_length\": 1000, \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"ao\", \"c\": 17, \"n\": 1}}]}, {\"tag\": \"button\", \"name\": \"aos17_1\", \"form_action_type\": \"submit\", \"type\": \"primary\", \"text\": {\"tag\": \"plain_text\", \"content\": \"提交自定义回答\"}, \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"ao\", \"c\": 17, \"n\": 1}}]}]}, {\"tag\": \"markdown\", \"content\": \"多选题：勾选后点「提交作答」；自定义文字在下方输入框填写后点「提交自定义回答」（也可回复「作答 17 <文字>」）\"}]}}", "card_single_free_text": "{\"schema\": \"2.0\", \"header\": {\"title\": {\"tag\": \"plain_text\", \"content\": \"🤔 卡片等待回复 [对拍项目]\"}, \"template\": \"orange\"}, \"body\": {\"elements\": [{\"tag\": \"markdown\", \"content\": \"**agent 提问**：说说？\\n卡片 #19 填空\"}, {\"tag\": \"form\", \"name\": \"aof19_1\", \"elements\": [{\"tag\": \"input\", \"name\": \"ao19_1\", \"placeholder\": {\"tag\": \"plain_text\", \"content\": \"输入自定义回答\"}, \"max_length\": 1000, \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"ao\", \"c\": 19, \"n\": 1}}]}, {\"tag\": \"button\", \"name\": \"aos19_1\", \"form_action_type\": \"submit\", \"type\": \"primary\", \"text\": {\"tag\": \"plain_text\", \"content\": \"提交自定义回答\"}, \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"ao\", \"c\": 19, \"n\": 1}}]}]}, {\"tag\": \"markdown\", \"content\": \"自定义回答：在下方输入框填写后点「提交自定义回答」，也可回复「作答 19 <文字>」\"}]}}", "custom_form": "{\"tag\": \"form\", \"name\": \"aof21_1\", \"elements\": [{\"tag\": \"input\", \"name\": \"ao21_1\", \"placeholder\": {\"tag\": \"plain_text\", \"content\": \"输入自定义回答\"}, \"max_length\": 1000, \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"ao\", \"c\": 21, \"n\": 1}}]}, {\"tag\": \"button\", \"name\": \"aos21_1\", \"form_action_type\": \"submit\", \"type\": \"primary\", \"text\": {\"tag\": \"plain_text\", \"content\": \"提交自定义回答\"}, \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"ao\", \"c\": 21, \"n\": 1}}]}]}", "custom_form_multi_no": "{\"tag\": \"form\", \"name\": \"aof21_2\", \"elements\": [{\"tag\": \"input\", \"name\": \"ao21_2\", \"placeholder\": {\"tag\": \"plain_text\", \"content\": \"输入自定义回答\"}, \"max_length\": 1000, \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"ao\", \"c\": 21, \"n\": 2}}]}, {\"tag\": \"button\", \"name\": \"aos21_2\", \"form_action_type\": \"submit\", \"type\": \"primary\", \"text\": {\"tag\": \"plain_text\", \"content\": \"提交第 2 题自定义回答\"}, \"behaviors\": [{\"type\": \"callback\", \"value\": {\"t\": \"ao\", \"c\": 21, \"n\": 2}}]}]}"};

// --------------------------------------------------------------------------
// 测试台
// --------------------------------------------------------------------------

/** 临时库 + 项目 1（名「对拍项目」，所有者 user 0）+ 用户级配置 + 项目级绑定行 */
function setup(tag) {
  const fx = freshDb(tag);
  const pid = insertProject(fx.db, { userId: 0, name: '对拍项目' });
  const opts = { dbPath: fx.dbPath };
  db.setFeishuUserCfg(0, {
    enabled: true,
    push_enabled: true,
    default_webhook: 'http://127.0.0.1:7913/hook/default',
    default_secret: 'sec-def',
    base_url: 'https://ts.example/',
  }, opts);
  db.setFeishuHook(pid, 'http://127.0.0.1:7913/hook/p1', 'sec-p1',
    'blocked_interaction,task_failed,card_review', 1, opts);
  return { ...fx, pid, opts };
}

/** 读多行（真 SQL，绕开被测函数） */
function rowsOf(fx, sql, ...args) {
  return fx.db.prepare(sql).all(...args).map((row) => ({ ...row }));
}

/** 读一行 */
function rowOf(fx, sql, ...args) {
  const row = fx.db.prepare(sql).get(...args);
  return row === undefined ? null : { ...row };
}

/**
 * 起一只**原始 TCP** HTTP 接收器：把每个请求的原始字节（头原样 + body）记下来，并按
 * 脚本回响应（`seen` 按到达顺序编号）。用原始 socket 而非 `node:http` 是为了拿**头序**——
 * `node:http` 服务端会把头归一化，逐字节判据就没了。
 */
function rawHttpServer(script) {
  const seen = [];
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const text = buf.toString('latin1');
      const idx = text.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = text.slice(0, idx);
      const m = /content-length: (\d+)/i.exec(head);
      const need = m ? Number(m[1]) : 0;
      const rest = buf.subarray(idx + 4);
      if (rest.length < need) return;                    // body 还没收全
      const item = script[Math.min(seen.length, script.length - 1)];
      seen.push({ head, body: Buffer.from(rest.subarray(0, need)) });
      const bodyBuf = Buffer.from(item.body, 'utf8');
      sock.end(Buffer.concat([
        Buffer.from(`HTTP/1.1 ${item.status} ${item.reason}\r\n`
          + 'Content-Type: application/json\r\n'
          + `Content-Length: ${bodyBuf.length}\r\n`
          + 'Connection: close\r\n\r\n', 'latin1'),
        bodyBuf,
      ]));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({
        seen,
        port,
        url: (p) => `http://127.0.0.1:${port}${p}`,
        close: () => new Promise((r) => { srv.close(() => r()); }),
      });
    });
  });
}

// --------------------------------------------------------------------------
// 常量与 R1 复用
// --------------------------------------------------------------------------

test('常量照 feishu.py：RETRY_DELAYS/SEND_TIMEOUT/TICK/EVENT_META/Q_* 上限', () => {
  assert.deepEqual([...feishu.RETRY_DELAYS], [60, 300, 1800]);
  assert.equal(feishu.SEND_TIMEOUT, 5);
  assert.equal(feishu.TICK, 1.0);
  assert.deepEqual(Object.keys(feishu.EVENT_META), ['blocked_interaction', 'task_failed', 'card_review']);
  assert.deepEqual([...feishu.EVENT_META.card_review], ['📋 卡片待审核', false]);
  assert.deepEqual([feishu.Q_TEXT_MAX, feishu.Q_OPT_MAX, feishu.Q_DESC_MAX], [500, 100, 160]);
  assert.equal(feishu.NO_REMOTE_ANSWER_HINT,
    '该等待不支持远程作答（提问由 dsh 直跑会话发起），请在 dsh 会话窗口作答');
});

test('notifyEvents/hookOf 是 R1 那两个函数本体（import 复用，不是第二份实现）', () => {
  assert.equal(feishu.notifyEvents, feishuCfg.notifyEvents);
  assert.equal(feishu.hookOf, feishuCfg.hookOf);
  assert.equal(feishu.FEISHU_EVENTS, feishuCfg.FEISHU_EVENTS);
  assert.equal(feishu.FEISHU_DEFAULT_EVENTS, feishuCfg.FEISHU_DEFAULT_EVENTS);
});

// --------------------------------------------------------------------------
// sign / payload（oracle 固定向量）
// --------------------------------------------------------------------------

test('sign：base64(HMAC_SHA256(key=f"{ts}\\n{secret}", msg=b""))——三条 oracle 向量', () => {
  // key 是 `f"{ts}\n{secret}"`、被签的是空串：写成 key=secret/msg=ts 会全错
  assert.equal(feishu.sign('sec-p1', '1700000000'), '8KHKsI0WObYgB7PiU6YXMW05FgqA7DKIajgPCvCcdwM=');
  assert.equal(feishu.sign('密钥甲', '1700000000'), 'Du3BiIPbYqRyXBdyVUDS59xJkTfm1s93Mo9a+lF0wPo=');
  assert.equal(feishu.sign('', '1700000000'), 'DaBQacIHB6FCKocfPme7o5BIrwne87ibBLj7EYGUds0=');
});

test('payload：逐字节 = json.dumps({"msg_type","content"})，中文/换行/emoji 不转义', () => {
  assert.equal(feishu.payload('甲\n乙'),
    '{"msg_type": "text", "content": {"text": "甲\\n乙"}}');
  assert.equal(feishu.payload('🤔 卡片等待回复 [对拍项目]'),
    '{"msg_type": "text", "content": {"text": "🤔 卡片等待回复 [对拍项目]"}}');
  assert.equal(feishu.payload(''), '{"msg_type": "text", "content": {"text": ""}}');
});

// --------------------------------------------------------------------------
// render（oracle 未覆盖分支；用例已覆盖的六支不重复）
// --------------------------------------------------------------------------

test('render：多选/自定义作答指引三连（`；` 拼接）；base_url 削尾斜杠', () => {
  const fx = setup('feishu-render');
  try {
    const got = feishu.render('blocked_interaction', {
      card_id: 41, title: '多选卡', kind: 'question', question: '选？',
      options: ['甲', '乙'], multi_select: true, allow_other: true, answerable: true,
    }, fx.pid, 'https://ts.example/', { dbPath: fx.dbPath });
    assert.equal(got, ORACLE.render_tips);
  } finally { fx.close(); }
});

test('render：只有 questions_count（无 questions 数组）也走「一条指令答全」', () => {
  const fx = setup('feishu-render2');
  try {
    assert.equal(feishu.render('blocked_interaction', {
      card_id: 42, title: '无题', kind: 'question', questions_count: 3, answerable: true,
    }, fx.pid, '', { dbPath: fx.dbPath }), ORACLE.render_count_only);
  } finally { fx.close(); }
});

test('render：只有标题行 / 只有 error 与 base_url / 项目不存在时标题用 #id', () => {
  const fx = setup('feishu-render3');
  try {
    assert.equal(feishu.render('task_failed', { name: 'x' }, fx.pid, '', { dbPath: fx.dbPath }),
      ORACLE.render_header_only);
    assert.equal(feishu.render('task_failed', { error: 'E'.repeat(300), skipped_n: 0 },
      fx.pid, 'https://a/b/', { dbPath: fx.dbPath }), ORACLE.render_status_only);
    assert.equal(feishu.render('card_review', { card_id: 6, title: 'T' }, 999,
      'https://x', { dbPath: fx.dbPath }), ORACLE.render_missing_proj);
  } finally { fx.close(); }
});

// --------------------------------------------------------------------------
// markdown → 文档块（plan 族纯函数，oracle 逐字节）
// --------------------------------------------------------------------------

test('mdPlain：**粗**/*斜*/`码`/~~删~~ 清掉；单星号与跨行不误伤', () => {
  assert.deepEqual(ORACLE.md_plain.map((s) => s), [
    '粗 与 斜 与 码 与 删', 'abc', '**跨\n行**', '2  3  4', '| --- | --- |',
  ]);
  for (const [i, s] of ['**粗** 与 *斜* 与 `码` 与 ~~删~~', 'a*b*c', '**跨\n行**', '2 * 3 * 4',
    '| --- | --- |'].entries()) {
    assert.equal(feishu.mdPlain(s), ORACLE.md_plain[i], `md_plain[${i}]`);
  }
});

test('mdBlocks：标题/列表/引用/代码/分隔线/表格分隔行丢弃 —— oracle 逐字节', () => {
  const sample = ['# 一级标题', '## 二级 **加粗**', '### 三级', '', '正文 **粗** 行', '> 引用行', '',
    '- 项目甲', '  * 项目乙', '1. 有序一', '2) 有序二', '', '```', 'code **不**处理', '```',
    '| --- | --- |', '| a | b |', '---', '   ', '尾行'].join('\n');
  assert.equal(pyJsonDumps(feishu.mdBlocks(sample)), ORACLE.md_blocks);
});

test('mdBlocks：超长段落按 MD_BLOCK_MAX=1800 **码点**切块（oracle 同款）', () => {
  assert.equal(pyJsonDumps(feishu.mdBlocks(`${'x'.repeat(4000)}\n- ${'y'.repeat(1900)}`)),
    ORACLE.md_blocks_long);
});

// --------------------------------------------------------------------------
// 多子题渲染族（oracle 逐字节）
// --------------------------------------------------------------------------

const QS = [
  {
    id: 'q1',
    header: '甲题',
    question: '甲？',
    body: '补充甲',
    options: ['a', { label: 'b', description: '描述乙' }],
    multi_select: true,
    allow_other: true,
    other_label: '自定义',
  },
  { question: '乙？', options: [{ label: 'c'.repeat(120), description: 'd'.repeat(200) }] },
];

test('questionViews：逐题视图 + label/description 按 Q_OPT_MAX/Q_DESC_MAX 截断加 …', () => {
  assert.equal(pyJsonDumps(feishu.questionViews(QS)), ORACLE.question_views);
});

test('questionTextLines / multiAnswerHelp / multiClickHint：oracle 逐字节', () => {
  const views = feishu.questionViews(QS);
  assert.equal(feishu.questionTextLines(views).join('\n'), ORACLE.question_text_lines);
  assert.equal(feishu.multiAnswerHelp(15, QS), ORACLE.multi_answer_help);
  assert.equal(feishu.multiClickHint(15, QS, [3], [1]), ORACLE.multi_click_hint);
  assert.equal(feishu.multiClickHint(7, [{ question: 'x' }]), ORACLE.multi_click_hint_bare);
});

test('singleMultiSelectPick：多选 mini 表单 / 无选项 / 单选无多选', () => {
  const [form, hint] = feishu.singleMultiSelectPick(21, {
    card_id: 21, question: '选哪些？', options: ['甲', '乙'], multi_select: true, allow_other: true,
  });
  assert.equal(pyJsonDumps(form), ORACLE.sms_form);
  assert.equal(hint, ORACLE.sms_hint);
  assert.deepEqual(feishu.singleMultiSelectPick(22, { card_id: 22, question: 'q', allow_other: true }),
    ORACLE.sms_noopt);
  assert.deepEqual(feishu.singleMultiSelectPick(23, { card_id: 23, question: 'q', options: ['甲'] }),
    ORACLE.sms_plain);
});

// --------------------------------------------------------------------------
// 交互卡片（oracle 逐字节；REST 那条腿在别处）
// --------------------------------------------------------------------------

test('buildInteractionCard：可远程作答多子题 / 不可作答+方案 / 单选+自定义 / 多选 / 审批 / 输入框', () => {
  const multi = {
    card_id: 7, title: '登录接口调试', kind: 'question', question: '用哪个方案？',
    options: ['方案甲', '方案乙'], answerable: true, questions: QS, questions_count: 2,
  };
  assert.equal(pyJsonDumps(feishu.buildInteractionCard(multi, '对拍项目')),
    ORACLE.card_answerable_multi);
  assert.equal(pyJsonDumps(feishu.buildInteractionCard({
    card_id: 9, title: '只读卡', kind: 'question', questions: QS, questions_count: 2,
    answerable: false, plan_inline: '**方案**摘要', plan_doc_url: 'https://ts.example/docx/1',
  }, '对拍项目')), ORACLE.card_readonly_plan);
  assert.equal(pyJsonDumps(feishu.buildInteractionCard({
    card_id: 11, title: '单选卡', kind: 'question', question: '走哪条？',
    options: [{}, '乙'], answerable: true, allow_other: true,
  }, '#9')), ORACLE.card_single);
  assert.equal(pyJsonDumps(feishu.buildInteractionCard({
    card_id: 13, title: '', kind: 'approval', action: 'file_write', tool: 'Write',
    input: 'x = 1\ny = 2', plan_inline: '不该出现',
  }, '对拍项目')), ORACLE.card_approval);
  assert.equal(pyJsonDumps(feishu.buildInteractionCard({
    card_id: 17, title: '多选', kind: 'question', question: '选哪些？',
    options: ['甲', '乙'], multi_select: true, answerable: true,
  }, '对拍项目')), ORACLE.card_multiselect);
  // 2026-10-26：自定义回答输入框。真机探针定论——输入文字在
  // `action.form_value[<input name>]`（字符串）、提交帧归属按钮、`action.value` 取
  // **提交按钮**的 behaviors.value ⇒ t=ao 挂在按钮上
  assert.equal(pyJsonDumps(feishu.customInputForm(21, 1)), ORACLE.custom_form);
  assert.equal(pyJsonDumps(feishu.customInputForm(21, 2)), ORACLE.custom_form_multi_no);
  assert.equal(pyJsonDumps(feishu.buildInteractionCard({
    card_id: 17, title: '多选', kind: 'question', question: '选哪些？',
    options: ['甲', '乙'], multi_select: true, answerable: true, allow_other: true,
  }, '对拍项目')), ORACLE.card_single_multiselect_other);
  assert.equal(pyJsonDumps(feishu.buildInteractionCard({
    card_id: 19, title: '填空', kind: 'question', question: '说说？',
    options: [], answerable: true, allow_other: true, questions_count: 1,
  }, '对拍项目')), ORACLE.card_single_free_text);
});

// --------------------------------------------------------------------------
// plan 族（纯函数，oracle 逐字节）
// --------------------------------------------------------------------------

test('planQuestionMd：全文（不截断）+ 平铺字段兜底 + 空 ctx', () => {
  const pctx = {
    card_id: 31, title: '方案卡', question: '甲？', header: '首行标题\n第二行',
    questions: QS, qid: 'qid-1', session_id: 'sid-1',
  };
  assert.equal(feishu.planQuestionMd(pctx), ORACLE.plan_question_md);
  assert.equal(feishu.planQuestionMd({ question: '平铺？', options: ['甲', { label: '乙' }] }),
    ORACLE.plan_question_md_flat);
  assert.equal(feishu.planQuestionMd({}), ORACLE.plan_question_md_empty);
});

test('planDocTitle：卡号 + 题头首行 + 截 80', () => {
  assert.equal(feishu.planDocTitle({
    card_id: 31, question: '甲？', header: '首行标题\n第二行',
  }), ORACLE.plan_doc_title);
});

// 2026-10-18 用户裁定：think（「思考摘录」）不再进入任何飞书产物——卡内摘要与
// 方案文档都只带 assistant 回答；本组期望已用真 Python 实现重新现算（见文件头②）。
test('planInlineMarkdown：空 / 只给 assistant（不掺 think） / 超长截断 / 仅 think 为空', () => {
  const pctx = { card_id: 31 };
  assert.equal(feishu.planInlineMarkdown(pctx, { assistant: '', think: '' }),
    ORACLE.plan_inline_empty);
  assert.equal(feishu.planInlineMarkdown(pctx, { assistant: '我给一份方案', think: '思考*正文*' }),
    ORACLE.plan_inline_short);
  assert.equal(feishu.planInlineMarkdown(pctx, { assistant: '答'.repeat(1600), think: 't' }),
    ORACLE.plan_inline_long);
  assert.equal(feishu.planInlineMarkdown(pctx, { assistant: '', think: '只有思考'.repeat(400) }),
    ORACLE.plan_inline_think_only);
  // 显式守卫：短答场景下 think 一个字都不许进卡
  const short = feishu.planInlineMarkdown(pctx, { assistant: '我给一份方案', think: '思考*正文*' });
  assert.ok(!short.includes('思考摘录') && !short.includes('思考*正文*'));
});

test('planDocMarkdown：结构逐字节（时间行按挂钟，剔掉比）；整体按 PLAN_DOC_MAX 截断', () => {
  const pctx = {
    card_id: 31, title: '方案卡', question: '甲？', header: '首行标题\n第二行',
    questions: QS, qid: 'qid-1', session_id: 'sid-1',
  };
  const md = feishu.planDocMarkdown(pctx, { assistant: '短答', think: '思考内容' }, '对拍项目');
  assert.match(md, /^- 时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}（北京时间）$/m);
  assert.ok(!md.includes('思考摘录') && !md.includes('思考内容'));   // 2026-10-18：文档也不带 think
  assert.equal(md.split('\n').filter((ln) => !ln.startsWith('- 时间：')).join('\n'),
    ORACLE.plan_doc_markdown_no_time);
  assert.equal(feishu.planDocMarkdown(pctx, { assistant: '答'.repeat(30000) }, 'P').length,
    ORACLE.plan_doc_markdown_long);
});

test('planDocGet/Put：(卡, 提问) 记账；未记账回空串；同键覆盖', () => {
  assert.equal(feishu.planDocGet(901, 'q-x'), '');
  feishu.planDocPut(901, 'q-x', 'https://ts.example/docx/a');
  assert.equal(feishu.planDocGet(901, 'q-x'), 'https://ts.example/docx/a');
  feishu.planDocPut(901, 'q-x', 'https://ts.example/docx/b');
  assert.equal(feishu.planDocGet(901, 'q-x'), 'https://ts.example/docx/b');
  assert.equal(feishu.planDocGet(901, 'q-y'), '');            // 提问维度不同 ⇒ 不串
  assert.equal(feishu.planDocGet(902, 'q-x'), '');            // 卡片维度不同 ⇒ 不串
});

test('beijingNow：UTC+8 的 `YYYY-MM-DD HH:MM`（容器时区=UTC 也要对）', () => {
  const got = feishu.beijingNow();
  assert.match(got, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const near = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:`;
  assert.equal(got.slice(0, near.length), near);
});

// --------------------------------------------------------------------------
// pushEvent / 业务侧语义函数
// --------------------------------------------------------------------------

test('pushEvent：按闸门入队（target/secret/payload/user_id/dedup 逐列），同 dedup 不插新行', () => {
  const fx = setup('feishu-push');
  try {
    const ctx = { card_id: 7, title: 'T', kind: 'question', question: 'q', answerable: true };
    assert.equal(feishu.pushEvent(fx.pid, 'blocked_interaction', ctx, { dbPath: fx.dbPath }),
      undefined);
    const rows = rowsOf(fx, 'SELECT * FROM feishu_outbox ORDER BY id');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target, 'http://127.0.0.1:7913/hook/p1');
    assert.equal(rows[0].secret, 'sec-p1');
    assert.equal(rows[0].user_id, 0);
    assert.equal(rows[0].status, 'pending');
    assert.equal(rows[0].retries, 0);
    assert.equal(rows[0].next_at, 0);
    assert.equal(rows[0].dedup_key, `blocked_interaction:${fx.pid}:7`);
    assert.equal(rows[0].payload, feishu.payload(feishu.render('blocked_interaction', ctx,
      fx.pid, 'https://ts.example', { dbPath: fx.dbPath })));
    // 幂等：同 kind/同卡再推一次 ⇒ dedup 命中 pending 行，不插新行
    feishu.pushEvent(fx.pid, 'blocked_interaction', ctx, { dbPath: fx.dbPath });
    assert.equal(rowsOf(fx, 'SELECT id FROM feishu_outbox').length, 1);
    // 显式 dedup_key 优先
    feishu.pushEvent(fx.pid, 'blocked_interaction', { ...ctx, card_id: 8, dedup_key: 'X1' },
      { dbPath: fx.dbPath });
    assert.equal(rowOf(fx, 'SELECT id FROM feishu_outbox WHERE dedup_key=?', 'X1').id, 2);
  } finally { fx.close(); }
});

test('pushEvent：事件未开 / hook 为 None ⇒ 不入队；DB 不可用 ⇒ 静默（永不抛出）', () => {
  const fx = setup('feishu-push2');
  try {
    db.setFeishuHook(fx.pid, 'http://127.0.0.1:7913/hook/p1', 'sec-p1', 'task_failed', 1,
      { dbPath: fx.dbPath });
    feishu.pushEvent(fx.pid, 'blocked_interaction', { card_id: 7 }, { dbPath: fx.dbPath });
    assert.equal(rowsOf(fx, 'SELECT id FROM feishu_outbox').length, 0);
    // 项目行 enabled=0 ⇒ 闸门空 ⇒ hookOf=null ⇒ 同样不入队
    db.setFeishuHook(fx.pid, 'http://127.0.0.1:7913/hook/p1', 'sec-p1', 'task_failed', 0,
      { dbPath: fx.dbPath });
    feishu.pushEvent(fx.pid, 'task_failed', { task_id: 1 }, { dbPath: fx.dbPath });
    assert.equal(rowsOf(fx, 'SELECT id FROM feishu_outbox').length, 0);
    // 坏库路径（打不开）也要吞掉
    assert.equal(feishu.pushEvent(fx.pid, 'task_failed', { task_id: 1 },
      { dbPath: '/nonexistent-dir-ts/x.db' }), undefined);
  } finally { fx.close(); }
});

test('cardReview/taskFailed/cardBlocked：形参表照 Python，dedup_key 形状逐字', () => {
  const fx = setup('feishu-hooks');
  try {
    const opts = { dbPath: fx.dbPath };
    feishu.cardReview(fx.pid, { id: 9, title: '待审卡片' }, opts);
    feishu.taskFailed(fx.pid, 12, '跑通对拍', 'normal', '驱动未配置：dsh agent 驱动不可用', 2, opts);
    feishu.cardBlocked(fx.pid, { id: 5, title: '阻塞卡', session_id: '' },
      { qid: 'qid-9', kind: 'question', question: 'q', options: [{ label: '甲' }], answerable: false },
      opts);
    const rows = rowsOf(fx, 'SELECT id, dedup_key, payload FROM feishu_outbox ORDER BY id');
    assert.deepEqual(rows.map((r) => r.dedup_key), [
      `card_review:${fx.pid}:9`, `task_failed:${fx.pid}:12`, `card:5:interaction:qid-9`,
    ]);
    assert.equal(rows[1].payload, feishu.payload(feishu.render('task_failed', {
      task_id: 12, name: '跑通对拍', type: 'normal',
      error: '驱动未配置：dsh agent 驱动不可用', skipped_n: 2,
    }, fx.pid, 'https://ts.example', opts)));
  } finally { fx.close(); }
});

// --------------------------------------------------------------------------
// _send_one：线上字节（原始 TCP 接收器）
// --------------------------------------------------------------------------

test('sendOne：头序/大小写/值 + body 逐字节（secret 非空 ⇒ 补 timestamp/sign）', async () => {
  const srv = await rawHttpServer([{ status: 200, reason: 'OK', body: '{"code":0,"msg":"ok"}' }]);
  try {
    const payloadText = pyJsonDumps({ msg_type: 'text', content: { text: '甲\n乙' } });
    const tsBefore = Math.trunc(Date.now() / 1000);
    const [ok, err] = await feishu.sendOne({
      id: 1, retries: 0, secret: 'sec-1', target: srv.url('/hook?a=1'), payload: payloadText,
    });
    const tsAfter = Math.trunc(Date.now() / 1000);
    assert.equal(ok, true);
    assert.equal(err, '');
    assert.equal(srv.seen.length, 1);
    const bodyText = srv.seen[0].body.toString('utf8');
    const candidates = [tsBefore, tsAfter].map((ts) => pyJsonDumps({
      msg_type: 'text',
      content: { text: '甲\n乙' },
      timestamp: String(ts),
      sign: feishu.sign('sec-1', String(ts)),
    }));
    assert.ok(candidates.includes(bodyText),
      `body 不是「payload 追加 timestamp/sign」的逐字节形态：${bodyText}`);
    assert.equal(srv.seen[0].head, [
      'POST /hook?a=1 HTTP/1.1',
      'Accept-Encoding: identity',
      `Content-Length: ${Buffer.byteLength(bodyText, 'utf8')}`,
      `Host: 127.0.0.1:${srv.port}`,
      'User-Agent: Python-urllib/3.12',
      'Content-Type: application/json',
      'Connection: close',
    ].join('\r\n'));
  } finally { await srv.close(); }
});

test('sendOne：secret 为空/假值 ⇒ **不加** timestamp/sign 两键（body 逐字节 = payload）', async () => {
  const srv = await rawHttpServer([{ status: 200, reason: 'OK', body: '{"code":0}' }]);
  try {
    const payloadText = pyJsonDumps({ msg_type: 'text', content: { text: '乙' } });
    const [ok] = await feishu.sendOne({
      id: 2, retries: 0, secret: '', target: srv.url('/h'), payload: payloadText,
    });
    assert.equal(ok, true);
    assert.equal(srv.seen[0].body.toString('utf8'), payloadText);
    assert.equal(srv.seen[0].head.split('\r\n')[0], 'POST /h HTTP/1.1');
  } finally { await srv.close(); }
});

test('sendOne：业务码非 0 ⇒ [false, "code=<n> <msg>"]；非 JSON/非 dict/HTTP 5xx 各有其形', async () => {
  const srv = await rawHttpServer([
    { status: 200, reason: 'OK', body: '{"code":9499,"msg":"x"}' },
    { status: 200, reason: 'OK', body: '{"code":9499}' },
    { status: 200, reason: 'OK', body: '[1, 2]' },
    { status: 200, reason: 'OK', body: 'not-json' },
    { status: 500, reason: 'Internal Server Error', body: '{"code":0}' },
  ]);
  try {
    const base = { retries: 0, secret: '', target: srv.url('/h'), payload: '{"msg_type": "text"}' };
    assert.deepEqual(await feishu.sendOne({ ...base, id: 1 }), [false, 'code=9499 x']);
    assert.deepEqual(await feishu.sendOne({ ...base, id: 2 }), [false, 'code=9499 ']);
    assert.deepEqual(await feishu.sendOne({ ...base, id: 3 }), [false, '[1, 2]']);
    const [ok4, err4] = await feishu.sendOne({ ...base, id: 4 });
    assert.equal(ok4, false);
    assert.ok(err4.length > 0 && err4.length <= 200);      // 文案跨运行时不同（已知分歧）
    assert.deepEqual(await feishu.sendOne({ ...base, id: 5 }),
      [false, 'HTTP Error 500: Internal Server Error']);
  } finally { await srv.close(); }
});

test('sendOne：坏 payload / 坏 URL ⇒ 错误串，不外抛（daemon 不能在这抛）', async () => {
  const [ok1, err1] = await feishu.sendOne({
    id: 1, retries: 0, secret: '', target: 'http://127.0.0.1:1/h', payload: '{bad',
  });
  assert.equal(ok1, false);
  assert.ok(err1.length > 0 && err1.length <= 200);
  const [ok2, err2] = await feishu.sendOne({
    id: 1, retries: 0, secret: '', target: 'ftp://x/y', payload: '{"a": 1}',
  });
  assert.equal(ok2, false);
  assert.match(err2, /unknown url type/);
});

// --------------------------------------------------------------------------
// _send_one_and_mark：发送 + 落账（退避表用行上的 retries 驱动，不真等）
// --------------------------------------------------------------------------

test('sendOneAndMark：成功 ⇒ sent / retries 不变 / next_at=0 / last_error 清空', async () => {
  const fx = setup('feishu-mark-ok');
  const srv = await rawHttpServer([{ status: 200, reason: 'OK', body: '{"code":0,"msg":"ok"}' }]);
  try {
    const opts = { dbPath: fx.dbPath };
    const id = db.feishuOutboxPush(srv.url('/h'), 'sec-1', feishu.payload('成功发送'),
      'dk-ok', 0, opts);
    db.feishuOutboxMark(id, 'pending', 0, 0, '旧错', opts);
    const row = rowOf(fx, 'SELECT * FROM feishu_outbox WHERE id=?', id);
    assert.equal(await feishu.sendOneAndMark(row, opts), true);
    const after = rowOf(fx, 'SELECT * FROM feishu_outbox WHERE id=?', id);
    assert.equal(after.status, 'sent');
    assert.equal(after.retries, 0);
    assert.equal(after.next_at, 0);
    assert.equal(after.last_error, '');
  } finally { await srv.close(); fx.close(); }
});

test('sendOneAndMark：失败 ⇒ pending / retries+1 / next_at=now+60|300|1800 / last_error 逐字', async () => {
  const fx = setup('feishu-mark-bad');
  const srv = await rawHttpServer([{ status: 200, reason: 'OK', body: '{"code":9499,"msg":"x"}' }]);
  try {
    const opts = { dbPath: fx.dbPath };
    const ids = [];
    for (const n of [0, 1, 2]) {
      ids.push(db.feishuOutboxPush(srv.url('/h'), 'sec-1', feishu.payload(`退避${n}`),
        `dk-${n}`, 0, opts));
    }
    for (const [i, n] of [0, 1, 2].entries()) {
      const row = rowOf(fx, 'SELECT * FROM feishu_outbox WHERE id=?', ids[i]);
      assert.equal(await feishu.sendOneAndMark({ ...row, retries: n }, opts), false);
      const after = rowOf(fx, 'SELECT * FROM feishu_outbox WHERE id=?', ids[i]);
      assert.equal(after.status, 'pending');
      assert.equal(after.retries, n + 1);
      assert.equal(after.last_error, 'code=9499 x');
      const want = Date.now() / 1000 + feishu.RETRY_DELAYS[n];
      assert.ok(Math.abs(after.next_at - want) <= 5,
        `第 ${n + 1} 档退避应≈now+${feishu.RETRY_DELAYS[n]}，实得 ${after.next_at - Date.now() / 1000}`);
    }
  } finally { await srv.close(); fx.close(); }
});

test('sendOneAndMark：retries=3 ⇒ n=4 > len(RETRY_DELAYS) ⇒ failed 留痕（next_at 归 0）', async () => {
  const fx = setup('feishu-mark-fail');
  const srv = await rawHttpServer([{ status: 200, reason: 'OK', body: '{"code":9499,"msg":"x"}' }]);
  try {
    const opts = { dbPath: fx.dbPath };
    const id = db.feishuOutboxPush(srv.url('/h'), 'sec-1', feishu.payload('退避丁'), 'dk-4', 0, opts);
    const row = rowOf(fx, 'SELECT * FROM feishu_outbox WHERE id=?', id);
    assert.equal(await feishu.sendOneAndMark({ ...row, retries: 3 }, opts), false);
    const after = rowOf(fx, 'SELECT * FROM feishu_outbox WHERE id=?', id);
    assert.equal(after.status, 'failed');
    assert.equal(after.retries, 4);
    assert.equal(after.next_at, 0);
    assert.equal(after.last_error, 'code=9499 x');
    // failed 行不再被 due 取走
    assert.equal(db.feishuOutboxDue(Date.now() / 1000, 5, opts)
      .filter((r) => r.id === id).length, 0);
  } finally { await srv.close(); fx.close(); }
});

// --------------------------------------------------------------------------
// 投递线程 / 接线缝
// --------------------------------------------------------------------------

test('startNotifier：幂等（第二次 no-op 回 null）；定时器 unref 不夹住进程', () => {
  const fx = setup('feishu-notifier');
  try {
    feishu.resetSenderStarted();
    const t1 = feishu.startNotifier({ dbPath: fx.dbPath });
    assert.ok(t1 && typeof t1.hasRef === 'function');
    assert.equal(t1.hasRef(), false);                 // daemon 等价物：unref
    assert.equal(feishu.startNotifier({ dbPath: fx.dbPath }), null);
    clearInterval(t1);
    feishu.resetSenderStarted();
  } finally { fx.close(); }
});

test('attachPlan：建文档失败 ⇒ 留痕到 stderr 且不外抛（best-effort）；无会话 ⇒ 立即短路', async () => {
  const fx = setup('feishu-seam');
  const chunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  // 会话根改到夹具里（`sessparse.setSessionsRoot` 就是给这个用的）：单测绝不读真实 HOME
  const prevRoot = sessparse.dshSessionsRoot();
  sessparse.setSessionsRoot(path.join(fx.dir, 'sessions'));
  process.stderr.write = (c, ...rest) => { chunks.push(String(c)); return origWrite(c, ...rest); };
  try {
    const opts = { dbPath: fx.dbPath };
    // cfg=null ⇒ REST 车道第一行就抛「应用未配置」（**零网络**）⇒ 走留痕分支
    await feishu.attachPlan({ card_id: 1, qid: 'q', session_id: 'sid-不存在' },
      '对拍项目', null, '', opts);
    assert.ok(chunks.some((c) => c.includes('feishu docx: 建方案文档失败')),
      `应留痕到 stderr，实得：${JSON.stringify(chunks)}`);
    // 无 session_id ⇒ Python 同款短路：不建文档、不留痕
    chunks.length = 0;
    assert.equal(await feishu.attachPlan({ qid: 'q' }, 'P', null, '', opts), undefined);
    assert.deepEqual(chunks, []);
  } finally {
    process.stderr.write = origWrite;
    sessparse.setSessionsRoot(prevRoot);
    fx.close();
  }
});

test('dmInteractionCard：事件闸门/无绑定 ⇒ 直接返回，不发请求也不抛', async () => {
  const fx = setup('feishu-dm');
  try {
    const opts = { dbPath: fx.dbPath };
    await feishu.dmInteractionCard(fx.pid, { card_id: 1, kind: 'question' }, opts);
    db.setFeishuHook(fx.pid, 'http://127.0.0.1:7913/hook/p1', 'sec-p1', 'task_failed', 1, opts);
    await feishu.dmInteractionCard(fx.pid, { card_id: 1, kind: 'question' }, opts);
    assert.equal(rowsOf(fx, 'SELECT id FROM feishu_outbox').length, 0);   // DM 不走 outbox
  } finally { fx.close(); }
});
