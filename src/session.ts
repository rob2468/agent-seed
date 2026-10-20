import { createInterface, type Interface } from 'node:readline';
import {
  AGENT_STATUS,
  createHistory,
  runAgent,
  type AgentResult,
} from './agent-loop.js';
import { compactHistory } from './compact.js';
import { confirmWrite } from './confirm-write.js';
import { ContextBudgetError } from './context-budget.js';
import { EXIT_CODE } from './exit-code.js';
import { loadSession, saveSession } from './session-store.js';
import { createTools } from './tools.js';
import { OUTPUT_TYPE, type Execute, type Provider } from './types.js';

/**
 * 管理会话历史、任务取消、终端输入和工具执行。
 */
export class Session {
  /**
   * 会话使用的模型服务。
   */
  readonly provider: Provider;
  /**
   * 工具可访问的根目录。
   */
  private readonly directory: string;
  /**
   * 每轮任务允许的最大模型调用次数。
   */
  readonly maxModelCalls: number;
  /**
   * 当前会话历史。
   */
  history = createHistory();
  /**
   * 初始化时绑定工作目录和确认函数的工具执行器。
   */
  execute!: Execute;
  /**
   * 当前任务或压缩操作的取消控制器，空闲时为 undefined。
   */
  private controller?: AbortController;
  /**
   * 终端输入接口，负责输入提示和 Ctrl+C 监听。
   */
  private input!: Interface;
  /**
   * 会话输入与写入确认共用的行迭代器，按顺序读取终端输入。
   */
  private lines!: AsyncIterableIterator<string>;
  /**
   * 会话退出码，空闲时按 Ctrl+C 会设为取消状态。
   */
  private exitCode: number = EXIT_CODE.SUCCESS;

  /**
   * @param provider 会话使用的模型服务。
   * @param directory 工具可访问的根目录。
   * @param maxModelCalls 每轮模型调用次数上限。
   */
  constructor(provider: Provider, directory: string, maxModelCalls = 6) {
    this.provider = provider;
    this.directory = directory;
    this.maxModelCalls = maxModelCalls;
  }

  /**
   * 恢复历史并初始化工具和终端输入。
   */
  private async open() {
    this.history = await loadSession();
    this.execute = await createTools(this.directory, this.confirm);
    this.exitCode = EXIT_CODE.SUCCESS;

    this.input = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    this.lines = this.input[Symbol.asyncIterator]();
    this.input.on('SIGINT', this.interrupt);
    process.on('SIGINT', this.interrupt);
  }

  /**
   * 移除监听并关闭输入接口。
   */
  private close() {
    process.off('SIGINT', this.interrupt);
    this.input.off('SIGINT', this.interrupt);
    this.input.close();
  }

  /**
   * 任务进行中取消任务，空闲时退出会话。
   */
  private interrupt = () => {
    if (this.controller) {
      this.controller.abort();
      return;
    }

    this.exitCode = EXIT_CODE.CANCELLED;
    this.input.close();
  };

  /**
   * 使用会话的输入接口等待写入确认。
   */
  private confirm = (
    path: string,
    content: string,
    overwrite: boolean,
    signal?: AbortSignal,
  ) => {
    return confirmWrite(
      this.input,
      this.lines,
      path,
      content,
      overwrite,
      signal,
    );
  };

  /**
   * 执行一轮任务并保存历史；取消时恢复本轮开始前的历史。
   * @param task 用户任务。
   * @returns Agent Loop 结果；取消时返回 undefined。
   */
  private async runTurn(task: string) {
    const previousHistory = this.history.slice();
    this.controller = new AbortController();
    const signal = this.controller.signal;

    // 本轮取消时恢复历史，其他错误交给调用方处理。
    try {
      let result: AgentResult | undefined;
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
        if (output.type === OUTPUT_TYPE.TEXT) {
          process.stdout.write(output.text);
        } else {
          result = output.result;
        }
      }
      if (!result) {
        throw new Error('任务未返回结果');
      }
      this.controller = undefined;

      await saveSession(this.history);
      if (result.status === AGENT_STATUS.MODEL_CALL_LIMIT) {
        console.log(`\n${result.answer}`);
      }
      return result;
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }

      this.history = previousHistory;
      this.provider.reset?.();
      console.log('\n任务已取消。');
    } finally {
      this.controller = undefined;
    }
  }

  /**
   * 执行一次任务后结束。
   * @param task 用户任务。
   * @returns 退出码。
   */
  async runTask(task: string) {
    await this.open();
    // 结束或出错时都关闭终端并移除监听。
    try {
      const result = await this.runTurn(task);
      if (!result) {
        return EXIT_CODE.CANCELLED;
      }
      if (result.status === AGENT_STATUS.MODEL_CALL_LIMIT) {
        return EXIT_CODE.MODEL_CALL_LIMIT;
      }
      return this.exitCode;
    } finally {
      this.close();
    }
  }

  /**
   * 清空历史和用量基准，并保存。
   */
  private async clear() {
    this.history = createHistory();
    this.provider.reset?.();
    await saveSession(this.history);
    console.log('历史已清空。');
  }

  /**
   * 生成摘要，成功后替换并保存历史。
   */
  private async compact() {
    this.controller = new AbortController();
    const signal = this.controller.signal;
    let compacted;
    try {
      compacted = await compactHistory(this.history, this.provider, signal);
    } catch {
      if (signal.aborted) {
        this.provider.reset?.();
        console.log('任务已取消。');
      } else {
        console.error(
          '上下文压缩失败，原历史已保留。可重试或使用 /clear 清空历史。',
        );
      }
      return;
    } finally {
      this.controller = undefined;
    }

    if (compacted === this.history) {
      console.log('暂无需要压缩的历史。');
      return;
    }
    await saveSession(compacted);
    this.history = compacted;
    console.log('上下文已压缩。');
  }

  /**
   * 循环处理交互输入，退出时关闭会话资源。
   * @returns 退出码。
   */
  async runSession() {
    await this.open();
    // 结束或出错时都关闭终端并移除监听。
    try {
      console.log(
        '输入任务开始对话；Ctrl+C 取消当前任务，/compact 压缩上下文，/clear 清空历史，/exit 退出。',
      );
      this.input.setPrompt('你：');
      this.input.prompt();

      for await (const line of this.lines) {
        const text = line.trim();
        if (text === '/exit') {
          break;
        }
        if (!text) {
          this.input.prompt();
          continue;
        }

        if (text === '/clear') {
          await this.clear();
        } else if (text === '/compact') {
          await this.compact();
        } else {
          try {
            await this.runTurn(text);
          } catch (error) {
            if (!(error instanceof ContextBudgetError)) {
              throw error;
            }
            console.error(error.message);
          }
        }
        this.input.prompt();
      } // for
    } finally {
      this.close();
    }
    return this.exitCode;
  }
}
