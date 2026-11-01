import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { probeRuntimes } from '../src/runtimes/index.js';
import { config } from '../src/config.js';
const requested = process.argv.slice(2);
const statuses = await probeRuntimes();
const report: any[] = [];
async function api(route: string, body?: any) {
  const session: any = await fetch(config.baseUrl + '/api/v1/session').then((r) => r.json());
  const r = await fetch(config.baseUrl + '/api/v1' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-GoalLoop-Token': session.csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value: any = await r.json();
  if (!r.ok) throw new Error(value.error);
  return value;
}
for (const r of statuses.filter(
  (s) => s.id !== 'simulator' && (!requested.length || requested.includes(s.id)),
)) {
  if (!r.available || !r.authenticated) {
    report.push({
      runtime: r.id,
      status: 'skipped',
      reason: r.reason || 'Unavailable or unauthenticated',
    });
    continue;
  }
  let g: any;
  try {
    g = await api('/goals', {
      title: `真实执行器验收 · ${r.id}`,
      objective:
        '通过 GoalLoop 工具读取 calculator.js，修复 add(a,b) 的加法逻辑，使正数、负数、零和小数输入通过独立检查。只操作授权文件。完成后调用 finish_turn。',
      pack: 'workspace',
      runtime: r.id,
      stableMs: 0,
      sampleMs: 1000,
      freshMs: 5000,
      maxAttempts: 1,
      maxTurns: 2,
      turnTimeoutMs: 120000,
    });
    await api(`/goals/${g.id}/start`, {});
    const limit = Date.now() + 180000;
    let d: any;
    while (Date.now() < limit) {
      d = await api(`/goals/${g.id}`);
      if (d.goal.status === 'succeeded' || d.human_tasks.some((h: any) => h.status === 'pending'))
        break;
      await delay(1000);
    }
    const passed = d.goal.status === 'succeeded';
    report.push({
      runtime: r.id,
      status: passed ? 'passed' : 'failed',
      goalId: g.id,
      runs: d.runs.map((r: any) => ({
        status: r.status,
        error: r.error,
        summary: r.summary,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
      })),
    });
    if (!passed) {
      await api(`/goals/${g.id}/cancel`, {});
      process.exitCode = 1;
    }
  } catch (e) {
    report.push({ runtime: r.id, status: 'failed', error: String(e) });
    if (g) await api(`/goals/${g.id}/cancel`, {}).catch(() => {});
    process.exitCode = 1;
  }
}
await mkdir('.data/validation', { recursive: true });
await writeFile(
  '.data/validation/live.json',
  JSON.stringify({ at: new Date().toISOString(), report }, null, 2),
);
console.log(JSON.stringify(report, null, 2));
