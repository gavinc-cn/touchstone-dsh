// dsh 宿主明暗外观探测（插件形态专用；独立形态自动降级）
//
// 背景：TS 作为 dsh 插件时，SPA 以**同源 iframe** 嵌在 dsh 的全屏面板里（见
// dsh-plugin/src/client.js 的 Panel）。dsh 的明暗开关没有对外协议，但它的落地形式是
// 宿主页 `<body data-ds-dark-theme>`（取值真源见 @deepseek-ai/dsh-client-ui-theme：
// 浅色画布 #fff / 深色 #151517，`--dsw-alias-*` 语义 token 明暗各一份）。
//
// 因此本模块直接读父文档 + MutationObserver 跟随，**无需宿主侧配合**——好处是只改 SPA，
// 不必重装插件包（install.sh）也不必重启 dsh web；跨域父窗口/独立形态读不到时回落
// 系统偏好 `prefers-color-scheme`。本模块只负责「读宿主 + 订阅变化」，
// 「偏好值 → 具体皮肤」的解析在 utils/skin.js。
//
// 全部函数对异常 fail-open：探测失败只当作「未知」，绝不让主题探测影响页面渲染。
const DARK_ATTR = 'data-ds-dark-theme'
/** 系统偏好媒体查询（宿主未知时的回落依据）。 */
const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * 取「宿主文档」（插件形态 = 父窗口的 document）。
 * @param win - 待探测的窗口，缺省为当前窗口（便于单测注入）。
 * @returns 宿主 document；独立形态（无父窗口）或跨域抛异常时为 null。
 */
export function hostDocument(win = window) {
  try {
    const parent = win?.parent
    if (!parent || parent === win) return null // 独立形态: 自己就是顶层窗口
    return parent.document || null
  } catch {
    return null // 跨域父窗口: 读 document 抛 SecurityError
  }
}

/**
 * 从宿主文档读明暗。
 * @param doc - 宿主文档（可为 null）。
 * @returns true=宿主深色 / false=宿主浅色 / null=未知（文档缺失或无 body）。
 */
export function readHostDark(doc) {
  try {
    if (!doc || !doc.body) return null
    return doc.body.hasAttribute(DARK_ATTR)
  } catch {
    return null
  }
}

/**
 * 系统是否偏好深色。
 * @param win - 待探测的窗口，缺省为当前窗口。
 * @returns 布尔；无 matchMedia 或抛异常一律 false（当作浅色）。
 */
export function prefersDark(win = window) {
  try {
    return !!win?.matchMedia?.(DARK_QUERY)?.matches
  } catch {
    return false
  }
}

/**
 * 解析「当前应当用深色还是浅色」：宿主已知则宿主优先（系统偏好不参与），
 * 宿主未知（独立形态/跨域/无 body）才回落系统偏好。
 * @param hostDoc - 宿主文档，缺省自动探测。
 * @param win - 用于系统偏好的窗口，缺省为当前窗口。
 * @returns 布尔。
 */
export function resolveDark(hostDoc = hostDocument(), win = window) {
  const host = readHostDark(hostDoc)
  return host === null ? prefersDark(win) : host
}

/**
 * 订阅「明暗外观变化」：宿主 body 的属性翻转、或（宿主未知时）系统偏好变化都会回调。
 * @param cb - 回调，入参为最新判定结果（布尔）。
 * @param hostDoc - 宿主文档，缺省自动探测。
 * @param win - 用于系统偏好的窗口，缺省为当前窗口。
 * @returns 退订函数（幂等；异常吞掉，绝不抛出）。
 */
export function subscribeHostTheme(cb, hostDoc = hostDocument(), win = window) {
  const offs = []
  const emit = () => {
    try { cb(resolveDark(hostDoc, win)) } catch { /* 订阅者异常只吞自己 */ }
  }

  // 宿主侧: 监听 <body data-ds-dark-theme> 的增删(dsh 切外观就是改这一个属性)
  const body = hostDoc?.body
  if (body && typeof MutationObserver !== 'undefined') {
    try {
      const mo = new MutationObserver(emit)
      mo.observe(body, { attributes: true, attributeFilter: [DARK_ATTR] })
      offs.push(() => mo.disconnect())
    } catch { /* 观察不了就只留系统偏好通道 */ }
  }

  // 系统侧: 宿主未知时才是判定依据, 但挂上无副作用(宿主已知时 emit 里宿主优先)
  if (readHostDark(hostDoc) === null) {
    try {
      const mql = win?.matchMedia?.(DARK_QUERY)
      if (mql?.addEventListener) {
        const onSys = () => emit()
        mql.addEventListener('change', onSys)
        offs.push(() => mql.removeEventListener('change', onSys))
      }
    } catch { /* 无 matchMedia: 静默 */ }
  }

  return () => {
    for (const off of offs) {
      try { off() } catch { /* 退订异常不影响调用方 */ }
    }
    offs.length = 0
  }
}
