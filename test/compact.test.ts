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

test('压缩保留 system，用摘要替换历史并重置基准，原数组不变', async () => {
  const history = createHistory();
  history.push({ role: 'user', content: '读取文件' });
  history.push({ role: 'assistant', content: '已读取 welcome.md' });
  const original = structuredClone(history);
  let resets = 0;
  const compacted = await compactHistory(history, {
    reply: unusedReply,
    async summarize(request) {
      assert.equal(request.length, 2);
      assert.deepEqual(JSON.parse(request[1].content as string), original);
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
  assert.equal(compacted.history.length, 2);
  assert.deepEqual(compacted.history[0], original[0]);
  assert.match(compacted.history[1].content as string, /已读取 welcome.md/);
  assert.equal(resets, 1);
});

test('摘要失败或内容无效时保留历史和用量基准', async () => {
  for (const content of [null, '', '   ', 'throw']) {
    const history = createHistory();
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
