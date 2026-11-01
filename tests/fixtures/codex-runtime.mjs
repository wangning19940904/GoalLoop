#!/usr/bin/env node
import readline from 'node:readline';
const send = (x) => process.stdout.write(JSON.stringify(x) + '\n');
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fixture' } });
  if (m.method === 'thread/resume')
    send({ id: m.id, error: { code: -32000, message: 'Session missing' } });
  if (m.method === 'thread/start') {
    if (m.params.sandbox !== 'read-only' || m.params.config['features.shell_tool'] !== false)
      throw new Error('Unsafe boundary');
    send({ id: m.id, result: { thread: { id: 'fixture-session' } } });
  }
  if (m.method === 'turn/start') {
    send({ id: m.id, result: { turn: { id: 'fixture-turn' } } });
    send({
      id: 900,
      method: 'item/tool/call',
      params: {
        tool: 'finish_turn',
        arguments: { outcome: 'candidate', summary: 'Ready for external verification' },
      },
    });
  }
  if (m.id === 900 && m.result) {
    send({
      method: 'item/completed',
      params: {
        item: {
          type: 'agentMessage',
          text: '{"outcome":"candidate","summary":"Verified by tools"}',
        },
      },
    });
    send({
      method: 'thread/tokenUsage/updated',
      params: {
        tokenUsage: {
          last: { inputTokens: 123, outputTokens: 45 },
          total: { inputTokens: 1123, outputTokens: 545 },
        },
      },
    });
    for (let i = 0; i < 2; i++)
      send({
        method: 'thread/tokenUsage/updated',
        params: {
          tokenUsage: {
            last: { inputTokens: 25, outputTokens: 7 },
            total: { inputTokens: 1148, outputTokens: 552 },
          },
        },
      });
    send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  }
}
