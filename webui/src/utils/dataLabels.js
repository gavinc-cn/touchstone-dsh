// 后端 canonical 中文数据值的显示层英文映射（2026-10-22 i18n T8 / 裁决 R14）。
//
// 为什么只做显示层：status.md 的用例状态与 bug_report.md 的报告状态是**持久化数据值**，
// 也是后端分类/门禁逻辑（bugStatus.js 按中文正则归类、复测/修复入口判定、统计聚合）的
// 输入。翻译入库或改后端会让历史数据、筛选、门禁全部对不上；因此 canonical 中文值原样
// 保留，仅在渲染时映射成当前语言的展示名。未知值（用户/历史自定义）原样返回——降级为
// 原文而不是报错，界面绝不因一条脏状态崩掉。
//
// 边界（精确匹配，刻意不做前缀/模糊匹配）：映射只认 canonical 全值。历史/用户自定义变体
// （如「已拒绝（误报，非缺陷）」「已分析，给出修复方案」）不会命中，按 R14 回落原文——
// 界面显示中文而不是报错/猜译，这是设计行为；若后续要覆盖这类变体，应补受控的 canonical
// 值，而不是改成 includes/startsWith（会误伤分类语义与历史数据）。
//
// 写法约定：canonical 常量用 \uXXXX 转义书写，避免被未翻译文案扫描器误计（扫描器只认
// 源码里直接书写的中文）；运行值与持久化数据逐字一致，注释保留原文供人工核对。
// 签名显式带 t：本模块不 import i18n，语言由调用方注入（不给 t 标识符任何遮蔽机会）。
import {
  BUG_FIXED, BUG_RETEST_PASS, CASE_FAIL, CASE_PASS, CASE_PENDING, CASE_RETEST,
  CASE_SKIP,
} from './taskEnums'
import { SEV_HIGH, SEV_LOW, SEV_MEDIUM } from './bugStatus'

// bug_report.md 状态（canonical 中文数据值，勿翻译）
export const BUG_ANALYZE = '\u5f85\u5206\u6790' // 待分析
export const BUG_ANALYZED_TO_FIX = '\u5df2\u5206\u6790\uff0c\u5f85\u4fee\u590d' // 已分析，待修复
export const BUG_FIXED_UNVERIFIED = '\u5df2\u4fee\u590d\uff08\u672a\u9a8c\u8bc1\uff09' // 已修复（未验证）
export const BUG_REJECTED = '\u5df2\u62d2\u7edd' // 已拒绝
export const BUG_ANALYZED = '\u5df2\u5206\u6790' // 已分析
export const BUG_FIXED_RETEST_PASSED =
  '\u5df2\u4fee\u590d\uff08\u590d\u6d4b\u901a\u8fc7\uff09' // 已修复（复测通过）
export const BUG_RETEST_FAILED = '\u590d\u6d4b\u672a\u901a\u8fc7' // 复测未通过
// 修复任务默认路径（end_stage 不是 analyze/retest）写入的 canonical 终态：
// backend_py/runner.py:1451 与 backend/lib/runner.js:2785 都会落这个值。
export const BUG_FIX_COMPLETE_PENDING_RETEST =
  '\u4fee\u590d\u5b8c\u6210\uff0c\u5f85\u590d\u6d4b' // 修复完成，待复测

// live.json 的 phase_label 里平台/流程文档定义的 canonical 中文阶段名（数据值，勿翻译）。
// 平台自己写入的只有两个：脚本复测（_script_live 的默认 label，runner.py:1677/1688）与
// 压力测试（压测各阶段收尾，runner.py:1744 等；backend/lib/runner.js 同源）。另外十个是
// builtin_prompts/free_style/flow.md 的阶段名——prompts.py:96 要求 agent 写「当前阶段
// 中文名」，这些就是平台文档规定的阶段中文名。只认 canonical 全值；agent 自由发挥的
// 写法（如「阶段5 执行」）一律回落原文（R14 降级不猜译）。
const PHASE_LABELS = [
  '\u811a\u672c\u590d\u6d4b', // 脚本复测
  '\u538b\u529b\u6d4b\u8bd5', // 压力测试
  '\u590d\u6d4b', // 复测
  '\u89d2\u5ea6', // 角度
  '\u76d8\u70b9', // 盘点
  '\u751f\u6210', // 生成
  '\u5224\u91cd', // 判重
  '\u6267\u884c', // 执行
  '\u805a\u7c7b', // 聚类
  '\u5206\u6790', // 分析
  '\u4fee\u590d', // 修复
  '\u6536\u5c3e', // 收尾
]

/**
 * 用例状态展示名：canonical 中文值 → 当前语言文案；未知/空值原样返回。
 * @param {(key: string) => string} t 翻译函数（调用方按当前语言注入）
 * @param {string} raw status.md「状态」字段的原始值
 * @returns {string} 展示文案（未知值即原始值）
 */
export function caseStatusLabel(t, raw) {
  if (typeof t !== 'function' || !raw) return raw
  const map = {
    [CASE_PENDING]: t('未执行'),
    [CASE_PASS]: t('通过'),
    [CASE_FAIL]: t('失败'),
    [CASE_SKIP]: t('跳过'),
    [CASE_RETEST]: t('需要复测'),
  }
  return Object.prototype.hasOwnProperty.call(map, raw) ? map[raw] : raw
}

/**
 * bug 报告状态展示名：canonical 中文值 → 当前语言文案；未知/空值原样返回。
 * @param {(key: string) => string} t 翻译函数（调用方按当前语言注入）
 * @param {string} raw bug_report.md「状态」字段的原始值
 * @returns {string} 展示文案（未知值即原始值）
 */
export function bugStatusLabel(t, raw) {
  if (typeof t !== 'function' || !raw) return raw
  const map = {
    [BUG_ANALYZE]: t('待分析'),
    [BUG_ANALYZED_TO_FIX]: t('已分析，待修复'),
    [BUG_FIXED_UNVERIFIED]: t('已修复（未验证）'),
    [BUG_RETEST_PASS]: t('复测通过'),
    [BUG_REJECTED]: t('已拒绝'),
    [BUG_ANALYZED]: t('已分析'),
    [BUG_FIXED_RETEST_PASSED]: t('已修复（复测通过）'),
    [BUG_RETEST_FAILED]: t('复测未通过'),
    [BUG_FIX_COMPLETE_PENDING_RETEST]: t('修复完成，待复测'),
    // 历史/手工写入的裸终态；现平台不写它（复测全通过的终态是「已修复（复测通过）」，
    // 修复任务默认路径写「修复完成，待复测」）。保留映射只为历史报告不裸中文。
    [BUG_FIXED]: t('已修复'),
  }
  return Object.prototype.hasOwnProperty.call(map, raw) ? map[raw] : raw
}

/**
 * bug 报告严重程度等级展示名（2026-10-25「测试报告等级划分」批次）：
 * canonical 高/中/低 → 当前语言文案；空值（字段缺失/无法识别）→「未分级」；
 * 未知自定义值原样返回（与状态映射同口径：精确匹配、不猜译、不崩）。
 * 数据侧 canonical 常量来自 `utils/bugStatus.js`（`\uXXXX` 转义书写，运行时逐字一致）。
 * @param {(key: string) => string} t 翻译函数（调用方按当前语言注入）
 * @param {string} raw 后端下发的 `severity`（canonical 中文或空串）
 * @returns {string} 展示文案
 */
export function severityLabel(t, raw) {
  if (typeof t !== 'function') return raw
  if (!raw) return t('未分级')
  const map = {
    [SEV_HIGH]: t('高'),
    [SEV_MEDIUM]: t('中'),
    [SEV_LOW]: t('低'),
  }
  return Object.prototype.hasOwnProperty.call(map, raw) ? map[raw] : raw
}

/**
 * 阶段标签展示名：live.json 的 canonical 中文 phase_label → 当前语言文案；未知值原样返回。
 * @param {(key: string) => string} t 翻译函数（调用方按当前语言注入）
 * @param {string} raw live.json 的 phase_label 原始值
 * @returns {string} 展示文案（agent 自写/未知标签即原始值）
 */
export function phaseLabel(t, raw) {
  if (typeof t !== 'function' || !raw) return raw
  return PHASE_LABELS.includes(raw) ? t(raw) : raw
}
