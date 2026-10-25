import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import {
  AGENT_STATUS,
  createHistory,
  runAgent,
  type AgentOutput,
} from './agent-loop.js';
import { compactHistory, type CompactResult } from './compact.js';
import {
  OUTPUT_TYPE,
  REQUEST_STATUS,
  type Execute,
  type Provider,
  type SessionStore,
} from './types.js';

/**
 * 由调用方提供的会话依赖，不包含终端或 UI 配置。
 */
export interface SessionOptions {
  /**
   * 会话标识，由调用方生成；文件存储实现要求 UUID。
   */
  id: string;
  /**
   * 工具工作目录的标识；核心不解析路径或访问文件系统。
   */
  root: string;
  /**
   * 当前会话使用的模型服务。
   */
  provider: Provider;
  /**
   * 工具执行器；确认能力由调用方在创建工具时注入。
   */
  execute: Execute;
  /**
   * 恢复的原始消息；省略时使用初始 system 指令。
   */
  history?: ChatCompletionMessageParam[];
  /**
   * 每轮最多调用模型的次数，默认 20。
   */
  maxModelCalls?: number;
  /**
   * 可替换的会话存储；省略时只在内存中运行。
   */
  store?: SessionStore;
}

/**
 * 管理会话执行、历史和保存，不读取输入或打印内容。
 */
export class Session {
  /**
   * 当前会话标识。
   */
  readonly id: string;
  /**
   * 调用方确认后的工作目录标识。
   */
  readonly root: string;
  /**
   * 当前会话的 OpenAI 原始消息。
   */
  history: ChatCompletionMessageParam[];
  /**
   * 会话独占的模型服务及其用量基准。
   */
  private readonly provider: Provider;
  /**
   * 外部提供的工具执行器。
   */
  private readonly execute: Execute;
  /**
   * 每轮模型调用次数上限。
   */
  private readonly maxModelCalls: number;
  /**
   * 外部提供的存储实现。
   */
  private readonly store?: SessionStore;
  /**
   * 防止同一会话同时执行任务、压缩或清空。
   */
  private busy = false;

  constructor(options: SessionOptions) {
    this.id = options.id;
    this.root = options.root;
    this.provider = options.provider;
    this.execute = options.execute;
    this.history = options.history?.slice() ?? createHistory();
    this.maxModelCalls = options.maxModelCalls ?? 20;
    this.store = options.store;
  }

  /**
   * 执行一轮任务，产出正文、执行状态和最终结果。
   * 正常完成或达到调用上限时保存；取消或停止消费时回退历史。
   */
  async *run(task: string, signal?: AbortSignal): AsyncGenerator<AgentOutput> {
    if (this.busy) {
      throw new Error('当前会话正在执行操作');
    }
    this.busy = true;
    const previousHistory = this.history.slice();
    let finished = false;
    try {
      for await (const output of runAgent(
        task,
        {
          provider: this.provider,
          execute: this.execute,
          history: this.history,
          maxModelCalls: this.maxModelCalls,
        },
        signal,
      )) {
        if (output.type !== OUTPUT_TYPE.RESULT) {
          yield output;
          continue;
        }
        if (output.status === AGENT_STATUS.CANCELLED || signal?.aborted) {
          this.history = previousHistory;
          this.provider.reset?.();
          finished = true;
          yield {
            type: OUTPUT_TYPE.RESULT,
            status: AGENT_STATUS.CANCELLED,
            answer: '任务已取消。',
          };
          return;
        }
        if (
          output.status === AGENT_STATUS.ANSWERED ||
          output.status === AGENT_STATUS.MODEL_CALL_LIMIT
        ) {
          await this.store?.save(this.id, {
            root: this.root,
            history: this.history,
          });
        }
        finished = true;
        yield output;
        return;
      }
      throw new Error('任务未返回结果');
    } finally {
      if (!finished) {
        this.history = previousHistory;
        this.provider.reset?.();
      }
      this.busy = false;
    }
  }

  /**
   * 手动压缩，成功保存后替换历史；失败或取消保持原历史。
   */
  async compact(signal?: AbortSignal): Promise<CompactResult> {
    if (this.busy) {
      throw new Error('当前会话正在执行操作');
    }
    this.busy = true;
    try {
      const result = await compactHistory(this.history, this.provider, signal);
      if (result.status === REQUEST_STATUS.CANCELLED) {
        this.provider.reset?.();
        return result;
      }
      if (
        result.status !== REQUEST_STATUS.COMPLETED ||
        result.history === this.history
      ) {
        return result;
      }
      await this.store?.save(this.id, {
        root: this.root,
        history: result.history,
      });
      this.history = result.history;
      return result;
    } finally {
      this.busy = false;
    }
  }

  /**
   * 清空历史并保存，保留当前会话 ID。
   */
  async clear() {
    if (this.busy) {
      throw new Error('当前会话正在执行操作');
    }
    this.busy = true;
    try {
      const history = createHistory();
      await this.store?.save(this.id, { root: this.root, history });
      this.history = history;
      this.provider.reset?.();
    } finally {
      this.busy = false;
    }
  }
}
