import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

// shadcn 标准工具: 合并类名, tailwind-merge 去重冲突类
export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

