// 「飞书接入（扫码一键配置）」卡的两个闸门与提示文案（纯逻辑，无 React 依赖，可单测）。
//
// 后端 GET /api/me/feishu/provision 回 {supported, enabled, state, url, error, app_id, steps}，
// 两个布尔是**正交**的两件事，曾经被合成一个 disabled 喂给三个按钮（M9 修复）：
//   supported：本机后端有没有「扫码建应用」能力（探测运行时依赖，不是业务状态）。
//   enabled  ：配置自动化总开关（服务端 TS_FEISHU_PROVISION=0 时关掉所有写操作）。
// 拆细后的口径：
//   扫码创建飞书应用 = 写操作 + 依赖 supported ⇒ 两个闸门都过才可点；
//   补齐应用配置 / 提交发布 = 纯写操作，后端早已实现 ⇒ 只看 enabled（不被 supported 连坐）；
//   刷新状态 = 只读探测 ⇒ 只受 busy 影响（busy 是组件本地状态，不进本函数）。
// 注意 supported=false **不等于**「配置自动化已关闭」：两者语义不同，文案也不许混用。
import { t } from './i18n'

export function provisionGates(st) {
  const supported = !!st?.supported
  const enabled = !!st?.enabled
  return {
    supported,
    enabled,
    scanDisabled: !supported || !enabled,
    writeDisabled: !enabled,
    refreshDisabled: false,
  }
}

// 二维码链接的**双形态**读取（2026-10-15 M9-R2）。
//
// 后端 `provision_status()["url"]` 的形状**两版不同，而且这是 oracle 的既有事实**：
//   Python（oracle）：`feishu.py:3051` 的 `on_qr(url)` 是 `st["url"] = url or ""` —— 原样存
//     `lark_oapi` 回调给的那个 dict（`scene/registration:298` 调的是
//     `self._on_qr_code({"url": …, "expire_in": …})`）⇒ 响应里 `url` 是**对象**。
//   Node（移植件）：M9 起也**按 oracle 原样存**（之前写成取 `.url` 是无意偏离，
//     被实例级对拍用例 `m9_feishu_device_start` 抓出并改回）⇒ 同为对象。
// 两边都用对象，前端就得会拆；同时容忍字符串（历史响应、以及将来若有人把口径改回字符串）
// —— 这样**两版后端的面板都能用**：Python 侧原先直接渲染 `st.url` 会显示 `[object Object]`、
// 复制按钮复制出 `[object Object]`（真机上是坏的），本函数把这条一并修好。
export function provisionQrUrl(st) {
  const raw = st?.url
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object' && typeof raw.url === 'string') return raw.url
  return ''
}

// 提示文案（渲染顺序即数组顺序）。tone：warn=能力缺失（红），closed=总开关关闭（黄）。
// 关键：!supported 的文案必须后端无关（Node 后端下没有 lark-oapi 这个东西），
// 并说清"还剩什么能用"——只承诺 enabled 时仍然可用的动作。
export function provisionNotices(st) {
  const { supported, enabled } = provisionGates(st)
  const out = []
  if (!supported) {
    out.push({
      key: 'unsupported',
      tone: 'warn',
      text: enabled
        ? t('本机后端不具备「扫码创建应用」能力：扫码按钮不可用（这与「配置自动化被关掉」不是一回事）。仍可用「补齐应用配置」为已有应用补齐权限、事件订阅与回调，App ID / Secret 可在上方手工填写；或升级后端依赖后刷新本页重试扫码。')
        : t('本机后端不具备「扫码创建应用」能力：扫码按钮不可用（这与「配置自动化被关掉」不是一回事）。升级后端依赖后刷新本页可重试扫码。'),
    })
  }
  if (!enabled) {
    out.push({
      key: 'disabled',
      tone: 'closed',
      text: t('配置自动化已被 TS_FEISHU_PROVISION=0 关闭：可只跑自检，写操作不可用。'),
    })
  }
  return out
}
