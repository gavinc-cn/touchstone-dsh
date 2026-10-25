// utils/dataLabels.js 单测：后端 canonical 中文数据值 → 英文显示映射（display-only）。
//   口径：canonical 值（status.md / bug_report.md 的「状态」字段）在英文界面映射为英文，
//   在中文界面仍是原文；未知/空值一律原样返回（降级不抛错）。持久化数据与分类逻辑不变。
import { describe, it, expect, beforeEach } from 'vitest'
import { setLang, t } from '../utils/i18n'
import {
  BUG_ANALYZE, BUG_ANALYZED, BUG_ANALYZED_TO_FIX, BUG_FIX_COMPLETE_PENDING_RETEST,
  BUG_FIXED_RETEST_PASSED, BUG_FIXED_UNVERIFIED, BUG_REJECTED, BUG_RETEST_FAILED,
  bugStatusLabel, caseStatusLabel, phaseLabel,
} from '../utils/dataLabels'

beforeEach(() => {
  setLang('en')
  localStorage.clear()
  setLang('en')
})

describe('caseStatusLabel：status.md 用例状态', () => {
  it('英文界面映射五个 canonical 状态', () => {
    expect(caseStatusLabel(t, '未执行')).toBe('Not run')
    expect(caseStatusLabel(t, '通过')).toBe('Pass')
    expect(caseStatusLabel(t, '失败')).toBe('Failed')
    expect(caseStatusLabel(t, '跳过')).toBe('Skipped')
    expect(caseStatusLabel(t, '需要复测')).toBe('Needs retest')
  })

  it('中文界面原样返回（显示层映射不改变中文数据值）', () => {
    setLang('zh')
    for (const raw of ['未执行', '通过', '失败', '跳过', '需要复测']) {
      expect(caseStatusLabel(t, raw)).toBe(raw)
    }
  })

  it('未知/空值回落原文，不抛错', () => {
    expect(caseStatusLabel(t, '进行中(自定义)')).toBe('进行中(自定义)')
    expect(caseStatusLabel(t, '')).toBe('')
    expect(caseStatusLabel(t, null)).toBe(null)
    expect(caseStatusLabel(t, undefined)).toBe(undefined)
    expect(caseStatusLabel(t, '通过（带后缀）')).toBe('通过（带后缀）')
  })

  it('调用方未注入翻译函数时退回原文（防御性，不崩）', () => {
    expect(caseStatusLabel(null, '通过')).toBe('通过')
    expect(caseStatusLabel(undefined, '失败')).toBe('失败')
  })
})

describe('bugStatusLabel：bug_report.md 报告状态', () => {
  it('英文界面映射 canonical 状态（含历史裸值「已修复」）', () => {
    expect(bugStatusLabel(t, '待分析')).toBe('To analyze')
    expect(bugStatusLabel(t, '已分析，待修复')).toBe('Analyzed, to fix')
    expect(bugStatusLabel(t, '已修复（未验证）')).toBe('Fixed (unverified)')
    expect(bugStatusLabel(t, '复测通过')).toBe('Retest passed')
    expect(bugStatusLabel(t, '已拒绝')).toBe('Rejected')
    expect(bugStatusLabel(t, '已分析')).toBe('Analyzed')
    expect(bugStatusLabel(t, '已修复（复测通过）')).toBe('Fixed (retest passed)')
    expect(bugStatusLabel(t, '复测未通过')).toBe('Retest failed')
    // 裸「已修复」是历史/手工写入值，现平台不写它（复测全通过的终态是
    // 「已修复（复测通过）」，修复任务默认路径写「修复完成，待复测」）
    expect(bugStatusLabel(t, '已修复')).toBe('Fixed')
  })

  it('修复任务默认路径写入的「修复完成，待复测」必须映射（否则英文界面漏中文）', () => {
    expect(bugStatusLabel(t, '修复完成，待复测')).toBe('Fix complete, pending retest')
  })

  it('中文界面原样返回', () => {
    setLang('zh')
    expect(bugStatusLabel(t, '已分析，待修复')).toBe('已分析，待修复')
    expect(bugStatusLabel(t, '复测未通过')).toBe('复测未通过')
  })

  it('未知/空值回落原文，不抛错', () => {
    expect(bugStatusLabel(t, '已拒绝（误报，非缺陷）')).toBe('已拒绝（误报，非缺陷）')
    expect(bugStatusLabel(t, '')).toBe('')
    expect(bugStatusLabel(t, null)).toBe(null)
    expect(bugStatusLabel(t, undefined)).toBe(undefined)
  })

  it('常量与持久化数据逐字一致（转义写法不改变运行值）', () => {
    expect(BUG_ANALYZE).toBe('待分析')
    expect(BUG_ANALYZED_TO_FIX).toBe('已分析，待修复')
    expect(BUG_FIX_COMPLETE_PENDING_RETEST).toBe('修复完成，待复测')
    expect(BUG_FIXED_UNVERIFIED).toBe('已修复（未验证）')
    expect(BUG_REJECTED).toBe('已拒绝')
    expect(BUG_ANALYZED).toBe('已分析')
    expect(BUG_FIXED_RETEST_PASSED).toBe('已修复（复测通过）')
    expect(BUG_RETEST_FAILED).toBe('复测未通过')
  })
})

describe('phaseLabel：live.json 的阶段标签', () => {
  it('英文界面映射平台自己写入的 phase_label（脚本复测 / 压力测试）', () => {
    expect(phaseLabel(t, '脚本复测')).toBe('Script retest')
    expect(phaseLabel(t, '压力测试')).toBe('Stress test')
  })

  it('英文界面映射流程文档定义的十个阶段中文名', () => {
    const stageEn = {
      复测: 'Retest', 角度: 'Angles', 盘点: 'Inventory', 生成: 'Generate',
      判重: 'Dedupe', 执行: 'Execute', 聚类: 'Cluster', 分析: 'Analyze',
      修复: 'Repair', 收尾: 'Wrap-up',
    }
    for (const [raw, en] of Object.entries(stageEn)) {
      expect(phaseLabel(t, raw)).toBe(en)
    }
  })

  it('中文界面原样返回（显示层映射不改变中文数据值）', () => {
    setLang('zh')
    for (const raw of ['脚本复测', '压力测试', '复测', '执行', '收尾']) {
      expect(phaseLabel(t, raw)).toBe(raw)
    }
  })

  it('agent 自写/未知标签回落原文，不抛错', () => {
    // agent 被要求写「当前阶段中文名」，措辞不受平台枚举约束：只认 canonical 全值，
    // 任何带修饰/自由发挥的写法都按 R14 回落原文（绝不猜、不前缀匹配）
    expect(phaseLabel(t, '阶段5 执行')).toBe('阶段5 执行')
    expect(phaseLabel(t, '正在执行用例')).toBe('正在执行用例')
    expect(phaseLabel(t, '')).toBe('')
    expect(phaseLabel(t, null)).toBe(null)
    expect(phaseLabel(t, undefined)).toBe(undefined)
    expect(phaseLabel(null, '脚本复测')).toBe('脚本复测')
  })
})
