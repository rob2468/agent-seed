import { completedMessage } from './stream-helpers.js';
import { REQUEST_STATUS, REQUEST_FAILURE } from '../src/types.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactHistory } from '../src/compact.js';
import { createHistory } from '../src/agent-loop.js';
import type { Provider } from '../src/types.js';

const unusedReply: Provider['reply'] = async function* () {
  throw new Error('不应调用普通 reply');
};

test('压缩保留 system，保留最近一轮，只摘要旧历史并重置基准，原数组不变', async () => {
  const history = createHistory();
  history.push({ role: 'user', content: '读取文件' });
  history.push({ role: 'assistant', content: '已读取 welcome.md' });
  history.push({ role: 'user', content: '继续任务' });
  const original = structuredClone(history);
  let resets = 0;
  const compacted = await compactHistory(history, {
    reply: unusedReply,
    async summarize(request) {
      assert.equal(request.length, 2);
      assert.deepEqual(
        JSON.parse(request[1].content as string),
        original.slice(1, -1),
      );
      request.length = 0;
      return completedMessage({
        role: 'assistant',
        content: '已读取 welcome.md，等待下一步任务。',
        refusal: null,
      });
    },
    reset() {
      resets += 1;
    },
  });
  assert.deepEqual(history, original);
  assert.equal(compacted.status, REQUEST_STATUS.COMPLETED);
  assert.ok(compacted.status === REQUEST_STATUS.COMPLETED);
  assert.equal(compacted.history.length, 3);
  assert.deepEqual(compacted.history[0], original[0]);
  assert.match(compacted.history[1].content as string, /已读取 welcome.md/);
  assert.equal(compacted.history[2], history[3]);
  assert.equal(resets, 1);
});

test('摘要失败或内容无效时保留历史和用量基准', async () => {
  for (const content of [null, '', '   ', 'throw']) {
    const history = createHistory();
    history.push({ role: 'user', content: '旧任务' });
    history.push({ role: 'assistant', content: '旧回答' });
    history.push({ role: 'user', content: '任务' });
    const original = structuredClone(history);
    assert.equal(
      (
        await compactHistory(history, {
          reply: unusedReply,
          async summarize() {
            if (content === 'throw') {
              return {
                status: REQUEST_STATUS.FAILED,
                reason: REQUEST_FAILURE.CONNECTION,
                message: '连接失败',
              };
            }
            return completedMessage({
              role: 'assistant',
              content,
              refusal: null,
            });
          },
          reset() {
            assert.fail('失败时不能重置基准');
          },
        })
      ).status,
      REQUEST_STATUS.FAILED,
    );
    assert.deepEqual(history, original);
  }
});

test('空会话不调用摘要也不重置基准', async () => {
  const history = createHistory();
  assert.deepEqual(await compactHistory(history, { reply: unusedReply }), {
    status: REQUEST_STATUS.COMPLETED,
    history,
  });
});

test('整轮保留多个工具调用及结果，再次压缩只处理旧摘要', async () => {
  const history = createHistory();
  history.push({ role: 'user', content: '旧任务' });
  history.push({ role: 'assistant', content: '旧回答' });
  const recent = [
    { role: 'user' as const, content: '读取两个文件' },
    {
      role: 'assistant' as const,
      content: null,
      tool_calls: ['a', 'b'].map((id) => ({
        id,
        type: 'function' as const,
        function: { name: 'read_file', arguments: '{}' },
      })),
    },
    { role: 'tool' as const, tool_call_id: 'a', content: '文件一' },
    { role: 'tool' as const, tool_call_id: 'b', content: '文件二' },
    { role: 'assistant' as const, content: '读取完成' },
  ];
  history.push(...recent);
  let source: unknown;
  const provider: Provider = {
    reply: unusedReply,
    async summarize(request) {
      source = JSON.parse(String(request[1].content));
      return completedMessage({
        role: 'assistant',
        content: '旧摘要',
        refusal: null,
      });
    },
  };
  const first = await compactHistory(history, provider);
  assert.ok(first.status === REQUEST_STATUS.COMPLETED);
  assert.deepEqual(source, history.slice(1, 3));
  assert.deepEqual(first.history.slice(2), recent);

  const second = await compactHistory(first.history, provider);
  assert.ok(second.status === REQUEST_STATUS.COMPLETED);
  assert.deepEqual(source, [first.history[1]]);
  assert.deepEqual(second.history.slice(2), recent);
});

test('只有最近一轮时不请求摘要，也不重置基准', async () => {
  const history = createHistory();
  history.push({ role: 'user', content: '当前任务' });
  history.push({ role: 'assistant', content: '完成' });
  const result = await compactHistory(history, {
    reply: unusedReply,
    async summarize() {
      assert.fail('没有旧历史，不应请求摘要');
    },
    reset() {
      assert.fail('历史没有改变，不应重置基准');
    },
  });
  assert.ok(result.status === REQUEST_STATUS.COMPLETED);
  assert.equal(result.history, history);
});
