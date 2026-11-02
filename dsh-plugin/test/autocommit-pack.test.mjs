/**
 * 自动提交守卫（dsh-autocommit）的**打包契约** —— 它随本包发，不再是一个单独装的内置资产。
 *
 * 为什么要专门钉住：这个插件对用户只有一条加载路径 —— dsh 读本包 `dsh.bundle.patch`
 * （`dsh-plugin/cordis.patch.yml`）的第二行，按**包内子路径**
 * `@gavinc-cn/touchstone-dsh/autocommit` 去 profile 的 node_modules 里 import。
 * 三处（patch 行名 / package.json 的 exports / files 白名单）任何一处对不上，
 * 后果都只出现在用户的宿主日志里：「该行加载失败」或「卡片挂起时不再落提交」，
 * 本地跑站点、跑后端测试全都看不见。所以这里全部钉成判据。
 *
 * 与 `dsh-plugin/scripts/prepack-check.mjs` 的分工：那个是发版前的钩子（同一个事实，
 * 但只在 npm pack 时跑）；这里是日常 `npm run test:plugin-client` 就跑到。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkPackClosure } from '../lib/pack-closure.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PATCH = fs.readFileSync(path.join(ROOT, 'dsh-plugin', 'cordis.patch.yml'), 'utf8');
const SUBPATH = `${PKG.name}/autocommit`;

test('bundle patch 声明两行：Touchstone 自身 + 自动提交守卫（子路径名）', () => {
  assert.ok(PATCH.includes('id: touchstone-dsh') && PATCH.includes(`name: "${PKG.name}"`),
    '第一行（Touchstone 薄壳）不见了或包名不一致');
  assert.ok(PATCH.includes('id: dsh-autocommit') && PATCH.includes(`name: "${SUBPATH}"`),
    '第二行（自动提交守卫）不见了或 name 不是包内子路径');
  // 只数真条目行（注释里也提到这个 id，别把散文算进去）
  assert.equal(PATCH.match(/^\s*-\s*id: dsh-autocommit$/gm)?.length ?? 0, 1, '同一个行 id 只能声明一次');
});

test('exports["./autocommit"] 指向真实文件，且该目录在 files 白名单里', () => {
  const rel = PKG.exports?.['./autocommit']?.default ?? PKG.exports?.['./autocommit'];
  assert.equal(rel, './dsh-plugin/autocommit/index.mjs', 'exports["./autocommit"] 的路径变了');
  assert.ok(fs.existsSync(path.join(ROOT, rel)), `导出指向的文件不存在: ${rel}`);
  const closure = checkPackClosure(ROOT);
  assert.ok(closure.ok, `files 白名单漏了运行时文件: ${JSON.stringify(closure.missing)}`);
  assert.ok(
    closure.closure.files.includes('dsh-plugin/autocommit/index.mjs'),
    'dsh-plugin/autocommit/index.mjs 不在 files 展开结果里（装机后行加载会失败）',
  );
});

test('插件源码导出 apply / name / inject（子路径加载时的契约面）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'dsh-plugin', 'autocommit', 'index.mjs'), 'utf8');
  assert.match(src, /export function apply\(/, '缺 apply(ctx, config)');
  assert.match(src, /export const name = 'dsh-autocommit'/, 'name 导出变了');
  assert.match(src, /export const inject = \['sessionProjections'\]/, 'inject 声明变了');
  assert.equal(src.length > 0, true);
});

test('仓库不再自带同名内置资产（否则同 id 两份实例同时拦截）', () => {
  const ext = path.join(ROOT, 'extensions');
  const withManifest = fs.existsSync(ext)
    ? fs.readdirSync(ext).filter((n) => fs.existsSync(path.join(ext, n, 'asset.json')))
    : [];
  assert.deepEqual(withManifest, [], `extensions/ 下还有资产: ${withManifest.join(', ')}（自动提交守卫已随包发）`);
});
