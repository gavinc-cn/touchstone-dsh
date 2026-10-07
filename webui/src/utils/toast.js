// 轻量 toast: 单例元素, 自动消失
let el = null
let timer = null

export function toast(msg, ms = 2500) {
  if (!el) {
    el = document.createElement('div')
    el.className = 'ts-toast'
    document.body.appendChild(el)
  }
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(timer)
  timer = setTimeout(() => el.classList.remove('show'), ms)
}

