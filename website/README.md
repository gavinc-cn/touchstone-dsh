# Touchstone 官网（website/）

中英双语产品官网 + 一个可在浏览器里玩的在线 Demo，纯静态、零构建、无第三方依赖：
直接用浏览器打开 `index.html` 即可，也可以挂在任意静态服务器上。

```
website/
├── index.html          中文版（默认入口）
├── en.html             英文版（与 index.html 同骨架，中英层级倒置）
├── demo.html           在线 Demo（中文，可玩模拟器）
├── en-demo.html        在线 Demo（英文）
├── assets/
│   ├── site.css        主站样式（设计 token + 布局 + 响应式）
│   ├── site.js         一件事：首屏看板的卡片入场动画
│   ├── demo/
│   │   ├── i18n.js     Demo 的全部可见文案（中英字典 + T() 取值）
│   │   ├── engine.js   Demo 的模拟引擎（队列 / 调度 / 会话 / 任务 / 产物）
│   │   ├── ui.js       Demo 的渲染与交互
│   │   └── demo.css    Demo 的产品界面样式
│   └── fonts/*.woff2   自托管字体子集（按全站实际用字切片）
└── tools/fetch_fonts.py  字体子集生成器（改了文案要重跑）
```

## 本地预览

```bash
cd website && python3 -m http.server 4610
# 打开 http://127.0.0.1:4610/
```

直接双击 `index.html`（`file://`）也能看，但字体与内页链接按相对路径解析，
建议还是走本地服务器。

## 在线 Demo（demo.html / en-demo.html）

从主站顶栏、首屏 CTA、上手章节与页脚都能点进去。**它不连后端**：不发任何网络请求、
不写 localStorage（只记皮肤与字号两项偏好）、刷新即回初始状态。

它是「模拟引擎 + 产品界面复刻」：队列、门禁、作答送达、七阶段任务、产物与监控都是真的会推进的
状态机，文案照抄产品源码，卡片数据是编的。机制细节与验收口径见下文各节；这里只讲三条维护约定：

### A. Demo 的文案在 `assets/demo/i18n.js` 里，改文案就改那一份

两个 HTML 只是壳（顶栏 + 挂载点 + 脚本标签），界面由 `ui.js` 按状态生成。语言开关仍是
`<html class="lang-en">`（与主站同一套机制），给两个语言各写一份字典：
`TS_I18N.zh` 与 `TS_I18N.en`，取用一律走 `T('a.b.c')`（缺键回落中文，再缺就把键名画出来）。

新增文案后跑一次键审计（临时脚本即可）：抽出 `engine.js` / `ui.js` 里全部 `T('…')`，
逐个在中英两本字典里解析，任何一边缺失就报出来。

改完文案记得重跑字体脚本（见约定 3）。

### B. 机械规则要跟产品源码对齐，不要凭印象写

引擎里每条机械规则都在代码注释里标了出处（`assets/demo/engine.js` 注明「与 server.py /
board.py / waitq.py 的判定同构」）：五列门禁、
挂起即让位、答卷优先补位、容器迁移即出队、任务上映三列、后段任务连带创建 …
产品改行为时回来改引擎，别让 demo 变成过时演示。

### C. 演示覆盖范围写在页面里，别偷偷缩小

登录页与「覆盖说明」弹窗各有一份**已覆盖 / 未覆盖**清单。新增能力要同时更新这两处文案，
两处的清单必须保持一致。

## 几个必须知道的约定

### 1. 两版共用一套 CSS，靠 `class="lang-en"` 倒置中英层级

`<html lang="zh-CN">` 与 `<html lang="en" class="lang-en">` 使用同一份 HTML 骨架与同一份
`site.css`。英文版给根元素加 `lang-en`，CSS 末尾那一组 `.lang-en ...` 规则把「中文为主、
拉丁为副」整体翻转成「拉丁为主、中文为副」（页边竖排标签、看板列名、六类任务行首）。

新增需要分语言的样式时，请沿用这个做法，不要再写第二份 CSS。

### 2. 首屏那块看板是照着产品前端复刻的，两个 HTML 里各存一份

首屏不放示意图，放产品自己的开发看板（五列卡片）。它是内联手写的静态复刻件：
没有数据、没有请求、点击无行为。

**文案要照抄产品前端，不要自己改写**：

| 看板上的东西 | 出处 |
|--------------|------|
| 五列列名 | `webui/src/components/BoardTab.jsx` 的 `COLUMNS` |
| 队列徽标（排队中 / 等待作答 / 会话运行中…） | `webui/src/utils/queueBadge.js` 的 `QUEUE_STATE_LABEL` |
| 操作按钮（开始 / ⚡ 强制 / 停止 / 通过 / 打回 / 重开） | `BoardTab.jsx` 卡片操作行 |
| 快速添加框 placeholder | `BoardTab.jsx` 的 `QuickAdd` |

卡片的**内容是示意**（卡号、标题、轮次、提问措辞都是编的例子），但**每个徽标、每个列名、
每条机制描述都必须能在代码里找到出处**。产品前端加了新徽标/新列，这里要跟上。

两块 HTML 各有一份逐字节相同的看板副本，改结构要两处同步改。

### 3. 字体是「按页面用字切片」的自托管子集，改文案要重跑脚本

`assets/fonts/` 里的 woff2 不是完整字库，而是用 Google Fonts 的 `text=` 接口按**全站用字**
切出来的（四个页面 + `assets/demo/i18n.js` 的字符串字面量；中文宋体两个字重、中文黑体三个字重、
Fraunces / IBM Plex Sans / JetBrains Mono）。全站 11 个文件合计约 668 KB，用字 807 个
（中日韩 709 个）。拉丁字族只请求非中日韩字符。

```bash
python3 tools/fetch_fonts.py            # 重新切片并落盘（改了文案就重跑）
python3 tools/fetch_fonts.py --measure  # 只报告每个切片多大，不落盘
python3 tools/fetch_fonts.py --verify   # 落盘并核对是否覆盖页面用字（需要 fontTools）
```

两条容易踩的：① 单次 `text=` 请求有编码长度上限（实测 ~6550 字符），超了 Google 会改回
上百个 unicode-range 切片、脚本只能拿到 2.7 KB 的第一片 —— 现在自动分批请求 + `fontTools.merge`
合并；② emoji 与几何符号已从请求里滤掉（它们本就该走系统 emoji 字体）。

**忘了重跑不会白屏**：`site.css` 的字体栈末尾留了 `PingFang SC / Microsoft YaHei / system-ui`
兜底，新增的字会用系统字体渲染，只是与其余文字的字形不一致（看起来「跳字」）。
所以改完文案请顺手跑一次脚本。

新加的特殊字符先看 `--verify` 的缺字报告：emoji（`🤔`/`🌿`/`⚡`）与 `↻` 本来就该走系统字体，
不用管；**几何符号（`▾` 之类）不在任何字族里**，要用 CSS 画（见 `.bd-caret`）或换字符。

字体来源：Google Fonts（Noto Serif SC / Noto Sans SC / Fraunces / IBM Plex Sans /
JetBrains Mono），均为 SIL OFL 或 Apache-2.0 许可，随站点自托管分发。

### 4. 页面里的文字都是真的

官网上的能力描述、看板机制、阶段名、目录结构、边界清单、命令，全部取自仓库现状
（`README.md`、`server.py` 的 `STAGES` / `STAGE_MATRIX`、
`webui/src/components/BoardTab.jsx`、`webui/src/utils/queueBadge.js`、
`builtin_prompts/free_style/flow.md`、`prompts.py` 的任务类型说明）。
**改产品行为时要回来对一遍官网文案**，不要让它成为过时宣传。

## 无障碍与降级

- 全站可 Tab 到达导航与语言互链，`:focus-visible` 有 2px 星金描边
- 看板是纯展示件：「开始 ▾」这类示意按钮是 `<span>`，不会被当成可操作控件
- `prefers-reduced-motion: reduce` 下不播入场动画，卡片直接显示终态
- 窄屏（≤860px）看板由五列并排改为两列一行，≤640px 单列到底（所有卡片照常显示，
  列头计数与可见卡片数始终一致）
- 无 JS：看板与全部正文照常显示（卡片隐藏态写在 `.js` 前缀下）

验收口径（16 例：两版 × 1440/1024/820/390 × 常规/reduced-motion）：逐例对照上面五条
无障碍与降级约定检查一遍。
