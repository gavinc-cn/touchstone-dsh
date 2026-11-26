// 目录重复冲突分类（2026-11-26 多用户）：
// 后端只把"其他用户"的重复判为不可保存；同用户重复仍是"提醒但可保存"。
// 这里只做展示分类，权威仍是后端 400。
export function hasCrossUserDuplicate(dups, username) {
  const me = String(username || '')
  return (Array.isArray(dups) ? dups : []).some((d) => d && d.username && d.username !== me)
}
