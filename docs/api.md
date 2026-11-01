# HTTP API v1

服务默认 `http://127.0.0.1:12400`，只接受本机 Host 与同源浏览器访问。JSON 请求/响应；错误为 `{ "error": "..." }`，schema 错误 400、权限 403、版本/状态冲突 409、缺失资源 404。未知服务错误不将原始内部异常返回浏览器。

浏览器/CLI 先 `GET /api/v1/session` 取得 csrf，之后写请求在 `X-GoalLoop-Token` 携带。服务重启后令牌变化，重新获取即可。此机制用于跨站请求防护，不是用户账户认证。

| 方法与路径（均在 /api/v1 下）        | 请求/结果                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| GET /health                          | 数据库连通与版本                                                               |
| GET /session                         | 本次启动控制 token、本机模式与通知配置状态                                     |
| GET /runtimes                        | 安装/认证探测，认证配置不等于模型调用验证                                      |
| GET /packs                           | 已安装能力包、能力 schema、策略模板                                            |
| GET /goals                           | 目标列表                                                                       |
| POST /goals                          | GoalInput；创建草稿并冻结 scope                                                |
| GET /goals/:id                       | goal、tasks、runs、human_tasks、actions、evidence、jobs、outbox、nodes、events |
| PATCH /goals/:id                     | `{version, patch}` 乐观并发修改，生成新版本                                    |
| POST /goals/:id/start                | `{}` 激活草稿                                                                  |
| POST /goals/:id/pause                | `{}` 停止新动作并撤销运行租约                                                  |
| POST /goals/:id/resume               | `{}` 恢复暂停/阻塞目标                                                         |
| POST /goals/:id/cancel               | `{}` 取消；已派发动作仍核对                                                    |
| GET /inbox                           | 待处理人工事项                                                                 |
| POST /human/:id/answer               | `{decision: "approve" \| "reject" \| "answer", text}`                          |
| POST /actions/:id/reconcile          | `{outcome: "confirmed" \| "not_applied", note}`，仅操作者核对未知动作          |
| POST /goals/:id/events               | `{eventId, name, taskId?, data?}`，去重唤醒外部事件等待                        |
| POST /goals/:id/simulator/:node      | `{score?, fault?, stale?}`，仅操作者修改模拟环境                               |
| POST /notifications/:id/retry        | `{}` 重试已失败投递                                                            |
| GET /events?after=cursor&goalId=uuid | SSE，可用 Last-Event-ID 重连，按事件 ID 单调续读                               |
| POST /mcp                            | Scoped Bearer run token；无管理能力                                            |

创建示例：

```json
{
  "title": "集群健康治理",
  "objective": "将冻结清单内每台机器的健康分提升到 80 以上",
  "pack": "cluster",
  "runtime": "simulator",
  "mode": "achieve",
  "rules": "遇到硬件问题请请求外部协作。",
  "deadlineMs": 604800000,
  "stableMs": 1800000,
  "sampleMs": 60000,
  "freshMs": 120000,
  "threshold": 80,
  "maxTurns": 100,
  "maxAttempts": 3,
  "turnTimeoutMs": 600000
}
```

省略 policy 使用该能力包的显式默认模板；传空数组表示拒绝所有受管能力。模板出现在创建后的契约中，由用户确认后启动。自定义工作区路径仅作为示例源文件复制入口。scope 由能力包冻结，不能通过 patch 缩小以排除失败资源。

详情最近返回 100 条事件、运行及证据；完整历史保存在数据库，SSE 可按游标获取完整事件。首版无需分页的其他列表面向单用户小规模场景。
