import {
  mkdtempSync,
  readdirSync,
  utimesSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function sessionDirectory(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-seed-session-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const root = realpathSync(
  fileURLToPath(new URL('../../demo/', import.meta.url)),
);

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// 只在测试进程替换模型响应，生产 CLI 始终创建 ZenMuxProvider。
const preload = `
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
os.homedir = () => process.cwd();
syncBuiltinESMExports();
import { ZenMuxProvider } from ${JSON.stringify(new URL('../src/providers/zenmux.js', import.meta.url).href)};
import { createMockProvider } from ${JSON.stringify(new URL('./mock-provider.js', import.meta.url).href)};
const provider = createMockProvider();
ZenMuxProvider.prototype.reply = provider.reply;
ZenMuxProvider.prototype.summarize = provider.summarize;
process.env.AGENT_SEED_ZENMUX_API_KEY = 'test';
process.env.ZENMUX_MODEL = 'test';
`;
const fixtureId = '11111111-1111-4111-8111-111111111111';
const sessionPath = (cwd: string, id = fixtureId) =>
  join(cwd, '.agent-seed/sessions', `${id}.json`);
const savedFiles = (cwd: string) =>
  readdirSync(join(cwd, '.agent-seed/sessions')).filter((name) =>
    name.endsWith('.json'),
  );

const cliArgs = [
  '--import',
  'data:text/javascript,' + encodeURIComponent(preload),
  cli,
];

test('CLI 多轮输入、空行、清空、退出与 EOF', (t) => {
  const cwd = sessionDirectory(t);
  const result = spawnSync(process.execPath, [...cliArgs], {
    input: '\n第一问\n第二问\n/clear\n第三问\n/exit\n不应执行\n',
    cwd,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout.match(/Mock 已完成/g) ?? []).length, 3);
  assert.doesNotMatch(
    result.stdout,
    /轮次|模型调用 \d|请求模型，历史|工具调用 (list_directory|read_file)|工具结果 \{/,
  );
  assert.match(result.stdout, /历史已清空/);

  const eof = spawnSync(process.execPath, [...cliArgs], {
    input: '读文档\n',
    cwd,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(eof.status, 0, eof.stderr);
  assert.match(eof.stdout, /Mock 已完成/);
});

test('带任务参数仍单次执行，保留模型调用次数上限退出码', (t) => {
  const cwd = sessionDirectory(t);
  const result = spawnSync(
    process.execPath,
    [...cliArgs, '--max-model-calls', '1', '读文档'],
    {
      cwd,
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /达到模型调用次数上限/);
});

test('CLI 手动压缩后可以继续对话、再次压缩和清空', (t) => {
  const cwd = sessionDirectory(t);
  const result = spawnSync(process.execPath, [...cliArgs], {
    input:
      '/compact\n第一问\n/compact\n第二问\n/compact\n/clear\n/compact\n/exit\n',
    cwd,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout.match(/上下文已压缩/g) ?? []).length, 1);
  assert.equal((result.stdout.match(/暂无需要压缩的历史/g) ?? []).length, 3);
  assert.equal((result.stdout.match(/Mock 已完成/g) ?? []).length, 2);
});

test('重启恢复历史，单次任务也保存，压缩和清空更新文件', (t) => {
  const cwd = sessionDirectory(t);
  let file = '';
  const run = (input: string, task?: string) => {
    const args = [...cliArgs, ...(file ? ['--resume', '--'] : [])];
    if (task) {
      args.push(task);
    }
    const result = spawnSync(process.execPath, args, {
      cwd,
      input,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    file ||= join(cwd, '.agent-seed/sessions', savedFiles(cwd)[0]);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.root, root);
    return saved.history;
  };

  const first = run('第一问\n/exit\n');
  const second = run('', '第二问');
  assert.deepEqual(second.slice(0, first.length), first);
  assert.equal(
    second.filter((message: any) => message.role === 'user').length,
    2,
  );

  const compacted = run('/compact\n/exit\n');
  assert.deepEqual(compacted.slice(2), second.slice(first.length));
  assert.deepEqual(compacted[0], first[0]);
  assert.match(compacted[1].content, /此前对话的摘要/);
  const continued = run('继续任务\n/exit\n');
  assert.deepEqual(continued.slice(0, compacted.length), compacted);

  const cleared = run('/clear\n/exit\n');
  assert.deepEqual(cleared, [first[0]]);
  assert.deepEqual(run('/exit\n'), cleared);
});

test('损坏的会话文件报错并保留原内容', (t) => {
  const cwd = sessionDirectory(t);
  mkdirSync(join(cwd, '.agent-seed/sessions'), { recursive: true });
  const file = sessionPath(cwd);
  for (const body of ['{broken', '{}', '[]', '[{"role":"invalid"}]']) {
    writeFileSync(file, body);
    const result = spawnSync(
      process.execPath,
      [...cliArgs, '--resume', fixtureId],
      {
        cwd,
        input: '不能覆盖\n',
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /会话文件格式无效/);
    assert.equal(readFileSync(file, 'utf8'), body);
  }
});

test('启动需要 ZenMux 配置，帮助信息不依赖配置且不再提供模式选择', (t) => {
  const cwd = sessionDirectory(t);
  const env = {
    ...process.env,
    AGENT_SEED_ZENMUX_API_KEY: '',
    ZENMUX_MODEL: '',
  };
  const missing = spawnSync(process.execPath, [cli, '任务'], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(missing.status, 1);
  assert.match(
    missing.stderr,
    /需要设置 AGENT_SEED_ZENMUX_API_KEY 和 ZENMUX_MODEL/,
  );

  const help = spawnSync(process.execPath, [cli, '--help'], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(help.status, 0);
  assert.doesNotMatch(help.stdout, /--mode|mock|AGENT_MODE/);
});

test('自动压缩成功后继续任务，并将压缩后的历史保存', (t) => {
  const cwd = sessionDirectory(t);
  mkdirSync(join(cwd, '.agent-seed/sessions'), { recursive: true });
  writeFileSync(
    sessionPath(cwd),
    JSON.stringify({
      root,
      history: [
        { role: 'system', content: '指令' },
        { role: 'user', content: '旧任务' },
        { role: 'assistant', content: '旧回答' },
      ],
    }),
  );
  const autoPreload =
    preload +
    `
    import { REQUEST_STATUS } from ${JSON.stringify(new URL('../src/types.js', import.meta.url).href)};
    const originalReply = ZenMuxProvider.prototype.reply;
    let first = true;
    ZenMuxProvider.prototype.reply = async function*(...args) {
      if (first) {
        first = false;
        yield { status: REQUEST_STATUS.BUDGET_EXCEEDED, message: '预算不足' }; return;
      }
      yield* originalReply.apply(this, args);
    };
  `;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'data:text/javascript,' + encodeURIComponent(autoPreload),
      cli,
      '--resume',
      '--',
      '读文档',
    ],
    {
      cwd,
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const history = JSON.parse(readFileSync(sessionPath(cwd), 'utf8')).history;
  assert.equal(history[0].role, 'system');
  assert.match(history[1].content, /此前对话的摘要/);
  assert.equal(history.at(-1).role, 'assistant');
  assert.match(history.at(-1).content, /Mock 已完成/);
});

test('请求失败显式退出且不保存，手动压缩失败保留会话并能继续输入', (t) => {
  const cwd = sessionDirectory(t);
  mkdirSync(join(cwd, '.agent-seed/sessions'), { recursive: true });
  const file = sessionPath(cwd);
  const original = JSON.stringify({
    root,
    history: [
      { role: 'system', content: '指令' },
      { role: 'user', content: '旧任务' },
      { role: 'assistant', content: '旧回答' },
      { role: 'user', content: '原任务' },
    ],
  });
  writeFileSync(file, original);
  const failures =
    preload +
    `
    import { REQUEST_STATUS, REQUEST_FAILURE } from ${JSON.stringify(new URL('../src/types.js', import.meta.url).href)};
    ZenMuxProvider.prototype.reply = async function*() {
      yield {status: REQUEST_STATUS.FAILED, reason: REQUEST_FAILURE.CONNECTION, message:'模型连接失败'};
    };
    ZenMuxProvider.prototype.summarize = async function() {
      return {status: REQUEST_STATUS.FAILED, reason: REQUEST_FAILURE.TIMEOUT, message:'摘要请求超时'};
    };
  `;
  const args = [
    '--import',
    'data:text/javascript,' + encodeURIComponent(failures),
    cli,
    '--resume',
  ];
  const failed = spawnSync(process.execPath, args, {
    cwd,
    input: '新任务\n',
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /模型连接失败/);
  assert.equal(readFileSync(file, 'utf8'), original);

  const compact = spawnSync(process.execPath, args, {
    cwd,
    input: '/compact\n/exit\n',
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(compact.status, 0);
  assert.match(compact.stderr, /上下文压缩失败：摘要请求超时/);
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('默认新建独立会话；最近恢复按目录筛选，等价路径可恢复', (t) => {
  const cwd = sessionDirectory(t);
  const directory = join(cwd, 'files');
  mkdirSync(directory);
  const alias = join(cwd, 'alias');
  symlinkSync(directory, alias, 'dir');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [...cliArgs, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 10000,
    });
  const first = run('--root', directory, '第一问');
  assert.equal(first.status, 0, first.stderr);
  const firstName = savedFiles(cwd)[0];
  const firstFile = join(cwd, '.agent-seed/sessions', firstName);
  const original = readFileSync(firstFile, 'utf8');
  const second = run('--root', directory, '第二问');
  assert.equal(second.status, 0, second.stderr);
  const secondName = savedFiles(cwd).find((name) => name !== firstName)!;
  const secondFile = join(cwd, '.agent-seed/sessions', secondName);
  assert.equal(
    JSON.parse(readFileSync(secondFile, 'utf8')).history.filter(
      (m: any) => m.role === 'user',
    ).length,
    1,
  );
  utimesSync(firstFile, 100, 100);
  utimesSync(secondFile, 200, 200);
  assert.equal(run('--root', cwd, '其他目录').status, 0);
  const resumed = run('--root', alias, '--resume', '--', '继续');
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /恢复会话/);
  assert.equal(
    JSON.parse(readFileSync(secondFile, 'utf8')).history.filter(
      (m: any) => m.role === 'user',
    ).length,
    2,
  );
  assert.equal(readFileSync(firstFile, 'utf8'), original);
  assert.equal(savedFiles(cwd).length, 3);
  const id = secondName.slice(0, -5);
  const specified = run('--resume', id, '--', '指定恢复');
  assert.equal(specified.status, 0, specified.stderr);
  assert.ok(specified.stdout.includes(realpathSync(directory)));
  const conflict = run('--root', cwd, '--resume', id);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /不一致/);
});

test('恢复失败明确报错，扫描跳过坏文件，默认新建忽略旧格式文件', (t) => {
  const cwd = sessionDirectory(t);
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [...cliArgs, ...args], {
      cwd,
      input: '/exit\n',
      encoding: 'utf8',
      timeout: 10000,
    });
  assert.match(run('--resume').stderr, /没有可恢复/);
  assert.match(run('--resume', fixtureId).stderr, /无法读取/);
  assert.match(run('--resume', '../escape').stderr, /UUID/);
  mkdirSync(join(cwd, '.agent-seed/sessions'), { recursive: true });
  const legacy = join(cwd, '.agent-seed/session.json');
  writeFileSync(legacy, 'old');
  writeFileSync(sessionPath(cwd), '{broken');
  const failed = run('--resume');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /跳过会话/);
  assert.equal(run().status, 0);
  assert.equal(readFileSync(legacy, 'utf8'), 'old');
  assert.equal(savedFiles(cwd).length, 1);
  const fresh = run('新任务');
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(run('--resume').status, 0);
  const id = savedFiles(cwd)
    .find((name) => name !== `${fixtureId}.json`)!
    .slice(0, -5);
  const file = sessionPath(cwd, id);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  saved.root = join(cwd, 'missing');
  writeFileSync(file, JSON.stringify(saved));
  const unavailable = run('--resume', id);
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stderr, /工作目录不可访问/);
});

test('最近会话时间相同时按 ID 排序，恢复只更新选中文件', (t) => {
  const cwd = sessionDirectory(t);
  mkdirSync(join(cwd, '.agent-seed/sessions'), { recursive: true });
  const ids = [fixtureId, '22222222-2222-4222-8222-222222222222'];
  const body = JSON.stringify({
    root,
    history: [{ role: 'system', content: '指令' }],
  });
  for (const id of ids) {
    writeFileSync(sessionPath(cwd, id), body);
    utimesSync(sessionPath(cwd, id), 100, 100);
  }
  const result = spawnSync(
    process.execPath,
    [...cliArgs, '--resume', '--', '继续'],
    {
      cwd,
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(ids[1]));
  assert.equal(readFileSync(sessionPath(cwd, ids[0]), 'utf8'), body);
  assert.equal(savedFiles(cwd).length, 2);
});
