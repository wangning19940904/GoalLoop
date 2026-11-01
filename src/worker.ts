import { z } from 'zod';
import { classifyError } from './runtimes/common.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from './config.js';
import { Engine } from './engine.js';
import { enqueue, event, notify } from './db.js';
import {
  DomainError,
  turnResult,
  type Goal,
  type Task,
  type TurnResult,
  type RuntimeAdapter,
  type TurnPacket,
} from './contracts.js';
import { hash } from './policy.js';
import { callTool, toolDefinitions } from './tools.js';
import { getRuntime } from './runtimes/index.js';
import { deliverNotifications } from './notifications.js';

export function coverage(samples: any[], start: number, end: number, freshMs: number) {
  let healthyMs = 0,
    unhealthyMs = 0,
    cursor = start;
  const intervals: { from: number; to: number; status: string; version?: number }[] = [];
  const add = (from: number, to: number, status: string, version?: number) => {
    if (to <= from) return;
    const last = intervals.at(-1);
    if (last && last.to === from && last.status === status && last.version === version)
      last.to = to;
    else intervals.push({ from, to, status, version });
  };
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const at = new Date(s.observed_at).getTime(),
      from = Math.max(start, at);
    const until = Math.min(
      end,
      s.expires_at ? new Date(s.expires_at).getTime() : at + freshMs,
      i + 1 < samples.length ? new Date(samples[i + 1].observed_at).getTime() : end,
    );
    if (until <= from) continue;
    if (from > cursor) add(cursor, from, 'missing');
    const span = until - from;
    if (!s.missing) {
      if (s.satisfied) healthyMs += span;
      else unhealthyMs += span;
    }
    add(from, until, s.missing ? 'missing' : s.satisfied ? 'healthy' : 'unhealthy', s.goal_version);
    cursor = until;
  }
  if (cursor < end) add(cursor, end, 'missing');
  const totalMs = Math.max(0, end - start);
  return {
    totalMs,
    healthyMs,
    unhealthyMs,
    missingMs: Math.max(0, totalMs - healthyMs - unhealthyMs),
    healthyRatio: totalMs ? healthyMs / totalMs : 0,
    intervals,
  };
}
export class Worker {
  owner = randomUUID();
  stopping = false;
  activeControllers = new Set<AbortController>();
  constructor(
    public engine: Engine,
    public runtimeFactory: (id: string) => RuntimeAdapter = getRuntime,
  ) {}
  async claim() {
    return this.engine.db.tx(async (db) => {
      const [job] = await db.q(
        `SELECT j.* FROM jobs j JOIN goals g ON g.id=j.goal_id WHERE j.status='pending' AND j.due_at<=now() AND g.status='active' AND (j.task_id IS NULL OR EXISTS (SELECT 1 FROM tasks t WHERE t.id=j.task_id AND t.status IN ('ready','waiting_event') AND NOT EXISTS(SELECT 1 FROM tasks d WHERE d.id=ANY(t.dependencies) AND d.status<>'done'))) ORDER BY j.due_at,j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
      );
      if (!job) return null;
      const [claimed] = await db.q(
        "UPDATE jobs SET status='running',owner=$2,epoch=epoch+1,lease_until=now()+($3::text||' milliseconds')::interval,attempts=attempts+1 WHERE id=$1 RETURNING *",
        [job.id, this.owner, config.leaseMs],
      );
      return claimed;
    });
  }
  async recover() {
    await this.engine.db.tx(async (db) => {
      const expired = await db.q(
        "SELECT * FROM jobs WHERE status='running' AND lease_until<now() FOR UPDATE SKIP LOCKED",
      );
      for (const j of expired) {
        await db.q(
          "UPDATE jobs SET status='pending',owner=NULL,epoch=epoch+1,lease_until=NULL,due_at=now() WHERE id=$1",
          [j.id],
        );
        await db.q(
          "UPDATE runs SET status='interrupted',ended_at=now(),error='Worker lease expired' WHERE job_id=$1 AND status='running'",
          [j.id],
        );
        if (j.task_id)
          await db.q("UPDATE tasks SET status='ready' WHERE id=$1 AND status='running'", [
            j.task_id,
          ]);
        await event(db, j.goal_id, 'run.recovered', { jobId: j.id });
      }
      const goals = await db.q<Goal>("SELECT * FROM goals WHERE status='active'");
      for (const g of goals) {
        for (const t of await db.q<Task>(
          "SELECT * FROM tasks WHERE goal_id=$1 AND status IN ('ready','waiting_event')",
          [g.id],
        )) {
          const [previous] = await db.q(
            "SELECT due_at FROM jobs WHERE task_id=$1 AND kind='turn' ORDER BY created_at DESC LIMIT 1",
            [t.id],
          );
          await enqueue(
            db,
            g.id,
            'turn',
            t.id,
            t.status === 'waiting_event' && previous ? previous.due_at : new Date(),
          );
        }
        await enqueue(db, g.id, 'verify', null, new Date(Date.now() + g.spec.sampleMs));
      }
    });
    for (const a of await this.engine.db.q(
      "SELECT a.* FROM actions a WHERE a.status IN ('dispatched','outcome_unknown') AND NOT EXISTS(SELECT 1 FROM runs r JOIN jobs j ON j.id=r.job_id WHERE r.task_id=a.task_id AND r.status='running' AND j.status='running' AND j.lease_until>now())",
    )) {
      try {
        await this.engine.reconcile(a);
      } catch (e) {
        await event(this.engine.db, a.goal_id, 'reconcile.error', { id: a.id, message: String(e) });
      }
    }
  }
  async tick() {
    await this.recover();
    await deliverNotifications(this.engine.db);
    const job = await this.claim();
    if (!job) return false;
    if (job.kind === 'turn') await this.run(job);
    else if (job.kind === 'verify') await this.verify(job);
    else {
      for (const a of await this.engine.db.q(
        "SELECT * FROM actions WHERE goal_id=$1 AND status IN ('dispatched','outcome_unknown')",
        [job.goal_id],
      ))
        await this.engine.reconcile(a);
      await this.engine.db.q(
        "UPDATE jobs SET status='done',lease_until=NULL WHERE id=$1 AND epoch=$2",
        [job.id, job.epoch],
      );
    }
    return true;
  }
  async loop(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const did = await this.tick();
        if (!did) await delay(config.pollMs, undefined, { signal });
      } catch (e) {
        if (!signal.aborted) {
          console.error('[worker]', e);
          await delay(config.pollMs, undefined, { signal }).catch(() => {});
        }
      }
    }
    for (const c of this.activeControllers) c.abort();
  }
  async run(job: any) {
    const db = this.engine.db;
    const g = await this.engine.goal(job.goal_id);
    const [task] = await db.q<Task>('SELECT * FROM tasks WHERE id=$1', [job.task_id]);
    const runId = randomUUID(),
      token = randomBytes(32).toString('hex');
    const allowed = await db.tx(async (tx) => {
      await tx.q('SELECT id FROM goals WHERE id=$1 FOR UPDATE', [g.id]);
      const current = await this.engine.goal(g.id, tx);
      const [lease] = await tx.q(
        "SELECT id FROM jobs WHERE id=$1 AND epoch=$2 AND status='running' AND lease_until>now()",
        [job.id, job.epoch],
      );
      if (!lease || current.status !== 'active') return false;
      if (current.deadline_at && current.deadline_at.getTime() <= Date.now()) {
        await tx.q("UPDATE jobs SET status='done' WHERE id=$1", [job.id]);
        await tx.q(
          "UPDATE jobs SET due_at=now() WHERE goal_id=$1 AND kind='verify' AND status='pending'",
          [g.id],
        );
        await enqueue(tx, g.id, 'verify');
        return false;
      }
      const [counts] = await tx.q(
        'SELECT count(*)::int AS count,coalesce(sum(input_tokens+output_tokens),0)::bigint AS tokens FROM runs WHERE goal_id=$1',
        [g.id],
      );
      if (
        counts.count >= g.spec.maxTurns ||
        (g.spec.tokenBudget && Number(counts.tokens) >= g.spec.tokenBudget)
      ) {
        await tx.q("UPDATE goals SET status='blocked' WHERE id=$1", [g.id]);
        await tx.q("UPDATE jobs SET status='done' WHERE id=$1", [job.id]);
        await this.engine.human(tx, g, null, 'clarification', '运行预算已到上限', {
          reason: '请调整预算或结束目标',
        });
        return false;
      }
      await tx.q(
        "INSERT INTO runs(id,goal_id,task_id,job_id,epoch,goal_version,runtime,status,token_hash) VALUES($1,$2,$3,$4,$5,$6,$7,'running',$8)",
        [runId, g.id, task.id, job.id, job.epoch, g.version, g.spec.runtime, hash(token)],
      );
      await tx.q("UPDATE tasks SET status='running' WHERE id=$1", [task.id]);
      await event(tx, g.id, 'run.started', { runId, taskId: task.id, runtime: g.spec.runtime });
      return true;
    });
    if (!allowed) return;
    const controller = new AbortController();
    this.activeControllers.add(controller);
    const timeout = setTimeout(
      () => controller.abort(new Error('Turn timeout')),
      Math.min(
        g.spec.turnTimeoutMs,
        g.deadline_at ? Math.max(1, g.deadline_at.getTime() - Date.now()) : Infinity,
      ),
    );
    const heartbeat = setInterval(
      () => {
        void db
          .q(
            "UPDATE jobs j SET lease_until=now()+($3::text||' milliseconds')::interval FROM goals g WHERE j.id=$1 AND j.epoch=$2 AND j.status='running' AND j.lease_until>now() AND g.id=j.goal_id AND g.status='active' RETURNING j.id",
            [job.id, job.epoch, config.leaseMs],
          )
          .then((rows) => {
            if (!rows.length) controller.abort(new Error('Lease revoked'));
          })
          .catch(() => controller.abort(new Error('Lease heartbeat failed')));
      },
      Math.max(50, config.leaseMs / 3),
    );
    let result: TurnResult = { outcome: 'failed', summary: '执行器没有提交有效结果' };
    let error: string | undefined;
    let usage: { input: number; output: number } | undefined;
    try {
      const [last] = await db.q(
        'SELECT session_id FROM runs WHERE task_id=$1 AND runtime=$2 AND session_id IS NOT NULL ORDER BY started_at DESC LIMIT 1',
        [task.id, g.spec.runtime],
      );
      const home = path.join(config.dataDir, 'runtime', g.id, g.spec.runtime);
      await mkdir(home, { recursive: true, mode: 0o700 });
      const packet: TurnPacket = {
        runId,
        goal: g,
        task,
        tasks: await db.q<Task>('SELECT * FROM tasks WHERE goal_id=$1', [g.id]),
        evidence: await db.q(
          'SELECT * FROM evidence WHERE goal_id=$1 AND goal_version=$2 AND expires_at>now() ORDER BY observed_at DESC LIMIT 10',
          [g.id, g.version],
        ),
        decisions: await db.q(
          "SELECT type,title,answer FROM human_tasks WHERE goal_id=$1 AND goal_version=$2 AND status='answered'",
          [g.id, g.version],
        ),
        capabilities: this.engine.packs.get(g.spec.pack).capabilities.map((c) => ({
          name: c.name,
          write: c.write,
          schema: z.toJSONSchema(c.schema),
        })),
        context: await this.engine.packs.get(g.spec.pack).context?.(g),
        sessionId: last?.session_id,
        tools: toolDefinitions,
        callTool: (name, args) => callTool(this.engine, runId, name, args),
        apiUrl: config.baseUrl,
        token,
        runtimeHome: home,
      };
      for await (const e of this.runtimeFactory(g.spec.runtime).runTurn(
        packet,
        controller.signal,
      )) {
        await this.engine.assertRun(db, runId);
        if (e.type === 'result') result = turnResult.parse(e.result);
        else if (e.type === 'session')
          await db.q('UPDATE runs SET session_id=$2 WHERE id=$1', [runId, e.sessionId]);
        else if (e.type === 'usage') usage = e;
        else await event(db, g.id, 'run.output', { runId, text: e.text.slice(0, 8000) });
      }
      if (controller.signal.aborted) throw controller.signal.reason || new Error('Interrupted');
      const [persisted] = await db.q('SELECT summary FROM runs WHERE id=$1', [runId]);
      if (persisted?.summary) result = turnResult.parse(JSON.parse(persisted.summary));
    } catch (e) {
      error = String(e);
      result = { outcome: 'failed', summary: error };
      if (
        /session|thread|checkpoint/i.test(error) &&
        /not found|missing|does not exist|invalid/i.test(error)
      ) {
        await db.q('UPDATE runs SET session_id=NULL WHERE task_id=$1 AND runtime=$2', [
          task.id,
          g.spec.runtime,
        ]);
        await event(db, g.id, 'runtime.session_reset', {
          taskId: task.id,
          runtime: g.spec.runtime,
        });
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      this.activeControllers.delete(controller);
    }
    let verified = false;
    if (result.outcome === 'candidate')
      try {
        verified = (await this.engine.packs.get(g.spec.pack).verify(g, task.resource)).satisfied;
      } catch (e) {
        error = String(e);
      }
    await db.tx(async (tx) => {
      await tx.q('SELECT id FROM goals WHERE id=$1 FOR UPDATE', [g.id]);
      try {
        await this.engine.assertRun(tx, runId);
      } catch {
        return;
      }
      const [currentTask] = await tx.q<Task>('SELECT * FROM tasks WHERE id=$1 FOR UPDATE', [
        task.id,
      ]);
      let status = 'ready';
      let attempts = currentTask.attempts;
      const answeredDuringTurn = await tx.q(
        "SELECT h.id FROM human_tasks h JOIN runs r ON r.id=$2 WHERE h.task_id=$1 AND h.status='answered' AND h.created_at>=r.started_at AND h.answered_at>=r.started_at",
        [task.id, runId],
      );
      if (currentTask.status === 'waiting_human') status = 'waiting_human';
      else if (result.outcome === 'need_human' && answeredDuringTurn.length) {
        status = 'ready';
        attempts = 0;
      } else if (result.outcome === 'need_human') {
        await this.engine.human(
          tx,
          g,
          task.id,
          result.humanType || 'clarification',
          result.question || result.summary,
          { reason: result.summary },
        );
        status = 'waiting_human';
      } else if (result.outcome === 'candidate' && verified) {
        status = 'done';
        attempts = 0;
      } else if (result.outcome === 'wait_event') status = 'waiting_event';
      else if (['failed', 'no_progress', 'candidate'].includes(result.outcome)) {
        attempts++;
        if (attempts >= g.spec.maxAttempts) {
          status = 'waiting_human';
          await this.engine.human(tx, g, task.id, 'capability', '连续尝试未能推进，需要帮助', {
            reason: result.summary,
            attempts,
          });
        }
      } else if (result.outcome === 'progress') {
        // Progress must be measurable: a confirmed action or a new evidence item.
        const [p] = await tx.q(
          "SELECT count(*)::int AS n FROM actions WHERE task_id=$1 AND status='confirmed' AND updated_at>=(SELECT started_at FROM runs WHERE id=$2)",
          [task.id, runId],
        );
        if (!p.n) {
          attempts++;
          if (attempts >= g.spec.maxAttempts) {
            status = 'waiting_human';
            await this.engine.human(tx, g, task.id, 'clarification', '多轮没有新增可验证进展', {
              reason: result.summary,
            });
          }
        } else attempts = 0;
      }
      await tx.q('UPDATE tasks SET status=$2,attempts=$3,progress=$4 WHERE id=$1', [
        task.id,
        status,
        attempts,
        result.summary,
      ]);
      await tx.q(
        'UPDATE runs SET status=$2,summary=$3,error=$4,input_tokens=$5,output_tokens=$6,ended_at=now(),error_code=$7 WHERE id=$1',
        [
          runId,
          error ? 'failed' : 'completed',
          JSON.stringify(result),
          error,
          usage?.input ?? null,
          usage?.output ?? null,
          error ? classifyError(error) : null,
        ],
      );
      await tx.q("UPDATE jobs SET status='done',lease_until=NULL WHERE id=$1 AND epoch=$2", [
        job.id,
        job.epoch,
      ]);
      if (status === 'ready' || status === 'waiting_event')
        await enqueue(
          tx,
          g.id,
          'turn',
          task.id,
          new Date(Date.now() + (result.wakeAfterMs ?? Math.min(60000, 1000 * 2 ** attempts))),
        );
      await enqueue(tx, g.id, 'verify');
      await event(tx, g.id, 'run.finished', { runId, result, status });
    });
  }
  async verify(job: any) {
    const db = this.engine.db;
    const g = await this.engine.goal(job.goal_id);
    let verification;
    try {
      verification = await this.engine.packs.get(g.spec.pack).verify(g);
    } catch (e) {
      verification = { satisfied: false, missing: true, summary: String(e), details: {} };
    }
    await db.tx(async (tx) => {
      await tx.q('SELECT id FROM goals WHERE id=$1 FOR UPDATE', [g.id]);
      const current = await this.engine.goal(g.id, tx);
      const [lease] = await tx.q(
        "SELECT id FROM jobs WHERE id=$1 AND epoch=$2 AND status='running' AND lease_until>now()",
        [job.id, job.epoch],
      );
      if (!lease || current.status !== 'active' || current.version !== g.version) return;
      const now = new Date();
      const [last] = await tx.q(
        "SELECT * FROM evidence WHERE goal_id=$1 AND goal_version=$2 AND source='verifier' ORDER BY observed_at DESC LIMIT 1",
        [g.id, g.version],
      );
      const continuous =
        last &&
        last.satisfied &&
        !last.missing &&
        now.getTime() - last.observed_at.getTime() <= g.spec.freshMs;
      const stable = verification.satisfied
        ? continuous && current.stable_since
          ? current.stable_since
          : now
        : null;
      await tx.q(
        "INSERT INTO evidence(id,goal_id,goal_version,source,body,satisfied,missing,observed_at,expires_at) VALUES($1,$2,$3,'verifier',$4,$5,$6,$7,$8)",
        [
          randomUUID(),
          g.id,
          g.version,
          JSON.stringify(verification),
          verification.satisfied,
          verification.missing,
          now,
          new Date(now.getTime() + g.spec.freshMs),
        ],
      );
      const expired = current.deadline_at && current.deadline_at.getTime() <= now.getTime();
      const pendingActions = await tx.q(
        "SELECT id FROM actions WHERE goal_id=$1 AND status IN ('dispatched','outcome_unknown')",
        [g.id],
      );
      const complete =
        g.spec.mode === 'achieve' &&
        stable &&
        now.getTime() - stable.getTime() >= g.spec.stableMs &&
        !pendingActions.length;
      const status = expired ? 'expired' : complete ? 'succeeded' : 'active';
      const samples = await tx.q(
        "SELECT observed_at,expires_at,goal_version,satisfied,missing FROM evidence WHERE goal_id=$1 AND source='verifier' ORDER BY observed_at",
        [g.id],
      );
      const start = current.activated_at?.getTime() ?? g.created_at.getTime();
      const report = {
        ...coverage(
          samples,
          start,
          Math.min(now.getTime(), current.deadline_at?.getTime() ?? now.getTime()),
          g.spec.freshMs,
        ),
        latest: verification,
        endedReason: expired ? 'deadline' : complete ? 'verified' : null,
      };
      await tx.q(
        'UPDATE goals SET status=$2,stable_since=$3,report=$4,updated_at=now() WHERE id=$1',
        [g.id, status, stable, JSON.stringify(report)],
      );
      await tx.q("UPDATE jobs SET status='done',lease_until=NULL WHERE id=$1 AND epoch=$2", [
        job.id,
        job.epoch,
      ]);
      if (status !== 'active') {
        await tx.q(
          "UPDATE jobs SET status='cancelled',epoch=epoch+1 WHERE goal_id=$1 AND status IN ('pending','running')",
          [g.id],
        );
        await tx.q(
          "UPDATE runs SET status='interrupted',ended_at=now() WHERE goal_id=$1 AND status='running'",
          [g.id],
        );
        await event(tx, g.id, `goal.${status}`, report);
        await notify(tx, g.id, `${status}:${g.id}:${g.version}`, {
          title: g.title,
          summary: status === 'succeeded' ? '独立验收通过' : '目标期限结束，请查看覆盖率报告',
        });
        return;
      }
      if (!verification.satisfied) {
        const done = await tx.q<Task>("SELECT * FROM tasks WHERE goal_id=$1 AND status='done'", [
          g.id,
        ]);
        for (const t of done) {
          const ok = await this.engine.packs.get(g.spec.pack).verify(g, t.resource);
          if (!ok.satisfied) {
            await tx.q("UPDATE tasks SET status='ready',attempts=0 WHERE id=$1", [t.id]);
            await enqueue(tx, g.id, 'turn', t.id);
            await event(tx, g.id, 'task.regressed', { taskId: t.id });
          }
        }
      }
      await enqueue(
        tx,
        g.id,
        'verify',
        null,
        new Date(
          Math.min(now.getTime() + g.spec.sampleMs, current.deadline_at?.getTime() ?? Infinity),
        ),
      );
      if (
        !last ||
        last.satisfied !== verification.satisfied ||
        last.missing !== verification.missing
      )
        await event(tx, g.id, 'verification.updated', verification);
    });
  }
}
