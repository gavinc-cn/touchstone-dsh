/**
 * Node 后端命令行契约解析（backend/server.js 的入口参数）。
 *
 * 为什么单独一个模块：薄壳（dsh-plugin/lib/index.js）用**同一份 argv** 拉起 Python 与 Node
 * 两个后端（方案 §3.2），这份 argv 就是两版之间的接口；把它抽出来单独测，才能在不起进程的
 * 情况下钉死「默认值与 Python 侧 argparse 逐项一致」。
 *
 * 与 Python 侧的对应关系（server.py:_build_arg_parser，2026-10-11 复核）：
 *   --host        缺省 127.0.0.1（安全默认：仅本机）
 *   --port        缺省 4601（薄壳恒传 0 = 随机端口）
 *   --web-dir     缺省 `<仓库根>/webui/dist`，可被 TS_WEB_DIR 覆盖
 *   --trust-internal-user / --parent-watch  布尔开关
 *   --allow-shared-db  同库单实例闸的逃生口（M1 起解析：语义已由 backend/lib/lock.js 落地，
 *                      见 server.js 的取锁段；M0 曾**故意不解析**它——解析一个语义未实现的
 *                      开关等于静默说谎，现在实现到位，这个理由不再成立）
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * 仓库根 = 本文件上溯三级（<根>/backend/lib/args.js）。
 * 静态页缺省目录由它派生，与 Python 侧 `BASE_DIR/webui/dist` 同口径。
 */
export const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** 与 Python argparse 对齐的缺省监听地址与端口 */
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4601;

/** 把 node:util parseArgs 的英文错误码翻成可操作的中文提示（终端里直接能看懂） */
function describeParseError(error) {
  const code = error && error.code;
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    return new Error(`未知参数: ${error.message.replace(/^Unknown option\s*/, '')}`);
  }
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    return new Error(`参数缺少取值: ${error.message}`);
  }
  return new Error(`参数错误: ${(error && error.message) || error}`);
}

/**
 * 解析入口 argv（不含 node 可执行文件与脚本路径）。
 * 非法输入一律抛错：这个进程由薄壳拉起，静默兜底只会把「参数写错」变成「后端行为诡异」。
 */
export function parseBackendArgs(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        host: { type: 'string' },
        port: { type: 'string' },
        'web-dir': { type: 'string' },
        'trust-internal-user': { type: 'boolean' },
        'parent-watch': { type: 'boolean' },
        'allow-shared-db': { type: 'boolean' },
      },
    });
  } catch (error) {
    throw describeParseError(error);
  }
  const values = parsed.values;
  let port = DEFAULT_PORT;
  if (values.port !== undefined) {
    // parseArgs 没有数字类型，端口在这里显式校验（`abc` / `1.5` / 负数都要挡在启动之前）
    if (!/^\d+$/.test(values.port)) throw new Error(`端口必须是整数: ${values.port}`);
    port = Number(values.port);
    if (port > 65535) throw new Error(`端口越界(0-65535): ${values.port}`);
  }
  return {
    host: values.host === undefined ? DEFAULT_HOST : values.host,
    port,
    webDir: values['web-dir'] === undefined ? null : values['web-dir'],
    trustInternalUser: values['trust-internal-user'] === true,
    parentWatch: values['parent-watch'] === true,
    // 与 Python 的 `--allow-shared-db`（action="store_true"）同语义：缺省 false
    allowSharedDb: values['allow-shared-db'] === true,
  };
}

/**
 * 静态页目录解析：显式 --web-dir > 环境变量 TS_WEB_DIR > `<仓库根>/webui/dist`。
 * 优先级与 Python 侧一致（`WEB_DIR = os.environ.get("TS_WEB_DIR") or BASE_DIR/webui/dist`，
 * 显式参数在 main() 里覆盖它）。
 */
export function resolveWebDir(args, { env = process.env, repoRoot = REPO_ROOT } = {}) {
  if (args && args.webDir) return args.webDir;
  if (env && env.TS_WEB_DIR) return env.TS_WEB_DIR;
  return join(repoRoot, 'webui', 'dist');
}
