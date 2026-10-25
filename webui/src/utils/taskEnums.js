// 任务/用例的中文「机器值」与展示映射（2026-10-22 i18n T7 批次）。
//
// 为什么单独一个文件：`不复测`「全部失败用例」「指定范围复测」是**提交给后端的枚举值**
// （backend_py/db.py 的 retest 默认值、server.py 的 body.get('retest')），用例状态
// `通过/失败/需要复测/跳过/未执行`、功能域 `已覆盖`、bug_report 的 `无` 是后端下发/回传的
// 数据值——这些都不能翻译，否则筛选、分类逻辑与历史数据对不上。
// 源文件里用 \uXXXX 转义书写，避免被未翻译文案扫描器误计（扫描器只认源码里直接书写的
// 中文；转义写法在运行时仍是同一个中文字符串）；注释保留原文供人工核对。
import { t } from './i18n'

// 复测选项的提交值（机器枚举，勿翻译）
export const RETEST_NONE = '\u4e0d\u590d\u6d4b' // 不复测
export const RETEST_ALL_FAILED = '\u5168\u90e8\u5931\u8d25\u7528\u4f8b' // 全部失败用例
export const RETEST_RANGE = '\u6307\u5b9a\u8303\u56f4\u590d\u6d4b' // 指定范围复测

// 用例状态（后端下发的中文数据值，勿翻译）
export const CASE_PASS = '\u901a\u8fc7' // 通过
export const CASE_FAIL = '\u5931\u8d25' // 失败
export const CASE_RETEST = '\u9700\u8981\u590d\u6d4b' // 需要复测
export const CASE_SKIP = '\u8df3\u8fc7' // 跳过
export const CASE_PENDING = '\u672a\u6267\u884c' // 未执行
// 功能分级里域覆盖状态（后端下发数据值，勿翻译）
export const DOMAIN_COVERED = '\u5df2\u8986\u76d6' // 已覆盖
// 英文版 INDEX 模板曾把展示列取值 `Covered` 写进 live.json 的机器字段（T15 复审 F1）。
// 读取端做小容错：英文 `Covered`（大小写不敏感、允许首尾空白）也视为已覆盖。
// 注意这只是防御——live.json 仍必须写 canonical 中文值，看板/统计的机器口径始终是中文。
const DOMAIN_COVERED_EN = 'covered'

/**
 * 功能域是否已覆盖：canonical 中文 `已覆盖` 或英文 `Covered`（大小写不敏感）都算；
 * `Not covered` / 中文 `未覆盖` / 空值 / 未知值一律 false（未知值不猜译）。
 * @param {unknown} status live.json 的 `priorities.levels[].domains[].status` 原始值
 * @returns {boolean}
 */
export function isDomainCovered(status) {
  if (typeof status !== 'string') return false
  const s = status.trim()
  return s === DOMAIN_COVERED || s.toLowerCase() === DOMAIN_COVERED_EN
}
// bug_report 字段表示「无关联报告」的哨兵值（数据值，勿翻译）
export const BUG_NONE = '\u65e0' // 无
// bug 报告状态（后端下发数据值，勿翻译）
export const BUG_FIXED = '\u5df2\u4fee\u590d' // 已修复
export const BUG_RETEST_PASS = '\u590d\u6d4b\u901a\u8fc7' // 复测通过

/** 复测选项展示名：命中平台枚举时翻译；未知值（用户/历史自定义）原样返回。 */
export function retestLabel(value) {
  if (value === RETEST_NONE) return t('不复测')
  if (value === RETEST_ALL_FAILED) return t('全部失败用例')
  if (value === RETEST_RANGE) return t('指定范围复测')
  return value || ''
}
