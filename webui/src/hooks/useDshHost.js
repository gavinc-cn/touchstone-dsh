// dsh 宿主能力 hook：把 lib/dshHost 的外部订阅面接到 React（useSyncExternalStore）。
// 面板形态下面板打开后宿主应答 caps → 相关按钮出现；独立形态恒 null（不渲染 dsh 按钮）。
// 服务端快照用 () => null：SSR 下没有 window，按「无宿主」渲染，避免水合不一致。
import { useSyncExternalStore } from 'react'
import { subscribeDshHost, getDshHostCaps } from '../lib/dshHost'

/** 宿主能力（null=不在 dsh 插件面板里）。 */
export function useDshHostCaps() {
  return useSyncExternalStore(subscribeDshHost, getDshHostCaps, () => null)
}
