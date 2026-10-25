import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
  link,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { createTools } from '../src/tools.js';
import { confirmWrite } from '../src/confirm-write.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'agent-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function call(path: string, content = '新内容') {
  return {
    id: 'write-1',
    type: 'function' as const,
    function: {
      name: 'write_file',
      arguments: JSON.stringify({ path, content }),
    },
  };
}

test('确认前不修改文件，确认后创建或完整覆盖，拒绝和缺少确认不写入', async (t) => {
  const root = await fixture(t);
  const execute = await createTools(root);
  const file = join(root, 'note.txt');
  assert.equal((await execute(call('note.txt'))).ok, false);
  await assert.rejects(access(file));
  const create = await createTools(root, async (path, content, overwrite) => {
    assert.equal(path, 'note.txt');
    assert.equal(content, '新内容');
    assert.equal(overwrite, false);
    await assert.rejects(access(file));
    return true;
  });
  assert.equal((await create(call('note.txt'))).ok, true);
  assert.equal(await readFile(file, 'utf8'), '新内容');

  const refuse = await createTools(root, async (_, __, overwrite) => {
    assert.equal(overwrite, true);
    assert.equal(await readFile(file, 'utf8'), '新内容');
    return false;
  });
  assert.equal((await refuse(call('note.txt', '短'))).ok, false);
  assert.equal(await readFile(file, 'utf8'), '新内容');

  const approve = await createTools(root, async () => true);
  assert.equal((await approve(call('note.txt', '短'))).ok, true);
  assert.equal(await readFile(file, 'utf8'), '短');
});

test('拒绝越界、链接、二进制、超长内容和确认后变化的文件', async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await writeFile(join(outside, 'outside.txt'), '外部');
  await symlink(join(outside, 'outside.txt'), join(root, 'link.txt'));
  await symlink(outside, join(root, 'dir'));
  await link(join(outside, 'outside.txt'), join(root, 'hard.txt'));
  await writeFile(join(root, 'binary'), Buffer.from([0, 255]));
  const execute = await createTools(root, async () =>
    assert.fail('非法目标不能请求确认'),
  );
  for (const path of [
    '../outside.txt',
    join(outside, 'outside.txt'),
    'link.txt',
    'dir/new.txt',
    'hard.txt',
    'binary',
    '.',
    'missing/file.txt',
  ]) {
    const result = await execute(call(path));
    assert.equal(result.ok, false, path);
  }
  assert.equal((await execute(call('large.txt', '文'.repeat(6000)))).ok, false);
  assert.equal(await readFile(join(outside, 'outside.txt'), 'utf8'), '外部');

  await writeFile(join(root, 'change.txt'), '原内容');
  const changeDuringConfirmation = await createTools(root, async () => {
    await writeFile(join(root, 'change.txt'), '确认期间发生变化');
    return true;
  });
  const result = await changeDuringConfirmation(call('change.txt'));
  assert.equal(result.ok, false);
  assert.equal(
    await readFile(join(root, 'change.txt'), 'utf8'),
    '确认期间发生变化',
  );
});

test('确认时取消不写入，等待确认时取消后还能读取下一条输入', async (t) => {
  const root = await fixture(t);
  const controller = new AbortController();
  const execute = await createTools(root, async (_, __, ___, signal) => {
    assert.equal(signal, controller.signal);
    controller.abort();
    return true;
  });
  assert.equal(
    (await execute(call('cancel.txt'), controller.signal)).ok,
    false,
  );
  await assert.rejects(access(join(root, 'cancel.txt')));

  const stream = new PassThrough();
  const input = createInterface({ input: stream });
  t.after(() => input.close());
  const lines = input[Symbol.asyncIterator]();
  const waiting = new AbortController();
  const approval = confirmWrite(
    input,
    lines,
    'cancel.txt',
    '内容',
    false,
    waiting.signal,
  );
  waiting.abort();
  await assert.rejects(approval, { name: 'AbortError' });
  stream.write('下一轮\n');
  assert.equal((await lines.next()).value, '下一轮');
});

for (const mode of [
  'interactive-yes',
  'interactive-no',
  'single-yes',
  'single-eof',
]) {
  test(`CLI ${mode} 展示写入并把结果交给模型`, async (t) => {
    const root = await fixture(t);
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const preload = `
      import os from 'node:os';
      import { syncBuiltinESMExports } from 'node:module';
      os.homedir = () => process.cwd();
      syncBuiltinESMExports();
      import { Completions } from ${JSON.stringify(import.meta.resolve('openai/resources/chat/completions'))};
      Completions.prototype.create = async function(body) {
        let message;
        let reason;
        if (body.messages.at(-1).role === 'tool') {
          const result = JSON.parse(body.messages.at(-1).content);
          message = {role:'assistant', content: result.ok ? '写入完成' : '模型收到拒绝'};
          reason = 'stop';
        } else {
          message = {role:'assistant', content:null, tool_calls:[{id:'write-1', type:'function', function:{name:'write_file', arguments:JSON.stringify({path:'note.txt', content:'完整内容'})}}]};
          reason = 'tool_calls';
        }
        if (body.stream) {
          return {
            controller: new AbortController(),
            async *[Symbol.asyncIterator]() {
              const delta = { ...message };
              if (delta.tool_calls) {
                delta.tool_calls = delta.tool_calls.map((call, index) => ({ ...call, index }));
              }
              yield {id:'test', object:'chat.completion.chunk', created:0, model:'test', choices:[{index:0, delta, finish_reason:reason}], usage:{total_tokens:100}};
            },
          };
        }
        return {choices:[{finish_reason:reason,message}],usage:{total_tokens:100}};
      };
    `;
    const args = [
      '--import',
      `data:text/javascript,${encodeURIComponent(preload)}`,
      cli,
      '--root',
      root,
    ];
    let input = '写文件\ny\n/exit\n';
    if (mode === 'interactive-no') {
      input = '写文件\nn\n/exit\n';
    }
    if (mode.startsWith('single')) {
      args.push('写文件');
      input = mode === 'single-yes' ? 'y\n' : '';
    }
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      input,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        AGENT_SEED_ZENMUX_API_KEY: 'test',
        ZENMUX_MODEL: 'test',
        ZENMUX_CONTEXT_WINDOW: '128000',
        ZENMUX_MAX_OUTPUT_TOKENS: '2048',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /写入路径：note.txt/);
    assert.match(result.stdout, /覆盖已有文件：否/);
    assert.match(result.stdout, /完整内容/);
    const saved = JSON.parse(
      await readFile(
        join(
          root,
          '.agent-seed/sessions',
          `${result.stdout.match(/会话：([0-9a-f-]+)/)![1]}.json`,
        ),
        'utf8',
      ),
    );
    assert.equal(saved.history.filter((m: any) => m.role === 'user').length, 1);
    if (mode.endsWith('yes')) {
      assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), '完整内容');
      assert.match(result.stdout, /写入完成/);
    } else {
      await assert.rejects(access(join(root, 'note.txt')));
      assert.match(result.stdout, /模型收到拒绝/);
    }
  });
}
