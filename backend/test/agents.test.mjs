/**
 * backend/lib/agents.js 的测试（M3 只覆盖归族读口 `agentFamily`）。
 *
 * 判据来源：`agents.py:134-162` 的判定链逐条对上，重点是三条最容易写反的：
 *   ① `dsh-plugin:` 前缀必须**先于** basename 判（该串不是有效可执行路径）；
 *   ② 裸 `dsh`（basename == dsh）**归退场族**，不是归插件族；
 *   ③ 空 `agent_path` 与未知名字**归 dsh_plugin**（默认族收敛，不是报错）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  agentFamily, DSH_PLUGIN_PREFIX, LEGACY_WEB_PREFIXES, PLUGIN_ENTRY_NAME,
  RETIRED_FAMILY, RETIRED_MSG,
} from '../lib/agents.js';

test('agentFamily：dsh 插件前缀优先于 basename（含前缀后跟可执行路径）', () => {
  assert.equal(agentFamily('dsh-plugin:'), 'dsh_plugin');
  assert.equal(agentFamily('dsh-plugin:/usr/local/bin/dsh'), 'dsh_plugin');
  assert.equal(agentFamily('  dsh-plugin:/x/dsh  '), 'dsh_plugin', '两端空白先 strip');
  assert.equal(agentFamily(DSH_PLUGIN_PREFIX + 'kimi'), 'dsh_plugin', '前缀胜出，不做名字判定');
});

test('agentFamily：退场族（旧虚拟前缀 / 旧 CLI 名 / 裸 dsh）', () => {
  for (const prefix of LEGACY_WEB_PREFIXES) {
    assert.equal(agentFamily(`${prefix}/usr/bin/x`), RETIRED_FAMILY, prefix);
  }
  for (const name of ['kimi', 'opencode', 'claude', 'hermes', 'deepseek', 'dsh']) {
    assert.equal(agentFamily(`/usr/local/bin/${name}`), RETIRED_FAMILY, name);
    assert.equal(agentFamily(name.toUpperCase()), RETIRED_FAMILY, `${name} 大小写不敏感`);
  }
});

test('agentFamily：空/未知/undefined 归 dsh_plugin（默认族收敛）', () => {
  assert.equal(agentFamily(''), 'dsh_plugin');
  assert.equal(agentFamily('   '), 'dsh_plugin');
  assert.equal(agentFamily(null), 'dsh_plugin');
  assert.equal(agentFamily(undefined), 'dsh_plugin');
  assert.equal(agentFamily('/opt/some/other-agent'), 'dsh_plugin');
});

test('常量与 Python 逐字一致（它们是跨语言契约：文案直接展示给用户）', () => {
  assert.equal(RETIRED_FAMILY, 'retired');
  assert.equal(RETIRED_MSG, '该智能体族已下线，请在项目设置里改绑 dsh 插件');
  assert.equal(PLUGIN_ENTRY_NAME, 'dsh（插件·进程内）');
});
