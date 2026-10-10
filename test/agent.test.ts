import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTools, MAX_FILE_BYTES } from '../src/tools.js';
import { runAgent } from '../src/agent-loop.js';
import { createMock } from '../src/mock.js';
import type { Model, Message } from '../src/types.js';

async function fixture(t: TestContext) {
  const base = await mkdtemp(path.join(tmpdir(), 'agent-seed-'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const root = path.join(base, 'root');
  await mkdir(root);
  await writeFile(
    path.join(root, 'welcome.md'),
    '测试内容：工具真的读取了文件',
  );
  return { base, root, execute: await createTools(root) };
}

const call = (name: string, p: string) => ({
  id: 'x',
  name,
  arguments: JSON.stringify({ path: p }),
});

test('mock 完整循环保留请求、结果和最终回答', async (t) => {
  const { execute } = await fixture(t);
  const result = await runAgent('读文档', createMock(), execute);
  assert.equal(result.status, 'answered');
  assert.match(result.answer, /测试内容/);
  assert.deepEqual(
    result.history.map((m) => m.role),
    ['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'],
  );

  const tools = result.history.filter((m) => m.role === 'tool');
  assert.deepEqual(
    tools.map((m) => m.callId),
    ['list-1', 'read-1'],
  );
});

test('参数、未知工具、路径穿越、符号链接越界与文件大小限制', async (t) => {
  const { base, root, execute } = await fixture(t);
  await writeFile(path.join(base, 'outside.txt'), 'outside');
  await symlink(path.join(base, 'outside.txt'), path.join(root, 'escape'));
  await symlink(base, path.join(root, 'escape-dir'));
  await symlink(path.join(root, 'welcome.md'), path.join(root, 'safe-link'));

  await writeFile(path.join(root, 'large'), Buffer.alloc(MAX_FILE_BYTES + 1));
  await writeFile(path.join(root, 'exact'), Buffer.alloc(MAX_FILE_BYTES, 65));
  await writeFile(path.join(root, 'invalid-utf8'), Buffer.from([255]));

  for (const p of [
    '../outside.txt',
    '/etc/passwd',
    'escape',
    'escape-dir/outside.txt',
    'missing',
    'large',
    '.',
    'invalid-utf8',
  ]) {
    assert.equal((await execute(call('read_file', p))).ok, false, p);
  }

  for (const args of [
    '{',
    '{}',
    'null',
    '[]',
    '{"path":1}',
    '{"path":""}',
    '{"path":".","extra":1}',
  ]) {
    assert.equal(
      (await execute({ id: 'x', name: 'read_file', arguments: args })).ok,
      false,
      args,
    );
  }

  assert.equal((await execute(call('shell', '.'))).ok, false);
  assert.equal((await execute(call('list_directory', 'escape-dir'))).ok, false);

  assert.equal((await execute(call('read_file', 'safe-link'))).ok, true);
  assert.equal((await execute(call('read_file', 'exact'))).ok, true);
});

test('目录输出有界', async (t) => {
  const { root, execute } = await fixture(t);
  await Promise.all(
    Array.from({ length: 102 }, (_, i) =>
      writeFile(path.join(root, `file-${i}`), ''),
    ),
  );

  const result = await execute(call('list_directory', '.'));
  assert.equal(result.ok, true);
  if (result.ok) {
    const data = result.data as { entries: string[]; truncated: boolean };
    assert.equal(data.entries.length, 100);
    assert.equal(data.truncated, true);
  }
});

test('工具错误也放回历史，模型可继续回答', async (t) => {
  const { execute } = await fixture(t);

  let seen: readonly Message[] = [];
  const model: Model = {
    async reply(history) {
      seen = [...history];
      if (history.length === 2) {
        return {
          role: 'assistant',
          content: '',
          calls: [call('read_file', '../outside')],
        };
      }

      return { role: 'assistant', content: '路径错误已收到', calls: [] };
    },
  };

  const result = await runAgent('错误演示', model, execute);
  assert.equal(result.status, 'answered');
  assert.match(seen.at(-1)!.content, /"ok":false/);
});

test('最大步数阻止无限循环，非法上限拒绝', async (t) => {
  const { execute } = await fixture(t);

  let requests = 0;
  const model: Model = {
    async reply() {
      requests++;
      return {
        role: 'assistant',
        content: '',
        calls: [call('list_directory', '.')],
      };
    },
  };

  assert.equal(
    (await runAgent('循环', model, execute, 2)).status,
    'step_limit',
  );
  assert.equal(requests, 2);

  for (const limit of [0, 21, NaN, 1.5]) {
    await assert.rejects(runAgent('循环', model, execute, limit));
  }
});
