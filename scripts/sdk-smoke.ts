// Initializes the installed SDKs without sending a prompt to any model provider.
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { Store } from '../src/db.js';
import { Engine } from '../src/engine.js';
import { hash } from '../src/policy.js';
import { config } from '../src/config.js';
import { harnessPatch } from '../src/runtimes/deepseek.js';
import { childEnv, RpcProcess } from '../src/runtimes/common.js';
import { createServer } from '../src/server.js';
const temp = await mkdtemp(path.join(os.tmpdir(), 'goalloop-sdk-'));
const db = new Store();
const engine = new Engine(db);
const app = await createServer(engine, { port: 12411 });
await app.listen({ host: '127.0.0.1', port: 12411 });
const report: any[] = [];
let g: any;
async function check(runtime: string, fn: () => Promise<unknown>) {
  try {
    const details = await fn();
    report.push({ runtime, status: 'passed', details });
    console.log(runtime, 'initialized');
  } catch (e) {
    report.push({ runtime, status: 'failed', error: String(e) });
    console.error(runtime, String(e));
    process.exitCode = 1;
  }
}
try {
  g = await engine.create({
    title: 'SDK 初始化验证（无模型调用）',
    objective: '仅验证 SDK 加载和握手，不调用模型',
    pack: 'workspace',
  });
  // Keep the goal paused until the dedicated initialization lease is installed atomically.
  await db.tx(async (tx) => {
    await tx.q(
      "UPDATE goals SET status='active',activated_at=now(),deadline_at=now()+interval '1 hour' WHERE id=$1",
      [g.id],
    );
    const [task] = await tx.q("UPDATE tasks SET status='running' WHERE goal_id=$1 RETURNING *", [
      g.id,
    ]);
    const job = randomUUID(),
      run = randomUUID(),
      token = randomUUID();
    await tx.q(
      "INSERT INTO jobs(id,goal_id,task_id,kind,dedupe,status,epoch,lease_until) VALUES($1,$2,$3,'turn',$4,'running',1,now()+interval '10 minutes')",
      [job, g.id, task.id, `${g.id}:turn:${task.id}`],
    );
    await tx.q(
      "INSERT INTO runs(id,goal_id,task_id,job_id,epoch,goal_version,runtime,status,token_hash) VALUES($1,$2,$3,$4,1,1,'simulator','running',$5)",
      [run, g.id, task.id, job, hash(token)],
    );
    g.token = token;
  });
  await check('codex', async () => {
    const rpc = new RpcProcess(
      process.env.CODEX_BIN || 'codex',
      ['app-server', '--stdio', '-c', 'features.shell_tool=false'],
      { env: childEnv(), cwd: temp },
    );
    try {
      const result = await rpc.request('initialize', {
        clientInfo: { name: 'goalloop-smoke', version: '0.1' },
        capabilities: { experimentalApi: true },
      });
      return { handshake: !!result.userAgent };
    } finally {
      await rpc.close();
    }
  });
  await check('claude', async () => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    async function* noPrompts() {
      await new Promise<void>((r) =>
        controller.signal.addEventListener('abort', () => r(), { once: true }),
      );
    }
    const q = query({
      prompt: noPrompts(),
      options: {
        cwd: temp,
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        abortController: controller,
        env: childEnv(),
        mcpServers: {
          goalloop: {
            type: 'http',
            url: 'http://127.0.0.1:12411/api/v1/mcp',
            headers: { Authorization: `Bearer ${g.token}` },
          },
        },
      },
    });
    try {
      const init = await q.initializationResult();
      return { initialized: !!init };
    } finally {
      clearTimeout(timer);
      controller.abort();
      q.close();
    }
  });
  await check('deepseek', async () => {
    const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client');
    const patch = path.join(temp, 'boundary.yml');
    await writeFile(
      patch,
      stringify(harnessPatch({ apiUrl: 'http://127.0.0.1:12411', token: g.token })),
      { mode: 0o600 },
    );
    const harness = new DeepSeekHarness({
      profile: 'sdk-minimal',
      patches: [patch],
      dshHome: path.join(temp, 'dsh'),
      cwd: temp,
      processCwd: temp,
      model: 'deepseek-v4-flash',
      initializeTimeoutMs: 30000,
      env: childEnv({ DEEPSEEK_API_KEY: 'initialization-only-no-model-call' }),
    });
    try {
      await harness.start();
      return { initialized: true, modelCalled: false };
    } finally {
      await harness.close();
    }
  });
  await check('deepagents', async () => {
    const [{ createDeepAgent, StateBackend }, { ChatOpenAI }, { PostgresSaver }] =
      await Promise.all([
        import('deepagents'),
        import('@langchain/openai'),
        import('@langchain/langgraph-checkpoint-postgres'),
      ]);
    const saver = PostgresSaver.fromConnString(config.databaseUrl, { schema: 'goalloop_runtime' });
    try {
      await saver.setup();
      const agent = await createDeepAgent({
        model: new ChatOpenAI({ model: 'initialization-only', apiKey: 'no-model-call' }),
        backend: new StateBackend(),
        checkpointer: saver,
        permissions: [{ operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }],
      });
      const graph = await agent.getGraphAsync();
      return { initialized: !!graph, modelCalled: false };
    } finally {
      await saver.end();
    }
  });
} finally {
  if (g) await engine.control(g.id, 'cancel');
  await app.close();
  await db.close();
  await rm(temp, { recursive: true, force: true });
  await mkdir('.data/validation', { recursive: true });
  await writeFile(
    '.data/validation/sdk-smoke.json',
    JSON.stringify({ at: new Date().toISOString(), report }, null, 2),
  );
}
