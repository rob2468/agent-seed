import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { createInterface, type Interface } from 'node:readline';
import {
  AGENT_STATUS,
  AGENT_STAGE,
  createHistory,
  runAgent,
  type AgentResult,
} from './agent-loop.js';
import { compactHistory } from './compact.js';
import { confirmWrite } from './confirm-write.js';
import { EXIT_CODE } from './exit-code.js';
import { latestSession, loadSession, saveSession } from './session-store.js';
import { createTools } from './tools.js';
import {
  REQUEST_STATUS,
  REQUEST_FAILURE,
  OUTPUT_TYPE,
  type Execute,
  type Provider,
} from './types.js';

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
  private directory: string;
  /**
   * 当前会话 ID；新建时生成，恢复时使用已保存的 ID。
   */
  private id: string = randomUUID();
  /**
   * 每轮任务允许的最大模型调用次数。
   */
  readonly maxModelCalls: number;
  /**
   * true 恢复最近会话，字符串恢复指定 ID，undefined 新建会话。
   */
  private readonly resume?: true | string;
  /**
   * 是否显式指定工作目录，用于恢复时检查目录冲突。
   */
  private readonly explicitRoot: boolean;
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
   * @param maxModelCalls 每轮模型调用次数上限，默认 20。
   * @param resume true 恢复当前目录最近会话，字符串恢复指定 ID，省略则新建。
   * @param explicitRoot 是否显式指定目录；指定 ID 时需检查目录冲突。
   */
  constructor(
    provider: Provider,
    directory: string,
    maxModelCalls = 20,
    resume?: true | string,
    explicitRoot = false,
  ) {
    this.provider = provider;
    this.directory = directory;
    this.maxModelCalls = maxModelCalls;
    this.resume = resume;
    this.explicitRoot = explicitRoot;
  }

  /**
   * 新建或恢复会话，并初始化工具和终端输入。
   */
  private async open() {
    if (this.resume) {
      if (this.resume === true) {
        const directory = await realpath(this.directory);
        this.id = await latestSession(directory);
      } else {
        this.id = this.resume;
      }

      const saved = await loadSession(this.id);

      let root: string;
      try {
        root = await realpath(saved.root);
      } catch {
        throw new Error(`会话工作目录不可访问：${saved.root}`);
      }
      if (this.explicitRoot) {
        const directory = await realpath(this.directory);
        if (root !== directory) {
          throw new Error('会话工作目录与显式 --root 不一致。');
        }
      }

      this.directory = root;
      this.history = saved.history;
    } else {
      this.directory = await realpath(this.directory);
    }

    this.execute = await createTools(this.directory, this.confirm);

    console.log(
      `agent-seed | zenmux | ${this.resume ? '恢复' : '新建'}会话：${this.id} | 工作目录：${this.directory}`,
    );

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
   * @returns 本轮完成、取消、预算不足或失败的结果。
   */
  private async runTurn(task: string): Promise<AgentResult> {
    const previousHistory = this.history.slice();
    this.controller = new AbortController();
    const signal = this.controller.signal;

    // 无论结果如何，最后都清理本轮取消控制器。
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
          result = output;
        }
      }
      if (!result) {
        throw new Error('任务未返回结果');
      }
      this.controller = undefined;

      if (result.status === AGENT_STATUS.CANCELLED) {
        this.history = previousHistory;
        this.provider.reset?.();
        console.log('\n任务已取消。');
        return result;
      }
      if (
        result.status === AGENT_STATUS.BUDGET_EXCEEDED ||
        result.status === AGENT_STATUS.FAILED
      ) {
        console.error(result.answer);
        return result;
      }

      await saveSession(this.id, this.directory, this.history);
      if (result.status === AGENT_STATUS.MODEL_CALL_LIMIT) {
        console.log(`\n${result.answer}`);
      }
      return result;
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
      if (result.status === AGENT_STATUS.CANCELLED) {
        return EXIT_CODE.CANCELLED;
      }
      if (result.status === AGENT_STATUS.MODEL_CALL_LIMIT) {
        return EXIT_CODE.MODEL_CALL_LIMIT;
      }
      if (
        result.status === AGENT_STATUS.FAILED ||
        result.status === AGENT_STATUS.BUDGET_EXCEEDED
      ) {
        return EXIT_CODE.ERROR;
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
    await saveSession(this.id, this.directory, this.history);
    console.log('历史已清空。');
  }

  /**
   * 生成摘要，成功后替换并保存历史。
   */
  private async compact() {
    this.controller = new AbortController();
    const signal = this.controller.signal;
    let result;
    try {
      result = await compactHistory(this.history, this.provider, signal);
    } finally {
      this.controller = undefined;
    }

    if (result.status === REQUEST_STATUS.CANCELLED) {
      this.provider.reset?.();
      console.log('任务已取消。');
      return;
    }
    if (result.status !== REQUEST_STATUS.COMPLETED) {
      console.error(result.message);
      return;
    }
    if (result.history === this.history) {
      console.log('暂无需要压缩的历史。');
      return;
    }
    await saveSession(this.id, this.directory, result.history);
    this.history = result.history;
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
          const result = await this.runTurn(text);
          if (
            result.status === AGENT_STATUS.FAILED &&
            result.stage === AGENT_STAGE.MODEL_CALL &&
            result.reason !== REQUEST_FAILURE.CONTEXT_LIMIT
          ) {
            return EXIT_CODE.ERROR;
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
