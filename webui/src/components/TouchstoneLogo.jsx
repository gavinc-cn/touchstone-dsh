// Touchstone 徽标: 试金石石板 + 负形 T 字刻痕
// 意象: 圆角石板=试金石本体(试金留痕), 负形 T=品牌首字母刻痕
// 渐变取自皮肤变量 --logo-1/--logo-2, 双皮肤(starlight/classic)自动适配
export default function TouchstoneLogo({ size = 22 }) {
  return (
    <svg className="ts-logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id="tsLogoG" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" style={{ stopColor: 'var(--logo-1)' }} />
          <stop offset="1" style={{ stopColor: 'var(--logo-2)' }} />
        </linearGradient>
      </defs>
      {/* 单路径双子路径 + evenodd: 石板为实心块, T 字刻痕走负形(透出底层背景) */}
      <path fill="url(#tsLogoG)" fillRule="evenodd"
        d="M8.6 3H15.4A5.6 5.6 0 0 1 21 8.6V15.4A5.6 5.6 0 0 1 15.4 21H8.6A5.6 5.6 0 0 1 3 15.4V8.6A5.6 5.6 0 0 1 8.6 3Z
           M7.6 6.6H16.4V9.8H13.6V17.8H10.4V9.8H7.6Z" />
    </svg>
  )
}
