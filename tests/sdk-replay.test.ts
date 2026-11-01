import { it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Claude } from '../src/runtimes/claude.js';
import { DeepSeek } from '../src/runtimes/deepseek.js';
import { DeepAgents } from '../src/runtimes/deepagents.js';
import { toolDefinitions } from '../src/tools.js';
import { classifyError } from '../src/runtimes/common.js';
const mock = vi.hoisted(() => ({
  claudeOptions: null as any,
  deepseekOptions: null as any,
  deepagentsOptions: null as any,
  closed: 0,
}));
const result = { outcome: 'candidate', summary: 'Artifact ready for independent verification' };
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: any) => {
    mock.claudeOptions = options;
    return {
      close() {
        mock.closed++;
      },
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'claude-replay' };
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Investigating' }] },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: JSON.stringify(result),
          usage: { input_tokens: 23, output_tokens: 7 },
        };
      },
    };
  },
}));
vi.mock('@deepseek-ai/dsh-sdk-client', () => ({
  DeepSeekHarness: class {
    constructor(options: any) {
      mock.deepseekOptions = options;
    }
    async run(_: string, options: any) {
      options.onNotification({
        method: 'session.event',
        params: { event: { type: 'assistant.message', content: 'Investigating' } },
      });
      return { sessionId: 'deepseek-replay', finalResponse: JSON.stringify(result), events: [] };
    }
    async close() {
      mock.closed++;
    }
  },
}));
vi.mock('@langchain/langgraph-checkpoint-postgres', () => ({
  PostgresSaver: {
    fromConnString: () => ({
      setup: async () => {},
      end: async () => {
        mock.closed++;
      },
    }),
  },
}));
vi.mock('deepagents', () => ({
  StateBackend: class {},
  createDeepAgent: async (options: any) => {
    mock.deepagentsOptions = options;
    return {
      stream: async () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            model: {
              messages: [
                {
                  getType: () => 'ai',
                  content: JSON.stringify(result),
                  usage_metadata: { input_tokens: 23, output_tokens: 7 },
                },
              ],
            },
          };
        },
      }),
    };
  },
}));
afterEach(() => vi.unstubAllEnvs());
for (const [id, Runtime, key] of [
  ['claude', Claude, 'ANTHROPIC_API_KEY'],
  ['deepseek', DeepSeek, 'DEEPSEEK_API_KEY'],
  ['deepagents', DeepAgents, 'DEEPAGENTS_API_KEY'],
] as const) {
  it(`${id} replays SDK events through the unified contract and closes resources`, async () => {
    vi.stubEnv(key, 'replay-only');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'goalloop-replay-'));
    const events: any[] = [];
    const old = mock.closed;
    try {
      for await (const event of new Runtime().runTurn(
        {
          runId: 'replay',
          sessionId: 'replay-context',
          goal: { id: 'goal', spec: { model: 'replay-model' } },
          task: { id: 'task' },
          tasks: [],
          evidence: [],
          decisions: [],
          tools: toolDefinitions,
          callTool: async () => ({ ok: true }),
          runtimeHome: dir,
          apiUrl: 'http://127.0.0.1:12400',
          token: 'scoped-test-token',
        } as any,
        new AbortController().signal,
      ))
        events.push(event);
      expect(events.find((e) => e.type === 'session').sessionId).toContain('replay');
      expect(events.at(-1)).toEqual({ type: 'result', result });
      expect(mock.closed).toBeGreaterThan(old);
      if (id === 'claude') {
        expect(mock.claudeOptions.tools).toEqual([]);
        expect(mock.claudeOptions.strictMcpConfig).toBe(true);
        expect((await mock.claudeOptions.canUseTool('Bash', {})).behavior).toBe('deny');
        expect(
          (await mock.claudeOptions.hooks.PreToolUse[0].hooks[0]({ tool_name: 'Write' }))
            .hookSpecificOutput.permissionDecision,
        ).toBe('deny');
        expect(events.find((e) => e.type === 'usage')).toMatchObject({ input: 23, output: 7 });
      }
      if (id === 'deepseek') {
        expect(mock.deepseekOptions.profile).toBe('sdk-minimal');
        await expect(readFile(path.join(dir, 'replay.patch.yml'))).rejects.toThrow();
        expect(events.some((e) => e.type === 'usage')).toBe(false);
      }
      if (id === 'deepagents') {
        expect(mock.deepagentsOptions.permissions[0].mode).toBe('deny');
        expect(mock.deepagentsOptions.subagents).toEqual([]);
        expect(events.find((e) => e.type === 'usage')).toMatchObject({ input: 23, output: 7 });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
it('classifies failures without treating provider errors as completion', () => {
  expect(classifyError('Missing DEEPSEEK_API_KEY')).toBe('authentication');
  expect(classifyError('RPC timeout')).toBe('timeout');
  expect(classifyError('ECONNRESET')).toBe('transient');
  expect(classifyError('Lease revoked')).toBe('interrupted');
});
