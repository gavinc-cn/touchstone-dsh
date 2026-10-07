// 会话输入框的 / 指令 token 探测（纯函数, 无副作用）
// 定义: token = 光标位置向左到行首/最近空白之间的连续非空白文本, 且以 '/' 开头
// 用途: onSlashSelect 替换 token、send 本地路由判断, 与 SlashMenu 的 query/打开态
// 返回 {start, text} | null; start = token 在 input 中的起始下标(含 '/'), text = 含 '/' 的 token 原文
export function findSlashToken(input, caret) {
  const left = input.slice(0, caret)
  // 从 caret 向左扫到行首或空白; 若该 token 以 '/' 开头:
  const m = left.match(/(?:^|\s)(\/[^\s]*)$/)
  return m ? { start: caret - m[1].length, text: m[1] } : null
}
