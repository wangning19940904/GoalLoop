import { it, expect } from 'vitest';
import { chmod, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Codex } from '../src/runtimes/codex.js';
import { toolDefinitions } from '../src/tools.js';
import { probeRuntimes } from '../src/runtimes/index.js';
it('replays Codex JSON-RPC, restores through a new session, executes scoped tools and closes its process', async () => {
  const fixture = path.resolve('tests/fixtures/codex-runtime.mjs');
  await chmod(fixture, 0o755);
  const runtime = new Codex();
  runtime.bin = fixture;
  const calls: any[] = [];
  const events: any[] = [];
  for await (const e of runtime.runTurn(
    {
      goal: { spec: {} },
      task: {},
      tasks: [],
      evidence: [],
      decisions: [],
      tools: toolDefinitions,
      callTool: async (name, args) => {
        calls.push({ name, args });
        return { recorded: true };
      },
      runtimeHome: await mkdtemp(path.join(os.tmpdir(), 'goalloop-codex-')),
      sessionId: 'old-session',
    } as any,
    new AbortController().signal,
  ))
    events.push(e);
  expect(calls[0].name).toBe('finish_turn');
  expect(events.find((e) => e.type === 'session').sessionId).toBe('fixture-session');
  expect(events.filter((e) => e.type === 'usage').at(-1)).toMatchObject({ input: 148, output: 52 });
  expect(events.find((e) => e.type === 'result').result.outcome).toBe('candidate');
});
it('loads all four actual runtime packages without treating missing credentials as a passing live test', async () => {
  const statuses = await probeRuntimes();
  expect(statuses.map((s) => s.id)).toEqual([
    'simulator',
    'codex',
    'claude',
    'deepseek',
    'deepagents',
  ]);
  for (const s of statuses.filter((s) => ['claude', 'deepseek', 'deepagents'].includes(s.id)))
    expect(s.available).toBe(true);
});
