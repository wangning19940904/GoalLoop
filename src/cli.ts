#!/usr/bin/env node
import { Command } from 'commander';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Store } from './db.js';
import { Engine } from './engine.js';
import { config } from './config.js';
import { Worker } from './worker.js';
import { createServer } from './server.js';
import { probeRuntimes } from './runtimes/index.js';
import { parsePolicy } from './policy.js';
import { goalInput, runtimeId } from './contracts.js';
import { loadCapabilityPacks } from './extensions.js';
await loadCapabilityPacks();
const cli = new Command()
  .name('goalloop')
  .description('持久目标、人机协作与独立验收')
  .option('--url <url>', '本机 API 地址', config.baseUrl)
  .option('--json', 'JSON 输出');
function output(x: any) {
  console.log(JSON.stringify(x, null, 2));
}
async function api(route: string, body?: any, method = 'POST') {
  const url = cli.opts().url;
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('首版 CLI 只连接本机服务');
  const session = (await fetch(url + '/api/v1/session').then((r) => r.json())) as any;
  const r = await fetch(url + '/api/v1' + route, {
    method: body === undefined ? 'GET' : method,
    headers: { 'Content-Type': 'application/json', 'X-GoalLoop-Token': session.csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await r.json();
  if (!r.ok) throw new Error((value as any).error);
  return value;
}
cli
  .command('init')
  .description('迁移专用数据库并创建本地目录')
  .action(async () => {
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    const db = new Store();
    try {
      await db.migrate();
      output({ ready: true, database: 'configured PostgreSQL database', dataDir: config.dataDir });
    } finally {
      await db.close();
    }
  });
cli.command('doctor').action(async () => {
  const db = new Store();
  let database = false;
  try {
    await db.q('SELECT 1');
    database = true;
  } catch {
  } finally {
    await db.close();
  }
  output({
    database,
    port: config.port,
    notificationConfigured: !!process.env.FEISHU_WEBHOOK,
    runtimes: await probeRuntimes(),
  });
});
async function service(withApi: boolean, withWorker: boolean) {
  const db = new Store();
  await db.migrate();
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const engine = new Engine(db);
  const signal = new AbortController();
  const app = withApi ? await createServer(engine, { logger: true }) : null;
  if (app)
    await app.listen({
      host: process.env.GOALLOOP_CONTAINER === '1' ? '0.0.0.0' : '127.0.0.1',
      port: config.port,
    });
  const worker = new Worker(engine);
  const loop = withWorker ? worker.loop(signal.signal) : Promise.resolve();
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    signal.abort();
    for (const c of worker.activeControllers) c.abort();
    await loop;
    if (app) await app.close();
    await db.close();
  };
  process.once('SIGINT', () => {
    void stop();
  });
  process.once('SIGTERM', () => {
    void stop();
  });
  if (!app) console.log('GoalLoop worker running');
}
cli
  .command('serve')
  .option('--worker', '同进程启动 Worker')
  .action((o) => service(true, !!o.worker));
cli.command('worker').action(() => service(false, true));
const goal = cli.command('goal');
goal.command('list').action(async () => output(await api('/goals')));
goal.command('show <id>').action(async (id) => output(await api(`/goals/${id}`)));
goal
  .command('create <objective>')
  .option('--title <title>')
  .option('--pack <pack>', 'cluster | workspace | manual', 'cluster')
  .option('--runtime <runtime>', '执行器', 'simulator')
  .option('--model <model>')
  .option('--mode <mode>', 'achieve | maintain', 'achieve')
  .option('--workspace <path>', '复制本地 calculator.js 到专用示例工作区')
  .option('--rules <path>')
  .option('--policy <path>')
  .option('--file <path>', '完整 JSON 目标契约')
  .option('--start', '创建后激活')
  .action(async (objective, o) => {
    const spec = o.file
      ? JSON.parse(await readFile(o.file, 'utf8'))
      : {
          title: o.title || objective.slice(0, 100),
          objective,
          pack: o.pack,
          runtime: o.runtime,
          model: o.model,
          mode: o.mode,
          workspace: o.workspace,
          rules: o.rules ? await readFile(o.rules, 'utf8') : '',
          policy: o.policy ? parsePolicy(await readFile(o.policy, 'utf8')) : undefined,
        };
    const created: any = await api('/goals', goalInput.parse(spec));
    if (o.start) await api(`/goals/${created.id}/start`, {});
    output(created);
  });
for (const action of ['start', 'pause', 'resume', 'cancel'])
  goal
    .command(`${action} <id>`)
    .action(async (id) => output(await api(`/goals/${id}/${action}`, {})));
goal
  .command('revise <id> <file>')
  .description('读取 JSON patch，生成新的目标版本')
  .action(async (id, file) => {
    const { goal }: any = await api(`/goals/${id}`);
    output(
      await api(
        `/goals/${id}`,
        { version: goal.version, patch: JSON.parse(await readFile(file, 'utf8')) },
        'PATCH',
      ),
    );
  });
goal
  .command('runtime <id> <runtime>')
  .option('--model <model>')
  .action(async (id, runtime, o) => {
    const { goal }: any = await api(`/goals/${id}`);
    output(
      await api(
        `/goals/${id}`,
        { version: goal.version, patch: { runtime: runtimeId.parse(runtime), model: o.model } },
        'PATCH',
      ),
    );
  });
goal
  .command('event <id> <eventId>')
  .option('--task <taskId>')
  .option('--name <name>', '事件名称', 'external-update')
  .action(async (id, eventId, o) =>
    output(await api(`/goals/${id}/events`, { eventId, taskId: o.task, name: o.name })),
  );
cli.command('inbox').action(async () => output(await api('/inbox')));
cli
  .command('answer <id> <text>')
  .action(async (id, text) =>
    output(await api(`/human/${id}/answer`, { decision: 'answer', text })),
  );
for (const d of ['approve', 'reject'])
  cli
    .command(`${d} <id>`)
    .option('--note <text>', '决策说明', '')
    .action(async (id, o) =>
      output(await api(`/human/${id}/answer`, { decision: d, text: o.note })),
    );
cli
  .command('reconcile <id> <outcome> <note>')
  .action(async (id, outcome, note) =>
    output(await api(`/actions/${id}/reconcile`, { outcome, note })),
  );
cli
  .command('demo')
  .option('--pack <pack>', 'cluster | workspace', 'cluster')
  .option('--fast', '使用短观察周期')
  .option('--runtime <runtime>', '执行器', 'simulator')
  .action(async (o) => {
    const g: any = await api('/goals', {
      title: o.pack === 'cluster' ? '把机器健康分治理到 80 以上' : '修复本地加法函数',
      objective:
        o.pack === 'cluster'
          ? '逐台机器健康分达到 80 以上，遵守规则并提供独立验收证据'
          : '修复 calculator.js 的加法逻辑，支持负数、零和小数并通过独立检查',
      pack: o.pack,
      runtime: o.runtime,
      ...(o.fast ? { stableMs: 2000, sampleMs: 1000, freshMs: 3000 } : {}),
    });
    await api(`/goals/${g.id}/start`, {});
    output({
      id: g.id,
      url: `${cli.opts().url}/?goal=${g.id}`,
      note: '集群示例会请求一次重启审批和一次人工硬件修复',
    });
  });
cli
  .command('simulator <id> <node>')
  .option('--score <number>')
  .option('--fault <kind>')
  .option('--stale', '模拟数据过期')
  .action(async (id, node, o) =>
    output(
      await api(`/goals/${id}/simulator/${node}`, {
        score: o.score === undefined ? undefined : Number(o.score),
        fault: o.fault,
        stale: !!o.stale,
      }),
    ),
  );
cli.command('export <id> <file>').action(async (id, file) => {
  await writeFile(path.resolve(file), JSON.stringify(await api(`/goals/${id}`), null, 2), {
    mode: 0o600,
  });
  output({ file: path.resolve(file) });
});
cli.parseAsync().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
