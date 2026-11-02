# extensions/（平台内置资产清单根）

每个子目录一个资产 + 一份 `asset.json`；平台设置页「内置资产」按它列出、安装、卸载。
清单根可用环境变量 `TS_EXT_DIR` 覆盖（测试与自定义部署）。

## 现在为什么是空的

这里原本有唯一一个资产 `dsh-autocommit`（自动提交守卫：卡片一轮结束/挂起时把本会话改动落成提交）。
2026-11-01 起它**并进了本包**——以 `dsh-plugin/autocommit/index.mjs` 随包发布，由
`dsh-plugin/cordis.patch.yml` 的第二行（`id: dsh-autocommit`，模块名
`@gavinc-cn/touchstone-dsh/autocommit`）加载。

于是它不再需要「装一次」：装本包（`dsh plugin add` / `./dsh-plugin/install.sh`）就自带，
也就不该再走一遍内置资产安装——否则 profile 里会多出一条同 id 的注册行，
在组合树里被判成 unaddressable，且两份实例同时拦截。

能力本身没删：本目录、清单格式、`TS_EXT_DIR` 覆盖、状态四态与安装/卸载端点都还在。

## 加一个新资产

1. 建 `<id>/asset.json`（字段见 `doc_ai/spec/assets/内置资产安装.md` §2），
   `files` 里的 `from` 相对本目录、`to` 相对落点根；
2. `type: "skill"` 落 `~/.dsh/skills/`（或项目级 `<项目>/.dsh/skills/`）；
   `type: "dsh_plugin"` 只支持用户级，落 `<profiles>/node_modules/<package>/` 并写 profile 注册行；
3. 清单非法的资产直接报错（不静默跳过），所以改完跑一次
   `node --test backend/test/builtin-assets.test.mjs`。

> 分发形态的选择：**能随包下发的就用 bundle 行**（像 dsh-autocommit 现在这样，零步骤、面板可开关）；
> 这里只留给「必须拷进别的 profile 目录 / 不能在包内直接以模块身份加载」的东西。
