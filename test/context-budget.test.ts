import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_BUDGET_STATUS,
  estimateTokens,
  contextBudgetStatus,
  readContextBudget,
} from '../src/context-budget.js';

const budget = {
  contextWindow: 128000,
  maxOutputTokens: 2048,
};

test('实际输入加输出预留达到窗口 80% 时提示，不重复计算缓存和输出', () => {
  assert.equal(contextBudgetStatus(100, budget), CONTEXT_BUDGET_STATUS.OK);
  assert.equal(
    contextBudgetStatus(100352, budget),
    CONTEXT_BUDGET_STATUS.NEAR_LIMIT,
  );
  assert.equal(
    contextBudgetStatus(125952, budget),
    CONTEXT_BUDGET_STATUS.EXHAUSTED,
  );
  for (const value of [undefined, null, NaN, -1, '100']) {
    assert.equal(
      contextBudgetStatus(value, budget),
      CONTEXT_BUDGET_STATUS.UNKNOWN,
    );
  }
});

test('预算配置拒绝非整数与不足以预留输出的窗口', (t) => {
  const previousWindow = process.env.ZENMUX_CONTEXT_WINDOW;
  const previousOutput = process.env.ZENMUX_MAX_OUTPUT_TOKENS;
  t.after(() => {
    for (const [key, value] of Object.entries({
      ZENMUX_CONTEXT_WINDOW: previousWindow,
      ZENMUX_MAX_OUTPUT_TOKENS: previousOutput,
    })) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
  process.env.ZENMUX_MAX_OUTPUT_TOKENS = '2048';
  for (const value of ['', 'NaN', '1.5', '-1', '2048']) {
    process.env.ZENMUX_CONTEXT_WINDOW = value;
    assert.throws(readContextBudget, /配置无效/);
  }
  process.env.ZENMUX_CONTEXT_WINDOW = '64000';
  process.env.ZENMUX_MAX_OUTPUT_TOKENS = '4096';
  assert.deepEqual(readContextBudget(), {
    contextWindow: 64000,
    maxOutputTokens: 4096,
  });
});

test('字符估算用于新增消息，不使用 UTF-8 字节数', () => {
  const messages = [{ role: 'user', content: '你好' }];
  assert.equal(
    estimateTokens(messages),
    Math.ceil(JSON.stringify(messages).length / 4) + 4,
  );
});
