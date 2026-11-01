import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import type { RuntimeAdapter, RuntimeEvent, TurnPacket } from '../contracts.js';
import { childEnv, prompt, parseResult, Queue } from './common.js';
export function harnessPatch(p: Pick<TurnPacket, 'apiUrl' | 'token'>) {
  return [
    ...['persistent-bash', 'persistent-pwsh', 'terminal-bash', 'terminal-pwsh', 'pty'].map(
      (id) => ({ id, disabled: true }),
    ),
    { id: 'sandbox-policy', config: { mode: 'read-only' } },
    {
      insert: [
        {
          id: 'goalloop-mcp',
          name: '@deepseek-ai/dsh-mcp-client',
          config: {
            transport: 'streamable-http',
            serverName: 'goalloop',
            url: `${p.apiUrl}/api/v1/mcp`,
            headers: { Authorization: `Bearer ${p.token}` },
            failOnStartupError: true,
          },
        },
      ],
    },
  ];
}
export class DeepSeek implements RuntimeAdapter {
  async probe() {
    try {
      await import('@deepseek-ai/dsh-sdk-client');
      return {
        id: 'deepseek',
        available: true,
        authenticated: !!process.env.DEEPSEEK_API_KEY,
        version: '0.2.0-rc.2',
        reason: process.env.DEEPSEEK_API_KEY ? undefined : '需要 DEEPSEEK_API_KEY',
      };
    } catch (e) {
      return { id: 'deepseek', available: false, authenticated: false, reason: String(e) };
    }
  }
  async *runTurn(p: TurnPacket, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    if (!process.env.DEEPSEEK_API_KEY) throw new Error('Missing DEEPSEEK_API_KEY');
    const model = p.goal.spec.model || process.env.DEEPSEEK_MODEL;
    if (!model) throw new Error('Set DEEPSEEK_MODEL or goal model');
    const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client');
    const patch = path.join(p.runtimeHome, `${p.runId}.patch.yml`);
    await writeFile(patch, stringify(harnessPatch(p)), { mode: 0o600 });
    const harness = new DeepSeekHarness({
      profile: 'sdk-minimal',
      patches: [patch],
      dshHome: p.runtimeHome,
      cwd: p.runtimeHome,
      processCwd: p.runtimeHome,
      provider: 'deepseek-official',
      model,
      maxTokens: 8192,
      initializeTimeoutMs: 30000,
      env: childEnv({
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
        DSH_SYSTEM_PROMPT:
          'Use only GoalLoop MCP tools. Never run shell commands. Long-term goals are managed by GoalLoop.',
      }),
    });
    const abort = () => {
      void harness.close().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const queue = new Queue<RuntimeEvent>();
      let failure: unknown;
      const pending = harness
        .run(prompt(p), {
          sessionId: p.sessionId,
          onNotification: (n) => {
            if (n.method === 'session.event')
              queue.push({ type: 'text', text: JSON.stringify(n.params.event).slice(0, 8000) });
          },
        })
        .then((result) => {
          queue.push({ type: 'session', sessionId: result.sessionId });
          queue.push({ type: 'text', text: result.finalResponse });
          queue.push({ type: 'result', result: parseResult(result.finalResponse) });
        })
        .catch((e) => {
          failure = e;
        })
        .finally(() => queue.end());
      for await (const event of queue) {
        signal.throwIfAborted();
        yield event;
      }
      await pending;
      signal.throwIfAborted();
      if (failure) throw failure;
    } finally {
      signal.removeEventListener('abort', abort);
      await harness.close();
      await rm(patch, { force: true });
    }
  }
}
