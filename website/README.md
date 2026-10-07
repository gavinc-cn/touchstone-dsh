# Touchstone 官网（website/）

中英双语产品官网 + 一个可在浏览器里玩的在线 Demo，纯静态、零构建、无第三方依赖：
直接用浏览器打开 `index.html` 即可，也可以挂在任意静态服务器上。

```
website/
├── index.html          英文版（站点默认入口，挂站点根 `/`）
├── zh.html             中文版（与 index.html 同骨架，中英层级倒置）
├── en.html             跳转壳（0 秒转到 `/`；只为改版前的旧链接 /en.html 不 404）
├── demo.html           在线 Demo（中文，可玩模拟器）
├── en-demo.html        在线 Demo（英文）
├── favicon.ico         站点图标（16/32/48 三档；file:// 直开与老浏览器用）
├── assets/
│   ├── site.css        主站样式（设计 token + 布局 + 响应式）
│   ├── site.js         一件事：首屏看板的卡片入场动画
│   ├── favicon.svg     站点图标（矢量，现代浏览器用）
│   ├── apple-touch-icon.png  iOS 主屏图标（180×180，满幅不透明）
│   ├── og-zh.png       分享卡片（中文，1200×630）＝ og:image
│   ├── og-en.png       分享卡片（英文，1200×630）＝ og:image
│   ├── demo/
│   │   ├── i18n.js     Demo 的全部可见文案（中英字典 + T() 取值）
│   │   ├── engine.js   Demo 的模拟引擎（队列 / 调度 / 会话 / 任务 / 产物）
│   │   ├── ui.js       Demo 的渲染与交互
│   │   └── demo.css    Demo 的产品界面样式
│   └── fonts/*.woff2   自托管字体子集（按全站实际用字切片）
└── tools/
    ├── fetch_fonts.py  字体子集生成器（改了文案要重跑）
    ├── make_icons.py   三个图标文件的生成器（改了图形/配色要重跑）
    ├── og_card.html    分享卡片的设计源（1200×630，可直接用浏览器打开看）
    └── make_og.py      把 og_card.html 渲成两张 og:image
```

## 本地预览

```bash
cd website && python3 -m http.server 4610
# 打开 http://127.0.0.1:4610/
```

直接双击 `index.html`（`file://`）也能看，但字体与内页链接按相对路径解析，
建议还是走本地服务器。

## 线上发布

线上地址：<https://gavinc-cn.github.io/touchstone-dsh/>

由公开仓的 `.github/workflows/pages.yml` 在 `website/` 有改动时自动发布（GitHub Actions
发布 `_site` 暂存目录：只带 HTML 页面与 `assets/`，本 README 与 `tools/` 不上站）。

- 站点内部全用相对路径，挂在 `/<仓库名>/` 子路径下**无需改任何文件、不需要设 base**。
- 新增页面/资源放进 `website/` 即自动带上；只改 `README.md` 或 `tools/` 不会触发发布。
- 首次或异常时：仓库 `Settings → Pages → Source` 必须是 **GitHub Actions**——选「Deploy from
  a branch」时 Pages 会用 Jekyll 把仓库根 `README.md` 渲染成首页，站点就显示成 README；
  也可在 Actions 页手动 `Run workflow` 重发。

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

**首页是英文版（2026-10-07 中英角色互换）**：站点根 `/` = `index.html`（英文），中文版在
`zh.html`；旧的 `/en.html` 只剩一个 0 秒跳转壳（`noindex` + canonical 指向根），只为改版前
分享出去的链接不 404。改语言角色时下面这些必须一起改，漏一处就会出现「点 EN 回到中文」或
被搜索引擎判成重复页：`canonical` / `hreflang`（`en`、`zh-CN`、`x-default`）/ `og:url` 三处
绝对 URL；顶栏语言条与页脚「Language / 语言」列；`demo.html`「← 返回官网」→ `zh.html`、
`en-demo.html`「← Back to site」→ `./`；以及 `tools/fetch_fonts.py` 的 `PAGES`。

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
Fraunces / IBM Plex Sans / JetBrains Mono）。全站 11 个文件合计 667 KB，用字 805 个
（中日韩 707 个）。拉丁字族只请求非中日韩字符。

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

### 5. 站点图标与链接预览（favicon / og:image）是生成物，改图形配色要重跑脚本

这两样都不在页面正文里，所以最容易漏：

- **站点图标**：标签页、书签栏、历史记录、手机「添加到主屏」用的那张小图。
- **链接预览图**：把链接粘进微信 / 飞书 / Slack / X / Telegram / Discord 时，平台爬虫
  来读 `<head>` 里的 `og:image`，拿它当卡片的缩略图。**它们不认 SVG**，所以卡片必须是
  栅格图（1200×630，各平台通用的 1.91:1）。

```bash
python3 tools/make_icons.py            # 生成 assets/favicon.svg + favicon.ico + apple-touch-icon.png
python3 tools/make_icons.py --check    # 核对三个文件有没有漂移（不重渲染）
python3 tools/make_og.py               # 把 tools/og_card.html 渲成 assets/og-zh.png / og-en.png
python3 tools/make_og.py --check       # 核对两张图的存在、尺寸、以及 token 是否与 site.css 一致
```

两个脚本都依赖 Playwright + Chromium（`pip install -r requirements-dev.txt &&
python3 -m playwright install chromium`）；`make_icons.py` 缺 Playwright 时仍会写出
`favicon.svg`（矢量部分是纯标准库）。

图标与字标同源：`make_icons.py` 里那枚「圆角方块 + 负形 T」的几何就是从产品字标
（`webui/src/components/TouchstoneLogo.jsx`，24 单位原稿）按比例算出来的，只有两处偏差——
方块放大到几乎满画布、T 的笔画加粗 20%——都是为 16px 让路。**改图形改配色都改脚本**，
别直接改 `favicon.svg`（`--check` 会报漂移）。

四条维护约定：

1. **`og:image` / `twitter:image` 必须写绝对 URL**，爬虫不解析相对路径。换域名要改的是
   每个 HTML 的 head（含 `rel="canonical"` 与 `hreflang`）——正文四页 + 一个跳转壳，共五个文件：
   `https://gavinc-cn.github.io/touchstone-dsh/`。
2. **`og:title` 与页面 `<title>` 同值，`og:description` 是另写的短版**（`<meta name="description">`
   偏长，卡片上会被截断）。只维护页面标题这一处，别让两串文案各自漂移。
3. **浏览器在「页面没给 link」时的兜底请求打的是源站根** `/favicon.ico`——本站挂在
   `/touchstone-dsh/` 子路径下，那个地址不属于本站，放文件也管不到。所以真正生效的永远是
   HTML 里那几行 `<link rel="icon">`；根目录那份 `favicon.ico` 只服务于 `file://` 直开与老浏览器。
4. **分享卡的设计 token 抄自 `site.css`**，两边是同一批值：`make_og.py` 每次出图前都会逐值
   核对，不一致直接报错拒绝出图——防止「站点换了色、分享卡还是旧色」。

分享卡只画三层：字标、与首屏同一句话、产品那张看板的五列（列名照抄 `BoardTab.jsx`，
不放数字与文案，免得看图的人把示意图当成真实数据）。**Demo 两页沿用同一张卡**，
没有为它们单独出图；卡片换了要重跑 `make_og.py`。

## 无障碍与降级

- 全站可 Tab 到达导航与语言互链，`:focus-visible` 有 2px 星金描边
- 看板是纯展示件：「开始 ▾」这类示意按钮是 `<span>`，不会被当成可操作控件
- `prefers-reduced-motion: reduce` 下不播入场动画，卡片直接显示终态
- 窄屏（≤860px）看板由五列并排改为两列一行，≤640px 单列到底（所有卡片照常显示，
  列头计数与可见卡片数始终一致）
- 无 JS：看板与全部正文照常显示（卡片隐藏态写在 `.js` 前缀下）

验收口径（16 例：两版 × 1440/1024/820/390 × 常规/reduced-motion）：逐例对照上面五条
无障碍与降级约定检查一遍。

另加两类：

- **元数据**（正文四页：`index.html` / `zh.html` / `demo.html` / `en-demo.html`）：`og:*` /
  `twitter:*` 齐备且 `og:url` == `rel="canonical"`、`twitter:image` == `og:image`；
  `og:image` 取得到且是 1200×630；三条 `<link>` 图标（`.ico` / `.svg` / apple-touch）
  都能解析到 200。跳转壳 `en.html` 另按三条单独断言：有 `meta refresh` 指向 `./`、
  `noindex`、`canonical` == 站点根。
- **Demo 两页冒烟**：1440 与 390 下无控制台报错、无 ≥400 请求、无横向溢出。

因为浏览器在 headless 下**不会主动去要** `/favicon.ico`，光跑页面级断言是测不出图标缺没缺的，
必须另外直接请求那几个 URL。
