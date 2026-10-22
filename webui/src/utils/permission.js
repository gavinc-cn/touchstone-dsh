// 权限档位（DSH 宿主 preset catalog）展示层纯函数（2026-10-21）。
//
// 数据源＝后端 `GET /api/agents/presets`（见 .run/permission-dsh-align-contract.md
// §5.2/§6.1）：`{available, options:[{value,label,description}], default, default_label}`。
// 档位列表/顺序/标签/描述**动态跟随宿主目录**，前端只做两件事：
//   1. 展示层映射：内置三档宿主上报的 name 就是 machine value，中文产品名由客户端映射
//      （与 DSH 客户端 displayPermissionPreset 同规则）；旧库/旧帧的 manual/yolo 做显示兜底；
//   2. 现值兜底项：目录里没有当前值时补一条，保证 Radix Select 触发器不回退成占位符。
// 本模块**不参与写入**：项目弹窗/会话窗提交的都是宿主 preset key（`permission_mode`）。

/** 旧三档 → 宿主 preset 的显示/兼容别名（auto 不在别名表：实验档按宿主目录的真实值走，
 *  契约 §5.3 歧义裁决；旧 auto 语义已由数据迁移消化） */
export const LEGACY_PERMISSION_ALIASES = {
  manual: 'workspace-write',
  yolo: 'danger-full-access',
}

/** 内置档中文产品名（宿主目录里查不到时兜底；auto 恒用产品名） */
export const BUILTIN_PERMISSION_LABELS = {
  'read-only': '仅可查看',
  'workspace-write': '工作区内修改',
  'danger-full-access': '完全权限',
  auto: '自动审查（实验）',
}

/** 宿主当前配置的哨兵档（自动审查等宿主自定义组合下的展示名） */
const CUSTOM_PERMISSION_LABEL = '自定义（宿主当前配置）'

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
export function permissionLabel(options, value, fallback = '权限') {
  const opt = permissionOption(options, value)
  if (opt && opt.label) return opt.label
  const v = canonicalPermission(value)
  if (!v) return fallback
  if (BUILTIN_PERMISSION_LABELS[v]) return BUILTIN_PERMISSION_LABELS[v]
  if (v === 'custom') return CUSTOM_PERMISSION_LABEL
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
  return label ? `默认（${label}）` : '默认（宿主默认）'
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
