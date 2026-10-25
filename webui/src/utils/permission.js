// 权限档位（DSH 宿主 preset catalog）展示层纯函数（2026-10-21）。
//
// 数据源＝后端 `GET /api/agents/presets`（见 .run/permission-dsh-align-contract.md
// §5.2/§6.1）：`{available, options:[{value,label,description}], default, default_label}`。
// 档位列表/顺序/标签/描述**动态跟随宿主目录**，前端只做两件事：
//   1. 展示层映射：内置三档宿主上报的 name 就是 machine value，中文产品名由客户端映射
//      （与 DSH 客户端 displayPermissionPreset 同规则）；旧库/旧帧的 manual/yolo 做显示兜底；
//   2. 现值兜底项：目录里没有当前值时补一条，保证 Radix Select 触发器不回退成占位符。
// 本模块**不参与写入**：项目弹窗/会话窗提交的都是宿主 preset key（`permission_mode`）。
import { t } from './i18n'

/** 旧三档 → 宿主 preset 的显示/兼容别名（auto 不在别名表：实验档按宿主目录的真实值走，
 *  契约 §5.3 歧义裁决；旧 auto 语义已由数据迁移消化） */
export const LEGACY_PERMISSION_ALIASES = {
  manual: 'workspace-write',
  yolo: 'danger-full-access',
}

/** 内置档产品名（宿主目录里查不到时兜底；auto 恒用产品名）；未命中返回空串。
 *  函数形式：t 在调用时按当前语言求值，语言切换后重新渲染即更新。 */
export function builtinPermissionLabel(value) {
  if (value === 'read-only') return t('仅可查看')
  if (value === 'workspace-write') return t('工作区内修改')
  if (value === 'danger-full-access') return t('完全权限')
  if (value === 'auto') return t('自动审查（实验）')
  return ''
}

/** 值归一：null/undefined/非字符串 → ''，去首尾空白 */
function text(v) {
  return v == null ? '' : String(v).trim()
}

/**
 * 归一权限值：'' 保持空；旧值 manual/yolo 映射到 preset key；其余原样（去首尾空白）。
 * auto 不做旧档映射（宿主目录里有 auto 档才合法，见契约 §5.3）。
 */
export function canonicalPermission(value) {
  const v = text(value)
  if (!v) return ''
  return LEGACY_PERMISSION_ALIASES[v] || v
}

/** 在宿主目录里按（canonical 后的）值找档位项；未命中返回 null */
export function permissionOption(options, value) {
  const v = canonicalPermission(value)
  if (!v || !Array.isArray(options)) return null
  return options.find((o) => o && text(o.value) === v) || null
}

/**
 * 档位展示名：
 * 空 → fallback；命中目录项 → 目录 label（宿主自定义档原样透传）；
 * canonical 命中内置档 → 内置中文产品名；custom → 固定文案；其余原样值。
 */
export function permissionLabel(options, value, fallback) {
  const opt = permissionOption(options, value)
  if (opt && opt.label) return opt.label
  const v = canonicalPermission(value)
  if (!v) return fallback || t('权限')
  const builtin = builtinPermissionLabel(v)
  if (builtin) return builtin
  if (v === 'custom') return t('自定义（宿主当前配置）')
  return v
}

/**
 * 档位描述：只取宿主目录给的 description（内置档描述由后端/宿主给，前端不重复维护）；
 * 未命中或没描述 → ''。
 */
export function permissionDesc(options, value) {
  const opt = permissionOption(options, value)
  return opt ? text(opt.description) : ''
}

/**
 * 项目弹窗哨兵项「默认」的展示文案：后端算好 default_label（契约 §5.2），前端只括注；
 * 目录不可用/没算出来 → 「默认（宿主默认）」。
 */
export function permissionDefaultLabel(catalog) {
  const label = text(catalog && catalog.default_label)
  return label ? t('默认（{label}）', { label }) : t('默认（宿主默认）')
}

/**
 * 下拉选项 = 宿主目录选项 + 现值兜底项。
 * 现值 canonical 后非空、且不在目录里 ⇒ 末尾追加一条兜底项
 * （label/description 走同一套展示层映射）——否则 Radix Select 找不到匹配项，
 * 触发器会退化成占位符，看着像没选中。
 */
export function permissionItems(options, value) {
  // 空 value 的目录项 Radix 不接受（SelectItem 值不能为空串），顺手过滤掉
  const list = Array.isArray(options) ? options.filter((o) => o && text(o.value)) : []
  const v = canonicalPermission(value)
  if (!v || list.some((o) => text(o.value) === v)) return list
  return [...list, {
    value: v,
    label: permissionLabel(list, v),
    description: permissionDesc(list, v),
  }]
}

/**
 * 任务详情「权限」行文案（2026-10-24 任务会话对齐卡片）：
 * 任务级权限档（tasks.permission）为空＝跟随项目默认；非空走展示层映射
 * （目录 label → 内置中文名 → 原值），与权限下拉同口径。
 */
export function permissionDetailLabel(options, value) {
  if (!canonicalPermission(value)) return t('跟随项目默认')
  return permissionLabel(options, value)
}

/**
 * 会话底栏「权限档 / 模型」两枚下拉的可交互判定（纯函数，2026-10-24 任务会话对齐卡片）：
 * 条件 = 有打开中的会话（board=看板卡片会话 / taskActive=任务会话窗口）且宿主能力位为真；
 * 权限档额外要求宿主权限目录非空（目录不可用时降级为只读 chip，展示名由
 * permissionLabel 的内置中文名兜底）。放在本文件：两枚控件同属会话级权限/模型配置，
 * 且都在本批由「仅看板卡」放开到任务会话。
 */
export function sessionControls({ board = false, taskActive = false, caps, permOpts } = {}) {
  const opened = !!board || !!taskActive
  return {
    modelInteractive: opened && !!(caps && caps.profile),
    permInteractive: opened && !!(caps && caps.permission) && (permOpts?.length || 0) > 0,
  }
}
