# GoalLoop

**定义目标与授权边界，让 Agent 分轮持续推进；需要判断时找人，完成时交给独立验收。**

GoalLoop 是本机运行的 Web 控制台、CLI 和持久后台。控制面、数据库队列、授权和动作账本独立实现，不依赖同类长期 Agent 产品。PostgreSQL 保存所有业务状态；等待、服务重启和更换执行器后，任务可以继续。

首版内置模拟集群治理、隔离的本地代码修复和通用人工验收三种能力包，接入 Codex、Claude Code、DeepSeek Harness、Deep Agents，以及无需任何模型凭证的模拟执行器。

## 现在可以做什么

- 创建自然语言目标，审阅并激活版本化契约；Markdown 工作指导与结构化授权策略分开。
- achieve 达成并稳定后结束；maintain 持续采样、发现退化后重新治理，到期输出覆盖率、违规和缺失区间。
- 子任务和依赖独立调度；人工等待释放执行器，其他任务继续。
- allow / approval_required / deny 动作网关，绑定具体参数、版本、前置条件和有效期的单次审批。
- PostgreSQL 队列的租约、心跳与代次隔离；动作结果未知时核对回执，不盲目重复执行。
- 网页/CLI 收件箱、进展、证据、动作账本、时间线、通知失败重试与执行器诊断。
- 事务 outbox 飞书通知、运行范围内的 MCP、操作者安装的 CapabilityPack 扩展。

这不是生产集群连接器。两个自动示例在隔离环境运行；新的领域需要安装可信的能力包及独立验收器。首版不含团队账号、公网访问、插件市场或任意 Shell。自然语言本身不会自动获得生产权限。

## 五分钟启动

需要 Node.js 22、pnpm（仓库固定 12.9.1）、PostgreSQL 16+。数据库必须专用，不需要修改或升级已有项目数据库。

```sh
pnpm install --frozen-lockfile
createdb goalloop
createdb goalloop_test
cp .env.example .env
pnpm db:migrate
pnpm build
pnpm start
```

数据库已存在时跳过 createdb。默认连接 `postgresql://localhost/goalloop`；需要密码时在 `.env` 配置 DATABASE_URL，不提交凭证。

打开 **http://127.0.0.1:12400**。创建目标后检查契约，再点“启动目标”。不配置模型 key 也能完成两套示例。

本机端口约定：12400 主服务、12410 开发前端、12411 开发后端，均固定端口，冲突时失败。开发方式：

```sh
# 终端一
GOALLOOP_PORT=12411 GOALLOOP_BASE_URL=http://127.0.0.1:12411 pnpm dev
# 终端二
pnpm --filter @goalloop/web dev
```

API 和 Worker 可以分开：`pnpm cli serve` 与 `pnpm worker`；多个 Worker 可共用同一数据库。DeepSeek/Claude MCP 使用 GOALLOOP_BASE_URL，应指向实际 API 地址。

## 两条可演示闭环

### 模拟集群

```sh
pnpm demo --fast
```

打开命令返回的目标链接：node-01 清缓存已预授权，Agent 自主修复；node-02 重启会产生审批；node-03 硬件故障需要外部协作。在网页批准重启、点“模拟完成硬件更换”，再回复协作事项，系统重新采样并独立验收。

**只回复“已修好”不会提高健康分，也不会通过验收。** 普通模式固定三台机器逐台 ≥80，稳定 30 分钟，每分钟采样，证据有效 2 分钟。`--fast` 只将演示参数改为稳定 2 秒、每秒采样、证据有效 3 秒。

创建时选择 maintain，可在健康节点“注入退化”，观察重新治理；期限结束显示整个观测期报告。

### 本地代码修复

```sh
pnpm demo --pack workspace --fast
```

每个目标在 `.data/workspaces/<goal-id>/calculator.js` 建立隔离副本，初始加法函数有错误。Agent 经受控读取/写入修改代码，宿主验收器使用受限 QuickJS 检查正数、负数、零、小数。测试代码不在可修改工作区内。

有已登录 Codex 时可用真实模型：

```sh
pnpm demo --pack workspace --runtime codex --fast
```

`goal create --workspace /path/to/example` 或网页的源工作区字段会复制源目录下的 calculator.js；原文件不改动。首版 workspace 包只包含这个固定验收样例。任意代码仓库/检查命令应注册为新的受控能力，不能直接给模型任意终端。

## CLI

```sh
pnpm run doctor
pnpm cli goal list --json
pnpm cli goal create '把集群健康分治理到 80 以上' --title '集群治理' \
  --pack cluster --rules examples/RULES.md --policy examples/cluster-policy.yaml
pnpm cli goal start <goal-id>
pnpm cli goal show <goal-id>
pnpm cli inbox
pnpm cli approve <human-id> --note '批准卡片中的单次重启'
pnpm cli answer <human-id> '外部处理结果与证据'
pnpm cli goal pause <goal-id>
pnpm cli goal resume <goal-id>
pnpm cli goal runtime <goal-id> codex
pnpm cli goal revise <goal-id> patch.json
pnpm cli goal event <goal-id> <unique-event-id> --task <task-id>
pnpm cli reconcile <action-id> confirmed '独立核对证据'
pnpm cli goal cancel <goal-id>
pnpm cli export <goal-id> ./goal-report.json
```

输出默认即 JSON，`--json` 用于脚本显式声明。`pnpm run doctor` 必须带 `run`，避免误调用 pnpm 自己的 doctor 子命令。`--file examples/workspace-goal.json` 可传完整契约；创建仍需一个 objective 位置参数，该参数在使用 file 时由文件内容覆盖。

## 策略与预算

```yaml
rules:
  - capability: cluster.observe
    effect: allow
    resources: ['*']
  - capability: cluster.clean_cache
    effect: allow
    resources: ['node-01']
  - capability: cluster.restart
    effect: approval_required
    resources: ['node-02']
```

可匹配精确名称或 `*`，禁止优先，未声明默认拒绝。策略不能注册新能力，也不能改变内置工具的读写属性。契约变更使旧审批失效；同一版本内的资源前置条件变化也会阻止旧授权。

默认 `deadlineMs=7 天`、`turnTimeoutMs=10 分钟`、`maxAttempts=3`、`maxTurns=100`。可在 JSON 契约中设置 `tokenBudget`，按已返回的实际累计用量在轮次之间控制；单轮可能越过剩余额度，未知用量不当作 0，系统不声称精确费用硬限额。

## 配置真实执行器和飞书

| 执行器           | 操作者配置                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| Codex            | 安装 codex，完成 `codex login`；可选 CODEX_BIN / CODEX_MODEL                                              |
| Claude Code      | ANTHROPIC_API_KEY + CLAUDE_MODEL                                                                          |
| DeepSeek Harness | DEEPSEEK_API_KEY + DEEPSEEK_MODEL；SDK/runtime 固定同版本                                                 |
| Deep Agents      | DEEPAGENTS_API_KEY + DEEPAGENTS_MODEL；可选 DEEPAGENTS_BASE_URL，默认 DeepSeek OpenAI-compatible endpoint |

上述 SDK 已锁定在 pnpm-lock.yaml。模型 ID 使用账户实际可用的值，也可以在单个目标中填写。Web 只显示配置状态，不接收或返回密钥。

飞书机器人配置 `FEISHU_WEBHOOK`，启用签名时再配置 `FEISHU_SECRET`。后台仅在需要处理、完成、到期和投递失败等变化时记录/投递通知。失败采用退避重试，可在目标时间线查看/重试。未配置时 outbox 保留待发状态。网络投递为至少一次，极端情况下可能重复通知，但不能重复执行业务动作。

飞书里的链接指向本机 127.0.0.1 控制台，应在运行 GoalLoop 的这台电脑打开；手机上该地址不是这台电脑。首版不在飞书内审批，也不提供公网发布。

## 测试与验证证据

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
# 先启动主服务；浏览器恢复测试临时使用 12411，不能同时运行开发后端
pnpm test:e2e
pnpm exec tsx scripts/sdk-smoke.ts
pnpm test:live            # 只对具备凭证的执行器调用真实模型
```

测试只能连接名字以 `_test` 结尾的数据库；集成测试清空专用测试数据。浏览器恢复测试创建/使用 `goalloop_recovery_test`，需要测试数据库用户有 CREATEDB 权限。SDK smoke 使用 12411，不能与恢复测试/开发后端并发。

详细结果与边界见 [验证记录](docs/validation.md)。截图在 `test-results/`，真实 SDK/模型报告在 `.data/validation/`，不提交本机运行数据。没有模型认证的 live 测试明确输出 skipped。

## 常驻服务与部署

macOS 可选登录后常驻（先关闭手工启动的同端口服务）：

```sh
pnpm build
node scripts/service.mjs install
node scripts/service.mjs status
node scripts/service.mjs uninstall
```

日志在 `.data/logs/`。卸载只停止并移除 LaunchAgent，保留数据库和工作区。更新代码后 build 并重新 install；launchd 会在异常退出时重启。机器休眠/离线时没有后台执行，恢复后根据持久队列继续，并将遥测缺口计入缺失区间。

容器模板：`docker compose up --build -d`。Compose 使用独立 PostgreSQL 数据卷，HTTP 仅发布到宿主 127.0.0.1:12400。默认镜像运行模拟执行器；真实 Codex CLI/模型认证需要另行配置。不要把无账号 API 代理到公网。

迁移启动时自动执行并通过 advisory lock 串行化；只处理 DATABASE_URL 指定的库。备份需要同时备份 PostgreSQL 与 GOALLOOP_DATA_DIR，恢复后运行 init、启动服务，未决动作由账本核对。

## 代码导航

- [架构、状态机与信任边界](docs/architecture.md)
- [执行器、MCP 与能力包开发](docs/adapters.md)
- [HTTP API](docs/api.md)
- [验证记录与已知边界](docs/validation.md)
- `src/engine.ts` 业务事务 / `src/worker.ts` 队列、恢复和验收
- `src/packs.ts` 两套独立示例 / `src/runtimes/` 五个执行器
- `apps/web/` React 控制台 / `migrations/` PostgreSQL 迁移

许可证：MIT。
