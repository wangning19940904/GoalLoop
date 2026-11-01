import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parse as parseToml } from 'smol-toml';
import type { RuntimeAdapter, RuntimeEvent, TurnPacket } from '../contracts.js';
import { RpcProcess, childEnv, exec, prompt, parseResult } from './common.js';
export function disableInheritedMcp(text: string) {
  let config: any;
  try {
    config = parseToml(text);
  } catch {
    throw new Error('Cannot safely parse Codex config; refusing to inherit unverified tools');
  }
  const overrides: string[] = [];
  const bare = (key: string) => {
    if (!/^[A-Za-z0-9_-]+$/.test(key))
      throw new Error('Codex MCP/profile name cannot be safely overridden; use a bare identifier');
    return key;
  };
  for (const name of Object.keys(config.mcp_servers || {}))
    overrides.push(`mcp_servers.${bare(name)}.enabled=false`);
  for (const [profile, value] of Object.entries(config.profiles || {}) as [string, any][]) {
    for (const name of Object.keys(value.mcp_servers || {})) {
      overrides.push(
        `mcp_servers.${bare(name)}.enabled=false`,
        `profiles.${bare(profile)}.mcp_servers.${bare(name)}.enabled=false`,
      );
    }
  }
  return overrides;
}
export class Codex implements RuntimeAdapter {
  bin = process.env.CODEX_BIN || 'codex';
  async probe() {
    try {
      const { stdout } = await exec(this.bin, ['--version'], { timeout: 10000 });
      const auth = await exec(this.bin, ['login', 'status'], { timeout: 10000 }).catch(() => ({
        stdout: '',
        stderr: '',
      }));
      return {
        id: 'codex',
        available: true,
        authenticated: /Logged in/i.test(auth.stdout + auth.stderr),
        version: stdout.trim(),
      };
    } catch (e) {
      return { id: 'codex', available: false, authenticated: false, reason: String(e) };
    }
  }
  async *runTurn(p: TurnPacket, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    const args = [
      'app-server',
      '--stdio',
      '-c',
      'features.shell_tool=false',
      '-c',
      'features.unified_exec=false',
      '-c',
      'features.multi_agent=false',
      '-c',
      'features.code_mode=false',
      '-c',
      'features.js_repl=false',
      '-c',
      'features.hooks=false',
      '-c',
      'features.apps=false',
      '-c',
      'web_search="disabled"',
    ];
    // Explicitly disable inherited MCP entries; the only tools are controller-owned dynamic tools.
    const text = await readFile(
      path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'),
      'utf8',
    ).catch((e) => {
      if (e.code === 'ENOENT') return '';
      throw new Error('Cannot read Codex config; refusing to inherit unverified tools');
    });
    for (const override of disableInheritedMcp(text)) args.push('-c', override);
    const rpc = new RpcProcess(this.bin, args, {
      cwd: p.runtimeHome,
      env: childEnv(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
    });
    const abort = () => {
      void rpc.close();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      await rpc.request('initialize', {
        clientInfo: { name: 'goalloop', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      rpc.send({ method: 'initialized' });
      const settings = {
        cwd: p.runtimeHome,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        model: p.goal.spec.model || process.env.CODEX_MODEL || undefined,
        config: {
          'features.shell_tool': false,
          'features.unified_exec': false,
          'features.multi_agent': false,
          'features.hooks': false,
          web_search: 'disabled',
        },
        developerInstructions:
          'Only controller-provided GoalLoop tools are authorized. No direct filesystem, shell, external tools or goal-control calls.',
      };
      let started: any;
      if (p.sessionId) {
        try {
          started = await rpc.request('thread/resume', { threadId: p.sessionId, ...settings });
        } catch {}
      }
      if (!started)
        started = await rpc.request('thread/start', {
          ...settings,
          dynamicTools: p.tools.map((t) => ({
            type: 'function',
            name: t.name,
            description: t.description,
            inputSchema: t.schema,
          })),
          persistExtendedHistory: true,
        });
      const threadId = started.thread.id;
      yield { type: 'session', sessionId: threadId };
      await rpc.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt(p), text_elements: [] }],
      });
      let final = '';
      let baseline: { input: number; output: number } | undefined;
      for await (const message of rpc.events) {
        signal.throwIfAborted();
        if (message.method === 'transport/closed') throw new Error(message.error);
        if (message.id !== undefined) {
          if (message.method === 'item/tool/call') {
            try {
              const result = await p.callTool(message.params.tool, message.params.arguments);
              rpc.send({
                id: message.id,
                result: {
                  contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
                  success: true,
                },
              });
            } catch (e) {
              rpc.send({
                id: message.id,
                result: {
                  contentItems: [{ type: 'inputText', text: JSON.stringify({ error: String(e) }) }],
                  success: false,
                },
              });
            }
          } else if (message.method?.includes('permissions'))
            rpc.send({ id: message.id, result: { permissions: {}, scope: 'turn' } });
          else if (message.method?.includes('requestApproval'))
            rpc.send({ id: message.id, result: { decision: 'decline' } });
          else if (message.method?.includes('requestUserInput')) {
            await p.callTool('request_human', {
              type: 'clarification',
              question: JSON.stringify(message.params.questions),
              reason: '执行器请求输入',
            });
            rpc.send({ id: message.id, result: { answers: {} } });
          } else
            rpc.send({
              id: message.id,
              error: { code: -32601, message: 'Not supported by GoalLoop' },
            });
        }
        if (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage') {
          final = message.params.item.text || '';
          yield { type: 'text', text: final };
        }
        if (message.method === 'thread/tokenUsage/updated') {
          const usage = message.params.tokenUsage,
            u = usage?.last,
            total = usage?.total;
          if (total && u) {
            baseline ??= {
              input: total.inputTokens - u.inputTokens,
              output: total.outputTokens - u.outputTokens,
            };
            yield {
              type: 'usage',
              input: Math.max(0, total.inputTokens - baseline.input),
              output: Math.max(0, total.outputTokens - baseline.output),
            };
          } else if (u)
            yield { type: 'usage', input: u.inputTokens || 0, output: u.outputTokens || 0 };
        }
        if (message.method === 'turn/completed') {
          if (message.params.turn?.status === 'failed')
            throw new Error(JSON.stringify(message.params.turn.error));
          yield { type: 'result', result: parseResult(final) };
          break;
        }
      }
    } finally {
      signal.removeEventListener('abort', abort);
      await rpc.close();
    }
  }
}
