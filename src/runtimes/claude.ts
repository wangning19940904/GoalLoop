import type { RuntimeAdapter, RuntimeEvent, TurnPacket } from '../contracts.js';
import { childEnv, prompt, parseResult } from './common.js';
export class Claude implements RuntimeAdapter {
  async probe() {
    try {
      await import('@anthropic-ai/claude-agent-sdk');
      return {
        id: 'claude',
        available: true,
        authenticated: !!process.env.ANTHROPIC_API_KEY,
        version: '0.3.296',
        reason: process.env.ANTHROPIC_API_KEY
          ? undefined
          : '需要 ANTHROPIC_API_KEY；不会读取或复制其他应用凭证',
      };
    } catch (e) {
      return { id: 'claude', available: false, authenticated: false, reason: String(e) };
    }
  }
  async *runTurn(p: TurnPacket, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY');
    const model = p.goal.spec.model || process.env.CLAUDE_MODEL;
    if (!model) throw new Error('Set CLAUDE_MODEL or goal model');
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    const allowed = p.tools.map((t) => `mcp__goalloop__${t.name}`);
    const run = query({
      prompt: prompt(p),
      options: {
        model,
        cwd: p.runtimeHome,
        abortController: controller,
        resume: p.sessionId,
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        permissionMode: 'default',
        env: childEnv({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }),
        mcpServers: {
          goalloop: {
            type: 'http',
            url: `${p.apiUrl}/api/v1/mcp`,
            headers: { Authorization: `Bearer ${p.token}` },
          },
        },
        allowedTools: allowed,
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (input: any) =>
                  allowed.includes(input.tool_name)
                    ? {}
                    : {
                        hookSpecificOutput: {
                          hookEventName: 'PreToolUse',
                          permissionDecision: 'deny',
                          permissionDecisionReason: 'Only GoalLoop gateway tools are available',
                        },
                      },
              ],
            },
          ],
        },
        canUseTool: async (name, input) =>
          allowed.includes(name)
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'Use GoalLoop tools' },
        maxTurns: 30,
      },
    });
    try {
      for await (const m of run) {
        signal.throwIfAborted();
        if (m.type === 'system' && m.subtype === 'init')
          yield { type: 'session', sessionId: m.session_id };
        if (m.type === 'assistant') {
          for (const b of m.message.content)
            if (b.type === 'text') yield { type: 'text', text: b.text };
        }
        if (m.type === 'result') {
          if (m.usage)
            yield { type: 'usage', input: m.usage.input_tokens, output: m.usage.output_tokens };
          if (m.subtype === 'success') yield { type: 'result', result: parseResult(m.result) };
          else throw new Error(`Claude ${m.subtype}: ${JSON.stringify(m.errors)}`);
        }
      }
    } finally {
      signal.removeEventListener('abort', abort);
      run.close();
    }
  }
}
