# agent-seed · Agent 的第一粒种子

一个用于学习的最小 TypeScript Agent harness。第一里程碑只做一件事：**模型请求工具 → 执行只读工具 → 结果加入历史 → 再请求模型 → 回答**。

## 先运行，再读代码

需要 Node.js 22+、npm。默认 mock 不联网、不读取密钥，无需账户。

```sh
cd ~/Desktop/workspace/agent-seed
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm run format:check
npm run typecheck
npm test
npm start -- "请读取 welcome.md 并介绍它"
```

依赖仅包含 npm 官方 registry 的 `openai`（官方 SDK）、`typescript`、`@types/node` 和 `prettier`。锁文件固定实际安装版本。测试用 Node 自带测试器。

修改代码后运行 `npm run format` 统一排版；提交前用 `npm run format:check` 检查。项目采用 2 空格缩进、单引号和 80 列换行，保留教学注释。锁文件由 npm 管理，不手工格式化。

默认工作目录始终是本项目的 `demo/`，不会因为从别处启动而扫描电脑项目。示例输出依次包含：

```text
第 1 轮，历史 2 条 → list_directory(".") → 目录结果
第 2 轮，历史 4 条 → read_file("welcome.md") → 文件文本
第 3 轮，历史 6 条 → 最终回答
```

mock 是固定教学脚本，不理解任意自然语言任务；最终回答包含本次工具实际读取的文本。可以编辑 `demo/welcome.md` 再运行，观察答案随工具结果改变。

```sh
npm start -- --max-steps 2 "读文档"
# 会在两次模型请求后停止，退出码 2；正常回答为 0，执行错误为 1。
npm start -- --root ./demo --mode mock "读文档"
```

## 最值得先读的文件

1. `src/agent-loop.ts`：从 `history` 到 `model.reply()`，再到 `execute()`，核心循环手写可读。
2. `src/mock.ts`：不接模型也能看到三轮流程。
3. `src/tools.ts`：工具 schema、运行时参数校验、受限文件访问和错误结果。
4. `src/types.ts` 与 `src/openai.ts`：内部消息协议与外部 SDK 的边界。
5. `test/agent.test.ts`：完整循环和失败路径如何验证。

历史最开始有 system 指令和 user 任务。模型每次返回一个 assistant 消息，它可能带多个工具调用。程序先保存这个消息，再逐个执行工具，将 `{ok,data}` 或 `{ok:false,error}` 序列化成 tool 消息，用 `callId` 对应模型的调用 ID。下一次请求携带完整历史，因此模型能根据观察继续决策。没有工具调用时返回最终答案；超过步数则主动结束，不额外请求模型。

工具失败也是观察，不会被当成成功文本。这里的调度只是一个顺序 `for` 循环。这里的 session 只是一次运行内的消息数组，进程退出即丢失。

## 与 DeepSeek Harness 对照学习

核对日期：2026-10-10；上游快照：`d743267388641bc76f17c45ce8b4c231aed1d32c`。以下是职责对照，不是复刻；本项目没有复制上游实现。

| 职责            | 本项目                               | 上游阅读入口                                                                                                                                              | 暂未实现                           |
| --------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| agent-loop      | `runAgent()` 逐轮请求、观察、停止    | [agent.ts](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/agent.ts)           | 流式事件、复杂生命周期与取消恢复   |
| tool scheduling | `for...of` 顺序执行并按调用顺序回填  | [tool-calls.ts](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/agent-loop/src/tool-calls.ts) | 有界并行、独占屏障、取消时补齐结果 |
| provider        | `Model` 接口 + mock / OpenAI adapter | [llm](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/llm)                                         | 多 provider 注册、流式协议、重试层 |
| session         | 内存 `history`                       | [session](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/core/session)                            | 持久化、恢复、分支及事件投影       |

建议只对照这四个职责，先能手画一次工具循环。上游是插件化的大型项目，我们这一课没有插件、写工具、shell、多 Agent、数据库、队列或 Web UI。

## 真实模型（本次未调用、未验证网络集成）

真实模式使用 OpenAI 官方 SDK 的 Chat Completions API。用户以后自行设置 `OPENAI_API_KEY` 和 `OPENAI_MODEL`，选择支持 function calling 的可用模型；本项目不自动读取 `.env`，不搜索本机凭据，不提供或保存密钥。默认 mock 即使环境已有密钥也不会创建 SDK client。

无秘密配置示例（仅展示变量名称，模型标识需自行填写）：

```text
OPENAI_API_KEY=<由你自行安全设置，不要写进仓库>
OPENAI_MODEL=<你账户可用且支持工具调用的模型标识>
```

完成自己的环境配置后才运行：

```sh
npm start -- --mode openai "列出目录，再读取 welcome.md 并总结"
```

此命令会发送任务、工具描述和读到的文件内容给 OpenAI，并可能产生费用。adapter 的 SDK 类型检查已通过，但认证、模型兼容性、真实工具调用和费用均未实测。网络超时为 30 秒，无自动重试，单次输出上限 2048 tokens。没有改写 API 地址的配置入口。

## 第一版边界

- 仅允许相对路径，拒绝 `..`、绝对路径和空路径；解析真实路径后拒绝符号链接越界（含目录链接），允许仍位于根目录内的链接。
- 只读普通 UTF-8 文件，最多 16 KiB；实际读取也有硬上限，拒绝二进制解码错误。目录不递归，最多 100 项，返回 `truncated`。
- 默认最多 6 次模型请求，可设 1–20；单轮最多 8 个调用。参数 JSON 和工具名均经过运行时校验。
- 文件访问错误变成清晰工具结果继续回传；模型连接或协议错误终止 CLI。

**这不是完整沙箱。** 路径检查到打开文件之间仍存在目录被并发替换的竞态；没有 OS 级隔离、硬链接来源检测、敏感文件识别或提示注入防护保证。只将自己信任的演示目录作为根，不要指向含秘密的项目，不要在恶意进程可同时修改的目录里运行。文件中的文字只作为数据，但模型是否遵守仍取决于模型。真实模式会把允许读取的内容发给 provider。

本里程碑到此为止：能观察并解释一次完整、受限的工具循环。
