// 思考等级（dsh 宿主 reasoningEffort）的档位表与下拉选项派生（2026-10-04）。
//
// 数据源＝后端 /api/agents/models 的模型列表：每项带 `efforts: [{id,name}]` 与
// `default_effort`（由 dsh 插件透传宿主 modelCatalog 的 reasoning.efforts /
// defaultEffort，见 server._dsh_plugin_models）。**为什么必须按模型取**：宿主对
// 模型不支持的档位直接抛 UNSUPPORTED_REASONING_EFFORT（dsh-llm resolveCallConfig），
// 瞎列档位会让「思考等级」这种纯配置项变成起会话失败。
//
// 兜底：老版本插件/目录不可用时列表为空——此时回落内置全档表（档位名与 dsh 的
// pi-ai ThinkingLevel 一致），用户仍能配，宿主不支持时由后端 best-effort 记日志。

/** dsh 思考等级档位（升序；与 pi-ai 的 ModelThinkingLevel 同名；off=不思考） */
export const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 取档位展示名：**一律用原始字段值**（reasoningEffort id，如 `off`/`low`/`high`/`max`）。
 *
 * 2026-10-05 用户口径：档位名不做中文翻译——这些值就是配置/接口里的字段值，翻成
 * 「关闭/极简/很高」后与 dsh 界面、文档、报错信息对不上，排查时要来回换。宿主目录
 * 里那个首字母大写的 `name`（"Low"/"High"）同样不采用（它不是字段值）。
 * 未知档位（宿主自定义）原样回落 id。
 */
export function effortLabel(id) {
  return id || ''
}

/** 列表里按值（`provider/模型 id` 或裸 id）找模型项 */
function findModel(models, value) {
  const v = (value || '').trim()
  if (!v) return null
  return models.find((m) => m.name === v) || models.find((m) => m.name.endsWith('/' + v)) || null
}

/** 从模型目录里收集某一模型的档位 id（无则返回空数组） */
function effortsOf(model) {
  return ((model && model.efforts) || []).map((e) => e.id).filter(Boolean)
}

/**
 * 派生「思考等级」下拉选项。
 *
 * @param {object} modelOpts 模型目录 `{models:[{name,display_name,efforts,default_effort}], default}`
 * @param {string} modelValue 当前选中的模型值（`provider/模型 id`；空=智能体默认）
 * @returns {{options: Array<{value:string,label:string,title:string}>, defaultEffort:string,
 *            fromCatalog:boolean}}
 *   - options：档位选项（按升序排列；不含「默认」项——由调用方按 Radix 哨兵约定加）
 *   - defaultEffort：该模型的宿主默认档（可能为空＝无默认档，走 provider 默认）
 *   - fromCatalog：档位是否来自模型目录（false=回落内置全档表）
 */
export function effortChoices(modelOpts, modelValue) {
  const models = (modelOpts && modelOpts.models) || []
  const picked = findModel(models, modelValue)
  let ids = effortsOf(picked)
  if (!ids.length) {
    // 当前模型未知/目录没给档位：取全列表并集（用户在项目弹窗里还没选模型时也有的选）
    const union = []
    for (const m of models) {
      for (const id of effortsOf(m)) if (!union.includes(id)) union.push(id)
    }
    ids = union
  }
  const fromCatalog = ids.length > 0
  if (!fromCatalog) ids = EFFORT_ORDER.slice()
  // 有序：已知档位按 EFFORT_ORDER 升序在前，未知档位（宿主自定义）按原序追加在后
  const ordered = EFFORT_ORDER.filter((id) => ids.includes(id))
    .concat(ids.filter((id) => !EFFORT_ORDER.includes(id)))
  return {
    options: ordered.map((id) => ({
      value: id,
      label: effortLabel(id),          // 原始字段值（不做中文映射）
      title: `思考等级 ${id}`,          // 悬停提示也只报字段值，避免两套叫法
    })),
    defaultEffort: (picked && picked.default_effort) || '',
    fromCatalog,
  }
}

/**
 * 展示文本：空值＝默认档（有宿主默认档时括注**原始字段值**，如「默认（high）」）。
 *
 * @param {string} value 当前档位 id（'' = 未显式指定）
 * @param {string} defaultEffort 模型目录给的默认档（可空）
 */
export function effortText(value, defaultEffort = '') {
  if (!value) {
    return defaultEffort ? `默认（${effortLabel(defaultEffort)}）` : '默认'
  }
  return effortLabel(value)
}
