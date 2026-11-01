import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Store } from '../src/db.js';
import { Engine } from '../src/engine.js';
import { Worker, coverage } from '../src/worker.js';
import { config } from '../src/config.js';
import { hash } from '../src/policy.js';
import { createServer } from '../src/server.js';
import { deliverNotifications } from '../src/notifications.js';
import type { RuntimeAdapter } from '../src/contracts.js';

const url = process.env.TEST_DATABASE_URL || 'postgresql://localhost/goalloop_test';
if (!new URL(url).pathname.endsWith('_test'))
  throw new Error('Tests require a dedicated database ending in _test');
const db = new Store(url),
  engine = new Engine(db);
config.dataDir = '/tmp/goalloop-integration-' + process.pid;
beforeAll(() => db.migrate());
beforeEach(async () => {
  engine.afterEffect = undefined;
  await db.q('TRUNCATE goals CASCADE');
});
afterAll(() => db.close());
async function goal(pack: 'cluster' | 'workspace' | 'manual' = 'cluster', extra: any = {}) {
  const g = await engine.create({
    title: 'Test goal',
    objective: 'Achieve a verified result',
    pack,
    stableMs: 0,
    sampleMs: 100,
    freshMs: 5000,
    ...extra,
  });
  await engine.control(g.id, 'start');
  return g;
}
async function runFor(goalId: string, resource: string) {
  const [task] = await db.q('SELECT * FROM tasks WHERE goal_id=$1 AND resource=$2', [
    goalId,
    resource,
  ]);
  const [job] = await db.q(
    "UPDATE jobs SET status='running',epoch=epoch+1,lease_until=now()+interval '60 seconds' WHERE task_id=$1 AND status='pending' RETURNING *",
    [task.id],
  );
  const id = randomUUID(),
    token = randomUUID();
  const g = await engine.goal(goalId);
  await db.q(
    "INSERT INTO runs(id,goal_id,task_id,job_id,epoch,goal_version,runtime,status,token_hash) VALUES($1,$2,$3,$4,$5,$6,'simulator','running',$7)",
    [id, goalId, task.id, job.id, job.epoch, g.version, hash(token)],
  );
  return { id, token, task, job };
}
async function drain(worker: Worker, cycles = 12) {
  for (let i = 0; i < cycles; i++) {
    await db.q("UPDATE jobs SET due_at=now() WHERE status='pending'");
    await worker.tick();
  }
}

describe('durable control plane', () => {
  it('does not lose a human reply that arrives before the requesting turn exits', async () => {
    const g = await goal('workspace');
    const fake: RuntimeAdapter = {
      probe: async () => ({ id: 'fake', available: true, authenticated: true }),
      async *runTurn(packet) {
        const h = await packet.callTool('request_human', {
          type: 'clarification',
          question: 'Which behavior?',
          reason: 'Need expected outcome',
        });
        await engine.answer(h.id, { decision: 'answer', text: 'Addition' });
        yield {
          type: 'result',
          result: { outcome: 'need_human', summary: 'Asked for clarification' },
        };
      },
    };
    await new Worker(engine, () => fake).tick();
    expect((await db.q('SELECT status FROM tasks WHERE goal_id=$1', [g.id]))[0].status).toBe(
      'ready',
    );
    expect(
      (await db.q("SELECT * FROM human_tasks WHERE goal_id=$1 AND status='pending'", [g.id]))
        .length,
    ).toBe(0);
  });
  it('requires explicit approval for reads when the policy asks for it', async () => {
    const g = await goal('cluster', {
      policy: [{ capability: 'cluster.observe', effect: 'approval_required', resources: ['*'] }],
    });
    const r = await runFor(g.id, 'node-01');
    const proposed = await engine.propose(r.id, 'cluster.observe', { resource: 'node-01' });
    expect(proposed.status).toBe('waiting_human');
    expect(proposed.score).toBeUndefined();
    await engine.answer(proposed.humanId, { decision: 'approve' });
    const approved = await engine.propose(r.id, 'cluster.observe', { resource: 'node-01' });
    expect(approved.result.score).toBe(62);
  });
  it('preserves a timed wakeup through pause/resume without starting the model early', async () => {
    const g = await goal('workspace');
    const [t] = await db.q('SELECT * FROM tasks WHERE goal_id=$1', [g.id]);
    await db.q("UPDATE tasks SET status='waiting_event' WHERE id=$1", [t.id]);
    await db.q("UPDATE jobs SET due_at=now()+interval '1 hour' WHERE task_id=$1", [t.id]);
    await engine.control(g.id, 'pause');
    await engine.control(g.id, 'resume');
    const [j] = await db.q("SELECT * FROM jobs WHERE task_id=$1 AND status='pending'", [t.id]);
    expect(j.due_at.getTime()).toBeGreaterThan(Date.now() + 3500000);
    expect(await new Worker(engine).claim()).toBeNull();
  });
  it('keeps unspecified contract fields on API patch and resets stability on new scoring rules', async () => {
    const g = await goal('workspace', { mode: 'maintain', maxTurns: 7 });
    const app = await createServer(engine, { port: 12400 });
    try {
      const headers = { host: '127.0.0.1:12400' };
      const { csrf } = (await app.inject({ url: '/api/v1/session', headers })).json();
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/goals/${g.id}`,
        headers: { ...headers, 'x-goalloop-token': csrf },
        payload: { version: 1, patch: { title: 'New title' } },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().spec).toMatchObject({
        pack: 'workspace',
        mode: 'maintain',
        maxTurns: 7,
        stableMs: 0,
      });
      await db.q('UPDATE goals SET stable_since=now() WHERE id=$1', [g.id]);
      expect((await engine.revise(g.id, 2, { threshold: 95 })).stable_since).toBeNull();
    } finally {
      await app.close();
    }
  });
  it('finishes local workspace with real independent JavaScript checks', async () => {
    const g = await goal('workspace');
    await drain(new Worker(engine), 5);
    expect((await engine.goal(g.id)).status).toBe('succeeded');
    expect((await db.q('SELECT * FROM actions WHERE goal_id=$1', [g.id]))[0].status).toBe(
      'confirmed',
    );
  });
  it('cannot forge verifier results by replacing guest intrinsics or reporting a candidate', async () => {
    const g = await goal('workspace');
    await writeFile(
      await engine.packs.file(g, 'calculator.js'),
      'function add(){return 999} Array.prototype.map=()=>[{passed:true}]; JSON.stringify=()=>"[{\\"passed\\":true}]";',
    );
    expect((await engine.packs.get('workspace').verify(g)).satisfied).toBe(false);
    const fake: RuntimeAdapter = {
      probe: async () => ({ id: 'fake', available: true, authenticated: true }),
      async *runTurn() {
        yield { type: 'result', result: { outcome: 'candidate', summary: 'I declare success' } };
      },
    };
    await drain(new Worker(engine, () => fake), 4);
    expect((await engine.goal(g.id)).status).toBe('active');
  });
  it('changes the deadline explicitly and only switches executors at a turn boundary', async () => {
    const g = await goal('workspace');
    const run = await runFor(g.id, 'calculator.js');
    await expect(engine.revise(g.id, 1, { runtime: 'codex' })).rejects.toThrow('轮次边界');
    await engine.control(g.id, 'pause');
    const changed = await engine.revise(g.id, 1, { runtime: 'codex', deadlineMs: 2 * 86400000 });
    expect(changed.deadline_at!.getTime() - changed.activated_at!.getTime()).toBe(2 * 86400000);
    await expect(engine.authorizeToken(run.token)).rejects.toThrow('失效');
  });
  it('loads an operator capability pack while undeclared actions remain denied', async () => {
    engine.packs.register({
      id: 'custom_test',
      freezeScope: async () => ['resource-1'],
      capabilities: [],
      initialize: async () => [{ title: 'Inspect custom resource', resource: 'resource-1' }],
      verify: async () => ({
        satisfied: false,
        missing: true,
        summary: 'No independent measurement',
        details: {},
      }),
    });
    const g = await engine.create({
      title: 'Custom',
      objective: 'Custom installed pack',
      pack: 'custom_test',
    });
    expect(g.spec.scope).toEqual(['resource-1']);
    expect(g.spec.policy).toEqual([]);
  });
  it('waits for approval, continues independent tasks, survives a new worker and requires external evidence', async () => {
    const g = await goal();
    await drain(new Worker(engine), 7);
    let tasks = await db.q('SELECT * FROM tasks WHERE goal_id=$1', [g.id]);
    expect(tasks.find((t) => t.resource === 'node-01').status).toBe('done');
    expect(tasks.find((t) => t.resource === 'node-02').status).toBe('waiting_human');
    const [approval] = await db.q(
      "SELECT * FROM human_tasks WHERE goal_id=$1 AND type='approval'",
      [g.id],
    );
    await engine.answer(approval.id, { decision: 'approve', text: 'Single approved restart' });
    await engine.answer(approval.id, { decision: 'approve', text: 'Single approved restart' });
    const [hardware] = await db.q(
      "SELECT * FROM human_tasks WHERE goal_id=$1 AND type='collaboration'",
      [g.id],
    );
    await engine.answer(hardware.id, { decision: 'answer', text: 'Done' });
    await drain(new Worker(new Engine(db)), 5);
    expect((await engine.goal(g.id)).status).toBe('active');
    await engine.inject(g.id, 'node-03', { score: 94, fault: 'none' });
    const [next] = await db.q(
      "SELECT * FROM human_tasks WHERE goal_id=$1 AND type='collaboration' AND status='pending'",
      [g.id],
    );
    if (next)
      await engine.answer(next.id, {
        decision: 'answer',
        text: 'Hardware replaced; verify current telemetry',
      });
    await drain(new Worker(engine), 8);
    expect((await engine.goal(g.id)).status).toBe('succeeded');
    expect((await db.q('SELECT count(*)::int AS n FROM simulator_operations'))[0].n).toBe(2);
  });
  it('claims once across two workers and rejects stale run tokens after lease expiry', async () => {
    const g = await goal('workspace');
    const w1 = new Worker(engine),
      w2 = new Worker(engine);
    const jobs = await Promise.all([w1.claim(), w2.claim()]);
    expect(jobs.filter(Boolean)).toHaveLength(1);
    const job = jobs.find(Boolean);
    await db.q("UPDATE jobs SET status='pending' WHERE id=$1", [job.id]);
    const r = await runFor(g.id, 'calculator.js');
    await db.q("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [r.job.id]);
    await w2.recover();
    await expect(engine.authorizeToken(r.token)).rejects.toThrow('失效');
    expect((await db.q('SELECT * FROM jobs WHERE id=$1', [r.job.id]))[0].epoch).toBeGreaterThan(
      r.job.epoch,
    );
  });
  it('reconciles an applied operation with a lost response without repeating its effect', async () => {
    const g = await goal();
    const r = await runFor(g.id, 'node-01');
    engine.afterEffect = async () => {
      throw new Error('injected response loss');
    };
    await expect(
      engine.propose(r.id, 'cluster.clean_cache', { resource: 'node-01' }),
    ).rejects.toThrow('response loss');
    const [a] = await db.q('SELECT * FROM actions');
    expect(a.status).toBe('outcome_unknown');
    engine.afterEffect = undefined;
    await engine.reconcile(a);
    await engine.reconcile(a);
    expect((await db.q('SELECT * FROM actions'))[0].status).toBe('confirmed');
    expect((await db.q('SELECT count(*)::int AS n FROM simulator_operations'))[0].n).toBe(1);
    expect(
      (
        await db.q("SELECT version FROM simulator_nodes WHERE goal_id=$1 AND id='node-01'", [g.id])
      )[0].version,
    ).toBe(2);
  });
  it('rejects expired approval and stale resource conditions', async () => {
    const g = await goal();
    const r = await runFor(g.id, 'node-02');
    const response = await engine.propose(r.id, 'cluster.restart', { resource: 'node-02' });
    await db.q("UPDATE human_tasks SET expires_at=now()-interval '1 second' WHERE id=$1", [
      response.humanId,
    ]);
    await expect(engine.answer(response.humanId, { decision: 'approve' })).rejects.toThrow('失效');
    await db.q("UPDATE human_tasks SET expires_at=now()+interval '1 hour' WHERE id=$1", [
      response.humanId,
    ]);
    await engine.inject(g.id, 'node-02', { score: 54 });
    await expect(engine.answer(response.humanId, { decision: 'approve' })).rejects.toThrow(
      '资源已变化',
    );
    expect((await db.q('SELECT * FROM simulator_operations')).length).toBe(0);
  });
  it('revokes pending authorization on contract revision, and pause fences active turns', async () => {
    const g = await goal();
    const r = await runFor(g.id, 'node-02');
    const response = await engine.propose(r.id, 'cluster.restart', { resource: 'node-02' });
    await engine.revise(g.id, 1, {
      policy: [{ capability: '*', effect: 'deny', resources: ['*'] }],
    });
    await expect(engine.answer(response.humanId, { decision: 'approve' })).rejects.toThrow('失效');
    await expect(engine.authorizeToken(r.token)).rejects.toThrow('失效');
    await engine.control(g.id, 'pause');
    expect(
      (
        await db.q("SELECT * FROM jobs WHERE goal_id=$1 AND status IN ('pending','running')", [
          g.id,
        ])
      ).length,
    ).toBe(0);
  });
  it('does not accept missing machines, stale telemetry or out-of-scope actions', async () => {
    const g = await goal();
    const r = await runFor(g.id, 'node-01');
    await expect(
      engine.propose(r.id, 'cluster.clean_cache', { resource: 'node-99' }),
    ).rejects.toThrow('越界');
    await db.q('UPDATE simulator_nodes SET score=95 WHERE goal_id=$1', [g.id]);
    await engine.inject(g.id, 'node-03', { stale: true });
    expect((await engine.packs.get('cluster').verify(g)).satisfied).toBe(false);
    await db.q("DELETE FROM simulator_nodes WHERE goal_id=$1 AND id='node-03'", [g.id]);
    expect((await engine.packs.get('cluster').verify(g)).missing).toBe(true);
  });
  it('bounds no-progress runs and asks for help without spinning', async () => {
    const g = await goal('workspace', { maxAttempts: 3 });
    const fake: RuntimeAdapter = {
      probe: async () => ({ id: 'test', available: true, authenticated: true }),
      async *runTurn() {
        yield { type: 'result', result: { outcome: 'no_progress', summary: 'No usable evidence' } };
      },
    };
    await drain(new Worker(engine, () => fake), 9);
    expect((await db.q('SELECT count(*)::int AS n FROM runs WHERE goal_id=$1', [g.id]))[0].n).toBe(
      3,
    );
    expect((await db.q('SELECT * FROM tasks WHERE goal_id=$1', [g.id]))[0].status).toBe(
      'waiting_human',
    );
  });
  it('retains maintain responsibility, handles regression and reports expiration honestly', async () => {
    const g = await goal('workspace', { mode: 'maintain' });
    await drain(new Worker(engine), 5);
    expect((await engine.goal(g.id)).status).toBe('active');
    await db.q("UPDATE goals SET deadline_at=now()-interval '1 millisecond' WHERE id=$1", [g.id]);
    await drain(new Worker(engine), 2);
    const ended = await engine.goal(g.id);
    expect(ended.status).toBe('expired');
    expect(ended.report.endedReason).toBe('deadline');
    expect(ended.report.missingMs).toBeGreaterThan(0);
  });
  it('runs an accelerated seven-day maintain timeline with waiting, regression, repairs and missing telemetry', async () => {
    const day = 86400000,
      g = await goal('cluster', {
        mode: 'maintain',
        deadlineMs: 7 * day,
        sampleMs: day,
        freshMs: day,
      });
    const w = new Worker(engine);
    await drain(w, 6);
    expect(
      (await db.q("SELECT * FROM human_tasks WHERE goal_id=$1 AND status='pending'", [g.id]))
        .length,
    ).toBe(2);
    const advance = async () => {
      await db.q(
        "UPDATE goals SET activated_at=activated_at-interval '1 day',deadline_at=deadline_at-interval '1 day',stable_since=stable_since-interval '1 day' WHERE id=$1",
        [g.id],
      );
      await db.q(
        "UPDATE evidence SET observed_at=observed_at-interval '1 day',expires_at=expires_at-interval '1 day' WHERE goal_id=$1",
        [g.id],
      );
    };
    await advance();
    for (const h of await db.q("SELECT * FROM human_tasks WHERE goal_id=$1 AND status='pending'", [
      g.id,
    ]))
      await engine.answer(h.id, {
        decision: h.type === 'approval' ? 'approve' : 'answer',
        text: 'Repair done',
      });
    await engine.inject(g.id, 'node-03', { score: 94, fault: 'none' });
    await drain(w, 8);
    await advance();
    await engine.inject(g.id, 'node-01', { score: 45, fault: 'disk' });
    await drain(w, 1);
    expect(
      (await db.q("SELECT * FROM tasks WHERE goal_id=$1 AND resource='node-01'", [g.id]))[0].status,
    ).toBe('ready');
    await drain(w, 5);
    expect(
      (await db.q("SELECT score FROM simulator_nodes WHERE goal_id=$1 AND id='node-01'", [g.id]))[0]
        .score,
    ).toBe(92);
    await advance();
    await engine.inject(g.id, 'node-03', { stale: true });
    await drain(w, 3);
    await advance();
    await advance();
    await engine.inject(g.id, 'node-03', { stale: false });
    await drain(w, 3);
    await advance();
    await drain(w, 2);
    await advance();
    await drain(w, 4);
    const ended = await engine.goal(g.id);
    expect(ended.status).toBe('expired');
    expect(ended.report.totalMs).toBe(7 * day);
    expect(ended.report.healthyMs).toBeGreaterThan(day);
    expect(ended.report.unhealthyMs).toBeGreaterThan(0);
    expect(ended.report.missingMs).toBeGreaterThan(day);
    expect(ended.report.intervals.some((x: any) => x.status === 'missing')).toBe(true);
  });
  it('deduplicates notification decisions while retrying delivery failures', async () => {
    const g = await goal();
    const r = await runFor(g.id, 'node-02');
    await engine.propose(r.id, 'cluster.restart', { resource: 'node-02' });
    const old = process.env.FEISHU_WEBHOOK;
    process.env.FEISHU_WEBHOOK = 'http://test.invalid';
    try {
      await deliverNotifications(
        db,
        async () => new Response(JSON.stringify({ code: 1 }), { status: 200 }),
      );
      expect((await db.q('SELECT * FROM outbox'))[0].status).toBe('pending');
      await db.q('UPDATE outbox SET due_at=now()');
      await deliverNotifications(
        db,
        async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }),
      );
      expect((await db.q('SELECT * FROM outbox'))[0].status).toBe('sent');
    } finally {
      if (old) process.env.FEISHU_WEBHOOK = old;
      else delete process.env.FEISHU_WEBHOOK;
    }
  });
  it('checks Host, CSRF, run-token scope, and deduplicates external wake events', async () => {
    const app = await createServer(engine, { port: 12400 });
    try {
      expect(
        (await app.inject({ url: '/api/v1/session', headers: { host: 'evil.test' } })).statusCode,
      ).toBe(403);
      const headers = { host: '127.0.0.1:12400' };
      const session = (await app.inject({ url: '/api/v1/session', headers })).json();
      expect(
        (await app.inject({ method: 'POST', url: '/api/v1/goals', headers, payload: {} }))
          .statusCode,
      ).toBe(403);
      const g = await goal('workspace');
      const r = await runFor(g.id, 'calculator.js');
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/goals/${g.id}/cancel`,
            headers: { ...headers, authorization: `Bearer ${r.token}` },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      const admin = { ...headers, 'x-goalloop-token': session.csrf };
      const payload = { eventId: 'unique-1', name: 'test' };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/goals/${g.id}/events`,
            headers: admin,
            payload,
          })
        ).json(),
      ).toEqual({ accepted: true });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/goals/${g.id}/events`,
            headers: admin,
            payload,
          })
        ).json(),
      ).toEqual({ duplicate: true });
    } finally {
      await app.close();
    }
  });
});

it('calculates a week of coverage without counting missing intervals as healthy', () => {
  const day = 86400000;
  const result = coverage(
    [
      { observed_at: new Date(0), satisfied: true, missing: false },
      { observed_at: new Date(day), satisfied: false, missing: false },
      { observed_at: new Date(2 * day), satisfied: true, missing: false },
      { observed_at: new Date(4 * day), satisfied: false, missing: true },
    ],
    0,
    7 * day,
    day,
  );
  expect(result.healthyMs).toBe(2 * day);
  expect(result.unhealthyMs).toBe(day);
  expect(result.missingMs).toBe(4 * day);
});
