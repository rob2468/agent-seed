import { Session } from './session.js';
import { EXIT_CODE } from './exit-code.js';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ZenMuxProvider } from './providers/zenmux.js';

/**
 * 读取启动参数，创建模型服务和工具，启动会话。
 */
async function main() {
  // parseArgs 要求字符串选项必须带值，因此把不带 ID 的 --resume 改成 --resume=。
  // 空字符串表示恢复最近会话；遇到 -- 就停止处理，后面是用户的任务内容。
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length && args[index] !== '--'; index++) {
    // 只处理 --resume，其他参数交给 parseArgs。
    if (args[index] !== '--resume') {
      continue;
    }

    const next = args[index + 1];
    if (!next || next.startsWith('--')) {
      args[index] = '--resume=';
    }
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      resume: { type: 'string' }, // 未传则新建；空字符串恢复最近会话；UUID 恢复指定会话。
      root: { type: 'string' }, // 工具可访问的根目录，默认项目的 demo/。
      'max-model-calls': { type: 'string', default: '20' }, // 每轮最多调用模型的次数，默认 20，取值 1–20。
      help: { type: 'boolean' }, // 显示命令用法。
    },
  });
  if (values.help) {
    console.log(
      '用法：npm start -- [--root 目录] [--resume [ID]] [--max-model-calls 1..20] ["任务"]\n默认新建会话；--resume 恢复当前目录最近会话，--resume ID 恢复指定会话。带任务时使用 --resume -- "任务"。每轮默认最多调用模型 20 次。\n不带任务进入多轮会话：/compact 压缩上下文，/clear 清空历史，/exit 退出。',
    );
    return;
  }

  const task = positionals.join(' ');
  const maxModelCalls = Number(values['max-model-calls']);
  if (
    !Number.isInteger(maxModelCalls) ||
    maxModelCalls < 1 ||
    maxModelCalls > 20
  ) {
    throw new Error('maxModelCalls 必须是 1–20 的整数');
  }

  const root =
    values.root ?? fileURLToPath(new URL('../../demo/', import.meta.url));

  const key = process.env.AGENT_SEED_ZENMUX_API_KEY;
  const name = process.env.ZENMUX_MODEL;
  if (!key || !name) {
    throw new Error('需要设置 AGENT_SEED_ZENMUX_API_KEY 和 ZENMUX_MODEL');
  }
  // CLI 根据配置创建模型服务。
  const provider = new ZenMuxProvider(key, name);

  // Session 使用模型服务，管理会话历史和任务执行。
  const session = new Session(
    provider,
    root,
    maxModelCalls,
    values.resume === undefined ? undefined : values.resume || true,
    values.root !== undefined,
  );
  if (task) {
    process.exitCode = await session.runTask(task);
  } else {
    process.exitCode = await session.runSession();
  }
}

try {
  await main();
} catch (error) {
  // 只显示已处理的错误提示，避免泄露请求凭据。
  console.error(
    error instanceof Error && error.constructor === Error
      ? error.message
      : '执行失败，请检查参数、目录或模型连接配置。',
  );
  process.exitCode = EXIT_CODE.ERROR;
}
