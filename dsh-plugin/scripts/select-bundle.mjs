/**
 * 把本插件包名写进 dsh profile 的 `dsh.profile.bundles`（幂等）。
 *
 * 为什么需要它: 包内 `cordis.patch.yml` 只有在包名被选进 `dsh.profile.bundles` 时才会作为
 * bundle 层加载；而 `dsh plugin add` 只是 pnpm 的转发（`runPluginCommand` 直接跑 pnpm），
 * **不会**改 bundles —— dsh 侧改 bundles 的官方入口是 Plugins 面板的包开关（`setBundleEnabled`）。
 * 本脚本补上这一步，让 `install.sh` 一条命令装完即可用。
 *
 * 用法: node scripts/select-bundle.mjs <profile 的 package.json 路径> [包名=touchstone]
 * 退出码: 0 = 已是选中态或本次写入成功；1 = 参数缺失 / 读取失败 / 写入失败。
 * 写法与 dsh 的 `writeProfileManifest` 对齐: 2 空格 JSON + 尾换行, 保留其它字段与键序。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [manifestPath, bundleName = 'touchstone'] = process.argv.slice(2);
if (!manifestPath) {
  console.error('用法: node scripts/select-bundle.mjs <profile 的 package.json> [包名]');
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  console.error(`读取失败: ${manifestPath}: ${error.message}`);
  process.exit(1);
}

manifest.dsh = manifest.dsh ?? {};
manifest.dsh.profile = manifest.dsh.profile ?? {};
const bundles = (manifest.dsh.profile.bundles = manifest.dsh.profile.bundles ?? []);
if (bundles.includes(bundleName)) {
  console.log(`dsh.profile.bundles 已含 ${bundleName}, 跳过`);
  process.exit(0);
}

bundles.push(bundleName);
try {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
} catch (error) {
  console.error(`写入失败: ${manifestPath}: ${error.message}`);
  process.exit(1);
}
console.log(`已将 ${bundleName} 加入 dsh.profile.bundles: ${manifestPath}`);
