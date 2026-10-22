import { completedMessage } from './stream-helpers.js';
import { REQUEST_STATUS, REQUEST_FAILURE } from '../src/types.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistory } from '../src/agent-loop.js';
import type { Provider } from '../src/types.js';
import { completeAgent, messageChunk } from './stream-helpers.js';

const summary = {
  role: 'assistant' as const,
  content: '保留当前任务及已完成工作',
  refusal: null,
};

test('工具结果全部收齐后自动压缩，重试不占用模型调用次数', async () => {
  const history = createHistory();
  const system = history[0];
  let requests = 0;
  let summaries = 0;
  let resets = 0;
  const modelCalls: number[] = [];
  const provider: Provider = {
    async *reply(messages, context) {
      requests += 1;
      modelCalls.push(context.modelCall);
      if (requests === 1) {
        yield messageChunk({
          role: 'assistant',
          content: null,
          refusal: null,
          tool_calls: ['a', 'b'].map((id) => ({
            id,
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
          })),
        });
        return;
      }
      if (requests === 2) {
        assert.deepEqual(
          messages.slice(-2).map((message) => message.role),
          ['tool', 'tool'],
        );
        yield { status: REQUEST_STATUS.BUDGET_EXCEEDED, message: '预算不足' };
        return;
      }
      assert.equal(resets, 1);
      assert.deepEqual(
        messages.map((message) => message.role),
        ['system', 'user'],
      );
      assert.match(String(messages[1].content), /保留当前任务/);
      yield messageChunk({ role: 'assistant', content: '完成', refusal: null });
    },
    async summarize(messages) {
      summaries += 1;
      const source = JSON.parse(String(messages[1].content));
      assert.deepEqual(
        source.slice(-2).map((message: any) => message.tool_call_id),
        ['a', 'b'],
      );
      return completedMessage(summary);
    },
    reset() {
      resets += 1;
    },
  };
  const result = await completeAgent('当前任务', {
    provider,
    history,
    maxModelCalls: 2,
    execute: async () => ({ ok: true, data: '结果' }),
  });
  assert.equal(result.answer, '完成');
  assert.equal(summaries, 1);
  assert.deepEqual(modelCalls, [1, 2, 2]);
  assert.equal(history[0], system);
  assert.equal(history.at(-1)?.content, '完成');
});

for (const failing of [false, true]) {
  test(
    failing ? '摘要失败保留压缩前历史并停止' : '压缩后仍不足，只尝试一次并停止',
    async () => {
      const history = createHistory();
      let summaries = 0;
      let requests = 0;
      let original: unknown;
      const provider: Provider = {
        async *reply() {
          requests += 1;
          original ??= structuredClone(history);
          yield { status: REQUEST_STATUS.BUDGET_EXCEEDED, message: '预算不足' };
          return;
        },
        async summarize() {
          summaries += 1;
          if (failing) {
            return {
              status: REQUEST_STATUS.FAILED,
              reason: REQUEST_FAILURE.CONNECTION,
              message: '摘要失败',
            };
          }
          return completedMessage(summary);
        },
      };
      assert.match(
        (
          await completeAgent('任务', {
            provider,
            history,
            maxModelCalls: 6,
            execute: async () => assert.fail('不能执行工具'),
          })
        ).answer,
        failing ? /压缩失败/ : /已尝试一次/,
      );
      assert.equal(summaries, 1);
      assert.equal(requests, failing ? 1 : 2);
      if (failing) {
        assert.deepEqual(history, original);
      }
    },
  );
}

test('服务端上下文错误不触发自动压缩', async () => {
  const provider: Provider = {
    async *reply() {
      yield {
        status: REQUEST_STATUS.FAILED,
        reason: REQUEST_FAILURE.CONTEXT_LIMIT,
        message: '服务端超限',
      };
      return;
    },
    async summarize() {
      assert.fail('不能压缩');
    },
  };
  assert.match(
    (
      await completeAgent('任务', {
        provider,
        history: createHistory(),
        maxModelCalls: 6,
        execute: async () => assert.fail(),
      })
    ).answer,
    /服务端超限/,
  );
});
