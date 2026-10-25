// 权限档位工具（前端）单测：动态跟随 DSH 宿主权限目录（2026-10-21）。
//
// 契约出处：.run/permission-dsh-align-contract.md §6.1（不进仓库）——
// 后端 GET /api/agents/presets 返回 {available, options:[{value,label,description}],
// default, default_label}；前端只做「展示层映射 + 现值兜底项」，不重复算宿主默认名。
// 重点覆盖：内置中文名、宿主自定义档（label/description 原样透传）、旧值 manual/yolo
// 兜底（auto 不再当旧档，见契约 §5.3 歧义裁决）、custom 哨兵、未知值原样回退、空值。
import { beforeEach, describe, expect, it } from 'vitest'
import {
  LEGACY_PERMISSION_ALIASES,
  builtinPermissionLabel,
  canonicalPermission,
  permissionDefaultLabel,
  permissionDesc,
  permissionItems,
  permissionLabel,
  permissionOption,
} from '../utils/permission'

import { setLang } from '../utils/i18n'
// 文案断言按中文跑（zh 直接返回中文 key）
beforeEach(() => setLang('zh'))

// 本机宿主目录（契约 §2 实测形状，后端已把 name/description 归一为 label/description）
const CATALOG_OPTIONS = [
  { value: 'read-only', label: '仅可查看', description: '只读运行；所有修改动作都需要审批。' },
  { value: 'workspace-write', label: '工作区内修改', description: '可修改工作区与允许的临时目录；更宽的操作需要审批。' },
  { value: 'danger-full-access', label: '完全权限', description: '不受沙箱限制，也不再弹审批。' },
  { value: 'path-rules', label: '路径规则', description: '项目内可读写；项目外读允许、写需审批；白名单直通；黑名单一律审批。' },
  { value: 'write-guard', label: '完全权限（拦截）', description: '完全权限底座；项目内/白名单写入直通；越界写入弹框确认并自动学习白名单；复杂命令由 AI 判定。' },
  { value: 'auto', label: '自动审查（实验）', description: '无沙箱运行；每次原生工具调用和 PTC 内层调用前由同一模型进行实验性审查。' },
]

describe('常量', () => {
  it('旧值别名只含 manual/yolo（auto 不再走旧别名）', () => {
    expect(LEGACY_PERMISSION_ALIASES).toEqual({
      manual: 'workspace-write',
      yolo: 'danger-full-access',
    })
    expect(LEGACY_PERMISSION_ALIASES.auto).toBeUndefined()
  })

  it('内置档中文产品名与契约逐字一致', () => {
    expect({
      'read-only': builtinPermissionLabel('read-only'),
      'workspace-write': builtinPermissionLabel('workspace-write'),
      'danger-full-access': builtinPermissionLabel('danger-full-access'),
      auto: builtinPermissionLabel('auto'),
    }).toEqual({
      'read-only': '仅可查看',
      'workspace-write': '工作区内修改',
      'danger-full-access': '完全权限',
      auto: '自动审查（实验）',
    })
  })
})

describe('canonicalPermission', () => {
  it('空值（含空白）归一为空串', () => {
    expect(canonicalPermission('')).toBe('')
    expect(canonicalPermission('   ')).toBe('')
    expect(canonicalPermission(null)).toBe('')
    expect(canonicalPermission(undefined)).toBe('')
  })

  it('旧值 manual/yolo 映射到宿主 preset key', () => {
    expect(canonicalPermission('manual')).toBe('workspace-write')
    expect(canonicalPermission('yolo')).toBe('danger-full-access')
  })

  it('auto 保持原样（实验档，不是旧别名）', () => {
    expect(canonicalPermission('auto')).toBe('auto')
  })

  it('preset key / 宿主自定义档 / 未知值原样保留（去首尾空白）', () => {
    expect(canonicalPermission('path-rules')).toBe('path-rules')
    expect(canonicalPermission(' workspace-write ')).toBe('workspace-write')
    expect(canonicalPermission('my-custom-preset')).toBe('my-custom-preset')
    expect(canonicalPermission('custom')).toBe('custom')
  })
})

describe('permissionOption', () => {
  it('按值命中目录项', () => {
    expect(permissionOption(CATALOG_OPTIONS, 'path-rules')).toEqual(CATALOG_OPTIONS[3])
  })

  it('旧值按 canonical 命中', () => {
    expect(permissionOption(CATALOG_OPTIONS, 'manual').label).toBe('工作区内修改')
    expect(permissionOption(CATALOG_OPTIONS, 'yolo').label).toBe('完全权限')
  })

  it('未命中/空值/空目录返回 null', () => {
    expect(permissionOption(CATALOG_OPTIONS, 'nope')).toBeNull()
    expect(permissionOption(CATALOG_OPTIONS, '')).toBeNull()
    expect(permissionOption([], 'read-only')).toBeNull()
    expect(permissionOption(undefined, 'read-only')).toBeNull()
  })
})

describe('permissionLabel', () => {
  it('空值回退到 fallback（默认「权限」）', () => {
    expect(permissionLabel(CATALOG_OPTIONS, '')).toBe('权限')
    expect(permissionLabel(CATALOG_OPTIONS, null)).toBe('权限')
    expect(permissionLabel(CATALOG_OPTIONS, undefined, '未读取')).toBe('未读取')
  })

  it('命中目录项时用目录 label（宿主自定义档原样透传）', () => {
    expect(permissionLabel(CATALOG_OPTIONS, 'path-rules')).toBe('路径规则')
    expect(permissionLabel(CATALOG_OPTIONS, 'write-guard')).toBe('完全权限（拦截）')
  })

  it('目录不可用（空数组）时内置 preset key 回退内置中文名', () => {
    expect(permissionLabel([], 'read-only')).toBe('仅可查看')
    expect(permissionLabel([], 'workspace-write')).toBe('工作区内修改')
    expect(permissionLabel([], 'danger-full-access')).toBe('完全权限')
    expect(permissionLabel([], 'auto')).toBe('自动审查（实验）')
  })

  it('旧值 manual/yolo 显示为映射后档位的中文名', () => {
    expect(permissionLabel([], 'manual')).toBe('工作区内修改')
    expect(permissionLabel([], 'yolo')).toBe('完全权限')
    // 目录里有映射后档位时，也用目录给的 label（宿主文案优先）
    expect(permissionLabel(
      [{ value: 'workspace-write', label: '宿主自定义工作区名', description: '' }], 'manual',
    )).toBe('宿主自定义工作区名')
  })

  it('custom（宿主当前配置的哨兵档）显示固定文案', () => {
    expect(permissionLabel([], 'custom')).toBe('自定义（宿主当前配置）')
    expect(permissionLabel(CATALOG_OPTIONS, 'custom')).toBe('自定义（宿主当前配置）')
  })

  it('未知值原样回退', () => {
    expect(permissionLabel([], 'my-custom-preset')).toBe('my-custom-preset')
    expect(permissionLabel(CATALOG_OPTIONS, 'my-custom-preset')).toBe('my-custom-preset')
  })
})

describe('permissionDesc', () => {
  it('命中目录项时取 description', () => {
    expect(permissionDesc(CATALOG_OPTIONS, 'path-rules')).toBe(CATALOG_OPTIONS[3].description)
  })

  it('旧值按 canonical 命中 description', () => {
    expect(permissionDesc(CATALOG_OPTIONS, 'manual')).toBe(CATALOG_OPTIONS[1].description)
  })

  it('未命中/空值/无描述回退空串（前端不补内置描述）', () => {
    expect(permissionDesc(CATALOG_OPTIONS, 'nope')).toBe('')
    expect(permissionDesc(CATALOG_OPTIONS, '')).toBe('')
    expect(permissionDesc([], 'read-only')).toBe('')
    expect(permissionDesc([{ value: 'x', label: 'X' }], 'x')).toBe('')
    expect(permissionDesc(undefined, 'x')).toBe('')
  })
})

describe('permissionDefaultLabel', () => {
  it('后端给了 default_label 时括注（如「默认（完全权限）」）', () => {
    expect(permissionDefaultLabel({ default: 'danger-full-access', default_label: '完全权限' }))
      .toBe('默认（完全权限）')
  })

  it('default_label 缺失/空/目录不可用时回退「默认（宿主默认）」', () => {
    expect(permissionDefaultLabel({ default: 'danger-full-access' })).toBe('默认（宿主默认）')
    expect(permissionDefaultLabel({ default_label: '' })).toBe('默认（宿主默认）')
    expect(permissionDefaultLabel({ available: false, options: [], default: '', default_label: '' }))
      .toBe('默认（宿主默认）')
    expect(permissionDefaultLabel(null)).toBe('默认（宿主默认）')
  })
})

describe('permissionItems', () => {
  it('空现值：原样返回目录选项', () => {
    expect(permissionItems(CATALOG_OPTIONS, '')).toEqual(CATALOG_OPTIONS)
    expect(permissionItems(CATALOG_OPTIONS, null)).toEqual(CATALOG_OPTIONS)
  })

  it('现值命中目录项：不追加兜底项（不重复）', () => {
    const items = permissionItems(CATALOG_OPTIONS, 'workspace-write')
    expect(items).toEqual(CATALOG_OPTIONS)
    expect(items.filter((o) => o.value === 'workspace-write')).toHaveLength(1)
  })

  it('现值不在目录：追加 canonical 兜底项（保证 Radix Select 不回退占位）', () => {
    const items = permissionItems(CATALOG_OPTIONS, 'my-custom-preset')
    expect(items).toHaveLength(CATALOG_OPTIONS.length + 1)
    expect(items.at(-1)).toEqual({
      value: 'my-custom-preset',
      label: 'my-custom-preset',
      description: '',
    })
    // 原数组不被就地修改
    expect(CATALOG_OPTIONS).toHaveLength(6)
  })

  it('旧值不在目录：兜底项 value 用 canonical preset（显示预置中文名）', () => {
    const items = permissionItems(CATALOG_OPTIONS.filter((o) => o.value !== 'workspace-write'), 'manual')
    // 去掉内置 workspace-write 后，兜底项追加为 canonical key + 内置中文名
    expect(items.at(-1)).toEqual({
      value: 'workspace-write',
      label: '工作区内修改',
      description: '',
    })
  })

  it('目录不可用（空/未定义）但现值非空：只出兜底项', () => {
    expect(permissionItems([], 'workspace-write')).toEqual([
      { value: 'workspace-write', label: '工作区内修改', description: '' },
    ])
    expect(permissionItems(undefined, 'path-rules')).toEqual([
      { value: 'path-rules', label: 'path-rules', description: '' },
    ])
  })

  it('custom 现值：兜底项 label 用固定文案', () => {
    const items = permissionItems([], 'custom')
    expect(items).toEqual([{ value: 'custom', label: '自定义（宿主当前配置）', description: '' }])
  })

  it('auto 现值不在目录时也补兜底项（显示实验档产品名）', () => {
    const items = permissionItems(CATALOG_OPTIONS.filter((o) => o.value !== 'auto'), 'auto')
    expect(items.at(-1)).toEqual({
      value: 'auto',
      label: '自动审查（实验）',
      description: '',
    })
  })
})
