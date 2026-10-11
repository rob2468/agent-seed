/**
 * 上下文预算检查的状态。
 */
export const CONTEXT_BUDGET_STATUS = {
  // 输入测量值无效，无法判断预算。
  UNKNOWN: 'unknown',
  // 输入测量值加输出预留低于窗口的 80%。
  OK: 'ok',
  // 输入测量值加输出预留达到窗口的 80%，但尚未达到上限。
  NEAR_LIMIT: 'near_limit',
  // 输入测量值加输出预留达到或超过窗口上限。
  EXHAUSTED: 'exhausted',
} as const;

/**
 * 本地预算配置；窗口需与所选模型的服务规格一致。
 */
export interface ContextBudget {
  /**
   * 服务商为当前模型开放的上下文上限，单位 token。
   */
  contextWindow: number;
  /**
   * 本次最大输出长度，同时从窗口中预留。
   */
  maxOutputTokens: number;
}

/**
 * 本地预算不足或服务端上下文超限，交互会话可提示用户清空后继续。
 */
export class ContextBudgetError extends Error {}

// 默认窗口对应当前学习使用的 DeepSeek V3.2，不代表所有 ZenMux 模型。
export function readContextBudget(): ContextBudget {
  const budget = {
    contextWindow: Number(process.env.ZENMUX_CONTEXT_WINDOW ?? 128_000),
    maxOutputTokens: Number(process.env.ZENMUX_MAX_OUTPUT_TOKENS ?? 2048),
  };
  if (
    !Number.isSafeInteger(budget.contextWindow) ||
    !Number.isSafeInteger(budget.maxOutputTokens) ||
    budget.maxOutputTokens < 1 ||
    budget.contextWindow <= budget.maxOutputTokens
  ) {
    throw new Error(
      '上下文预算配置无效：窗口和输出预留必须为正整数，窗口必须大于输出预留。',
    );
  }
  return budget;
}

/**
 * 根据当前输入测量值与输出预留判断请求前预算。
 * @param promptTokens 当前输入的测量值（实际基准加新增估算）；无效时返回 unknown。
 * @param budget 当前模型的窗口上限与输出预留配置，详见 ContextBudget。
 */
export function contextBudgetStatus(
  promptTokens: unknown,
  budget: ContextBudget,
) {
  if (
    typeof promptTokens !== 'number' ||
    !Number.isSafeInteger(promptTokens) ||
    promptTokens < 0
  ) {
    return CONTEXT_BUDGET_STATUS.UNKNOWN;
  }

  const reservedTokens = promptTokens + budget.maxOutputTokens;
  if (reservedTokens >= budget.contextWindow) {
    return CONTEXT_BUDGET_STATUS.EXHAUSTED;
  }
  return reservedTokens >= budget.contextWindow * 0.8
    ? CONTEXT_BUDGET_STATUS.NEAR_LIMIT
    : CONTEXT_BUDGET_STATUS.OK;
}

/**
 * 按 JSON 字符数 / 4 估算 token，另加少量结构开销，不是精确分词。
 * @param value 新增消息或首次请求的完整消息与工具定义。
 */
export function estimateTokens(value: unknown) {
  return Math.ceil(JSON.stringify(value).length / 4) + 4;
}
