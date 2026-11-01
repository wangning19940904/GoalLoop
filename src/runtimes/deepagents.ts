import type { RuntimeAdapter, RuntimeEvent, TurnPacket } from '../contracts.js';
import { config } from '../config.js';
import { prompt, parseResult } from './common.js';
export class DeepAgents implements RuntimeAdapter {
  async probe() {
    try {
      await import('deepagents');
      return {
        id: 'deepagents',
        available: true,
        authenticated: !!process.env.DEEPAGENTS_API_KEY,
        version: '1.14.2',
        reason: process.env.DEEPAGENTS_API_KEY
          ? undefined
          : '需要 DEEPAGENTS_API_KEY 和显式模型设置',
      };
    } catch (e) {
      return { id: 'deepagents', available: false, authenticated: false, reason: String(e) };
    }
  }
  async *runTurn(p: TurnPacket, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    const key = process.env.DEEPAGENTS_API_KEY;
    const model = p.goal.spec.model || process.env.DEEPAGENTS_MODEL;
    if (!key || !model) throw new Error('Set DEEPAGENTS_API_KEY and DEEPAGENTS_MODEL');
    const [
      { createDeepAgent, StateBackend },
      { tool, createMiddleware },
      { ChatOpenAI },
      { PostgresSaver },
      { ToolMessage },
    ] = await Promise.all([
      import('deepagents'),
      import('langchain'),
      import('@langchain/openai'),
      import('@langchain/langgraph-checkpoint-postgres'),
      import('@langchain/core/messages'),
    ]);
    const checkpoint = PostgresSaver.fromConnString(config.databaseUrl, {
      schema: 'goalloop_runtime',
    });
    try {
      await checkpoint.setup();
      const names = new Set(p.tools.map((t) => t.name));
      const tools = p.tools.map((t) =>
        tool(async (args: any) => JSON.stringify(await p.callTool(t.name, args)), {
          name: t.name,
          description: t.description,
          schema: t.schema as any,
        }),
      );
      const boundary = createMiddleware({
        name: 'GoalLoopBoundary',
        wrapModelCall: async (req: any, next: any) =>
          next({ ...req, tools: req.tools.filter((t: any) => names.has(t.name)) }),
        wrapToolCall: async (req: any, next: any) =>
          names.has(req.toolCall.name)
            ? next(req)
            : new ToolMessage({
                content: 'Denied: only GoalLoop gateway tools are authorized',
                tool_call_id: req.toolCall.id || '',
              }),
      });
      const agent = await createDeepAgent({
        model: new ChatOpenAI({
          model,
          apiKey: key,
          configuration: { baseURL: process.env.DEEPAGENTS_BASE_URL || 'https://api.deepseek.com' },
          maxTokens: 8192,
          temperature: 0,
        }),
        tools,
        middleware: [boundary],
        backend: new StateBackend(),
        permissions: [{ operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }],
        subagents: [],
        checkpointer: checkpoint,
        systemPrompt:
          'All real work must use GoalLoop tools. You cannot finish the business goal directly. Do not use built-in filesystem or delegation tools.',
      });
      const sessionId = p.sessionId || `${p.goal.id}:${p.task.id}`;
      yield { type: 'session', sessionId };
      const stream = await agent.stream(
        { messages: [{ role: 'user', content: prompt(p) }] },
        {
          configurable: { thread_id: sessionId },
          signal,
          recursionLimit: 60,
          streamMode: 'updates',
        },
      );
      let last = '';
      let input = 0,
        output = 0,
        usageKnown = false;
      for await (const update of stream) {
        signal.throwIfAborted();
        for (const value of Object.values(update) as any[]) {
          for (const message of value?.messages || []) {
            if (message.getType?.() === 'ai') {
              if (typeof message.content === 'string' && message.content) {
                last = message.content;
                yield { type: 'text', text: last };
              }
              if (message.usage_metadata) {
                usageKnown = true;
                input += message.usage_metadata.input_tokens;
                output += message.usage_metadata.output_tokens;
              }
            }
          }
        }
        if ((update as any).__interrupt__) {
          await p.callTool('request_human', {
            type: 'clarification',
            question: 'Deep Agents 执行被中断，需要检查',
            reason: JSON.stringify((update as any).__interrupt__),
          });
          yield {
            type: 'result',
            result: { outcome: 'need_human', summary: '执行器中断已转换为人工事项' },
          };
          return;
        }
      }
      if (usageKnown) yield { type: 'usage', input, output };
      yield { type: 'result', result: parseResult(last) };
    } finally {
      await checkpoint.end();
    }
  }
}
