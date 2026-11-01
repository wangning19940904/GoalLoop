# 执行器与能力包开发

## RuntimeAdapter

接口在 `src/contracts.ts`，实现放在 `src/runtimes/`：

```ts
interface RuntimeAdapter {
  probe(): Promise<RuntimeStatus>;
  runTurn(packet: TurnPacket, signal: AbortSignal): AsyncIterable<RuntimeEvent>;
}
```

`TurnPacket` 每轮从业务数据库编译，包含契约、当前任务及依赖、未过期证据、人工决策、已安装能力的 schema、能力包上下文、会话引用和工具桥。历史会话只辅助理解，不能决定权限或业务完成。

事件为 `session / text / usage / result`。usage 表示本轮累计的实际 input/output token；无用量时省略，不能伪造零。result 由 Zod 校验，必须是 `progress / need_human / wait_event / candidate / no_progress / failed`。调用 `finish_turn` 会立即持久保存结果；SDK 最终文本解析失败不会覆盖这份结果。

新适配器需要：探测依赖/认证、禁用原生写能力、提供同样的受控工具、接收 AbortSignal 并释放资源、错误不能视作完成、保存会话引用、失效会话可依据业务状态重建。轮次恢复不重放动作；动作网关账本负责识别未决和已确认动作。

## 四个接入

| 执行器           | 实现与边界                                                                                                                                                          | 用量                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Codex            | App Server JSON-RPC；thread/start/resume、turn/start、动态工具、权限拒绝；关闭 shell/unified_exec/hooks/apps/多 Agent，禁用继承 MCP，readonly sandbox；取消关闭进程 | tokenUsage 累计差值                |
| Claude Code      | 官方 SDK query；仅 GoalLoop MCP，tools=[]、strictMcpConfig、settingSources=[]，PreToolUse 和 canUseTool 拒绝原生工具，abortController + close                       | SDK result.usage                   |
| DeepSeek Harness | SDK/runtime 同为 0.2.0-rc.2，sdk-minimal + YAML patch，禁用 Bash/PowerShell/PTY，接入 scoped MCP；onNotification 流，close 回收子进程                               | 此版本未统一映射可靠用量，显示未知 |
| Deep Agents      | deepagents 1.14.2，控制面工具桥，middleware 过滤/拒绝原生文件和 task 工具，StateBackend 拒绝文件读写，子代理禁用；PostgresSaver 独立 goalloop_runtime schema        | AI message usage_metadata 累加     |

Codex 使用操作者已经配置的 CLI 登录。其他三个首版显式从环境读取 API key 和模型名；不会尝试提取桌面客户端凭证。子进程只继承必要的 PATH/HOME/代理环境与对应模型 key，不继承控制数据库或飞书凭证。Deep Agents 在后台进程内运行；模型只能接触已注册工具，checkpoint 不承担业务调度。

固定依赖及官方协议来源：

- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Claude Agent SDK permissions](https://platform.claude.com/docs/en/agent-sdk/permissions)
- [DeepSeek Harness TypeScript SDK](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md)
- [Deep Agents human-in-the-loop](https://docs.langchain.com/oss/javascript/deepagents/human-in-the-loop)

配置模型必须使用提供商支持且账户可访问的 ID，不在代码里依赖一个会变更的默认模型。运行 `pnpm run doctor` 检查环境，`pnpm test:live <runtime>` 进行真实任务验收。SDK 初始化成功不等于模型认证成功。

## 受控 MCP

Endpoint：`POST http://127.0.0.1:12400/api/v1/mcp`，Streamable HTTP、stateless JSON response。

工具：`read_goal / observe / read_workspace / run_check / propose_action / request_human / add_task / record_progress / finish_turn`。令牌由 Worker 按轮签发给适配器，使用 `Authorization: Bearer <run-token>`；没有长期管理令牌，也没有给任意外部客户端创建运行令牌的公开接口。`read_goal` 返回当前目标/任务/证据/决策，不返回数据库凭证、管理 token 或其他目标。

原生 SDK 的交互确认必须转成持久人工事项并结束当前轮，不允许挂住进程等待数天。用户答案由下一轮 TurnPacket 注入。普通 Tool 调用不能更改目标版本、审批自己的动作、安装插件或拓宽范围。

## CapabilityPack

运行时接口在 `src/packs.ts`。能力包必须导出一个接收 Store 的默认工厂：

```ts
import type { CapabilityPack } from './src/packs.js';
import type { Store } from './src/db.js';
export default function makePack(db: Store): CapabilityPack {
  return {
    id: 'my_domain',
    freezeScope: async () => ['resource-1'],
    policyTemplate: [], // 未声明能力默认拒绝
    capabilities: [],
    initialize: async () => [{ title: '调查资源', resource: 'resource-1' }],
    context: async () => ({ instructions: '领域背景，不授予权限' }),
    verify: async () => ({
      satisfied: false,
      missing: true,
      summary: '等待可信领域观测',
      details: {},
    }),
  };
}
```

编译成 ESM 后，由操作者设置 `GOALLOOP_PACK_MODULES=["/absolute/path/to/pack.mjs"]` 并同时重启 API/Worker。Web 创建页从 `/api/v1/packs` 显示已启用包，CLI 使用 `--pack my_domain`。业务 API 和 Agent 不接受可执行模块路径。

每个能力定义 `name、write、schema、precondition、execute、reconcile`；schema 必须包含 resource，动作网关强制冻结 scope。写操作需要显式 policy 授权。`lockKey` 对接共享真实资源时应返回跨目标一致的锁键，避免两个目标同时改同一资源；省略时使用目标隔离的资源键，适合本仓库两个示例。

`execute` 接收完整 action，可将 action.id 用作外部幂等键。先校验 precondition，再产生副作用。`reconcile` 只能根据独立回执或当前状态返回 known=true；未知不得解释为未执行。新能力包应测试响应丢失、前置条件变化、重复调用和独立验收失败。

本地示例刻意不提供任意 Shell。扩展检查命令时，操作者在能力包中固定可执行文件/参数、工作目录、环境白名单和超时，不能接受模型生成的 shell 字符串；验收器放在 Agent 无法修改的位置。

## 验证层级

`tests/runtimes.test.ts` 回放 Codex 子进程 JSON-RPC；`tests/sdk-replay.test.ts` 回放其余三个 SDK 的事件和权限选项；`scripts/sdk-smoke.ts` 使用实际安装 SDK 握手/构图，不发模型请求；`scripts/live.ts` 才执行真实模型任务。必须分别报告这四层，缺认证记 skipped，不记通过。
