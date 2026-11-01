import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DomainError,
  goalInput,
  terminal,
  type Goal,
  type GoalInput,
  type Task,
} from './contracts.js';
import { Store, event, enqueue, notify, type Sql } from './db.js';
import { canonical, decision, hash } from './policy.js';
import { Packs } from './packs.js';
export class Engine {
  packs: Packs;
  constructor(public db: Store) {
    this.packs = new Packs(db);
    this.packs.loadInstalled();
  }
  async goal(id: string, db: Sql = this.db) {
    const [g] = await db.q<Goal>('SELECT * FROM goals WHERE id=$1', [id]);
    if (!g) throw new DomainError('目标不存在', 404);
    return g;
  }
  async create(input: GoalInput) {
    const parsed = goalInput.parse(input);
    const id = randomUUID();
    const scope = await this.packs.scope(parsed);
    const spec = {
      ...parsed,
      policy: parsed.policy ?? this.packs.defaultPolicy(parsed.pack),
      scope,
    };
    return this.db.tx(async (db) => {
      const [goal] = await db.q<Goal>(
        'INSERT INTO goals(id,title,spec) VALUES($1,$2,$3) RETURNING *',
        [id, parsed.title, JSON.stringify(spec)],
      );
      await db.q('INSERT INTO goal_versions(goal_id,version,spec) VALUES($1,1,$2)', [
        id,
        JSON.stringify(spec),
      ]);
      for (const task of await this.packs.get(spec.pack).initialize(db, goal))
        await db.q('INSERT INTO tasks(id,goal_id,title,resource) VALUES($1,$2,$3,$4)', [
          randomUUID(),
          id,
          task.title,
          task.resource,
        ]);
      await event(db, id, 'goal.created', { title: parsed.title });
      return goal;
    });
  }
  async detail(id: string) {
    const goal = await this.goal(id);
    const keys = ['tasks', 'runs', 'human_tasks', 'actions', 'evidence', 'jobs', 'outbox'] as const;
    const rows = await Promise.all(
      keys.map((table) =>
        this.db.q(
          `SELECT * FROM ${table} WHERE goal_id=$1 ${table === 'evidence' ? 'ORDER BY observed_at DESC LIMIT 100' : table === 'runs' ? 'ORDER BY started_at DESC LIMIT 100' : ''}`,
          [id],
        ),
      ),
    );
    const data = Object.fromEntries(keys.map((k, i) => [k, rows[i]]));
    data.runs = data.runs.map(({ token_hash, ...r }) => r);
    const nodes =
      goal.spec.pack === 'cluster'
        ? await this.db.q('SELECT * FROM simulator_nodes WHERE goal_id=$1 ORDER BY id', [id])
        : [];
    return {
      goal,
      ...data,
      nodes,
      events: await this.db.q('SELECT * FROM events WHERE goal_id=$1 ORDER BY id DESC LIMIT 100', [
        id,
      ]),
    };
  }
  async control(id: string, command: 'start' | 'pause' | 'resume' | 'cancel') {
    return this.db.tx(async (db) => {
      await db.q('SELECT id FROM goals WHERE id=$1 FOR UPDATE', [id]);
      const goal = await this.goal(id, db);
      if (terminal.has(goal.status)) throw new DomainError('目标已终止');
      if (command === 'start' && goal.status !== 'draft') throw new DomainError('只有草稿可以启动');
      if (command === 'resume' && !['paused', 'blocked'].includes(goal.status))
        throw new DomainError('只有暂停或阻塞的目标可以恢复');
      const status = command === 'pause' ? 'paused' : command === 'cancel' ? 'cancelled' : 'active';
      await db.q(
        "UPDATE goals SET status=$2,updated_at=now(),activated_at=CASE WHEN $2='active' THEN coalesce(activated_at,now()) ELSE activated_at END,deadline_at=CASE WHEN $2='active' THEN coalesce(deadline_at,now()+($3::text||' milliseconds')::interval) ELSE deadline_at END WHERE id=$1",
        [id, status, goal.spec.deadlineMs],
      );
      if (status === 'active') {
        if (goal.deadline_at && goal.deadline_at.getTime() <= Date.now())
          throw new DomainError('目标期限已结束');
        if (command === 'resume')
          await db.q(
            "UPDATE tasks SET status='ready',attempts=0 WHERE goal_id=$1 AND status IN ('blocked','running')",
            [id],
          );
        const tasks = await db.q<Task>(
          "SELECT * FROM tasks WHERE goal_id=$1 AND status IN ('ready','waiting_event')",
          [id],
        );
        for (const t of tasks) {
          const [previous] = await db.q(
            "SELECT due_at FROM jobs WHERE task_id=$1 AND kind='turn' ORDER BY created_at DESC LIMIT 1",
            [t.id],
          );
          await enqueue(
            db,
            id,
            'turn',
            t.id,
            t.status === 'waiting_event' && previous ? previous.due_at : new Date(),
          );
        }
        await enqueue(db, id, 'verify', null, new Date(Date.now() + goal.spec.sampleMs));
      } else {
        await db.q(
          "UPDATE jobs SET status='cancelled',epoch=epoch+1,lease_until=NULL WHERE goal_id=$1 AND status IN ('pending','running')",
          [id],
        );
        await db.q(
          "UPDATE runs SET status='interrupted',ended_at=now() WHERE goal_id=$1 AND status='running'",
          [id],
        );
        await db.q("UPDATE tasks SET status='ready' WHERE goal_id=$1 AND status='running'", [id]);
        if (status === 'cancelled')
          await db.q(
            "UPDATE human_tasks SET status='invalidated' WHERE goal_id=$1 AND status='pending'",
            [id],
          );
      }
      await event(db, id, `goal.${command}`, {});
      return this.goal(id, db);
    });
  }
  async revise(id: string, version: number, patch: Partial<GoalInput>) {
    return this.db.tx(async (db) => {
      await db.q('SELECT id FROM goals WHERE id=$1 FOR UPDATE', [id]);
      const g = await this.goal(id, db);
      if (g.version !== version) throw new DomainError('目标版本已变化');
      if (terminal.has(g.status)) throw new DomainError('目标已终止');
      const spec = { ...goalInput.parse({ ...g.spec, ...patch }), scope: g.spec.scope };
      if (spec.pack !== g.spec.pack || spec.workspace !== g.spec.workspace)
        throw new DomainError('请为不同能力包或源工作区创建新目标');
      if (
        (spec.runtime !== g.spec.runtime || spec.model !== g.spec.model) &&
        (await db.q("SELECT id FROM runs WHERE goal_id=$1 AND status='running'", [id])).length
      )
        throw new DomainError('执行器只能在轮次边界切换；请等待本轮结束或先暂停目标');
      await db.q(
        "UPDATE goals SET title=$2,spec=$3,version=version+1,stable_since=NULL,updated_at=now(),deadline_at=CASE WHEN activated_at IS NULL THEN NULL ELSE activated_at+($4::text||' milliseconds')::interval END WHERE id=$1",
        [id, spec.title, JSON.stringify(spec), spec.deadlineMs],
      );
      await db.q('INSERT INTO goal_versions(goal_id,version,spec) VALUES($1,$2,$3)', [
        id,
        g.version + 1,
        JSON.stringify(spec),
      ]);
      await db.q(
        "UPDATE human_tasks SET status='invalidated' WHERE goal_id=$1 AND status='pending'",
        [id],
      );
      await db.q(
        "UPDATE actions SET status='invalidated' WHERE goal_id=$1 AND status IN ('prepared','authorized')",
        [id],
      );
      await db.q(
        "UPDATE jobs SET status='cancelled',epoch=epoch+1 WHERE goal_id=$1 AND status IN ('pending','running')",
        [id],
      );
      await db.q(
        "UPDATE runs SET status='interrupted',ended_at=now() WHERE goal_id=$1 AND status='running'",
        [id],
      );
      await db.q("UPDATE tasks SET status='ready',attempts=0 WHERE goal_id=$1 AND status<>'done'", [
        id,
      ]);
      if (g.status === 'active') {
        for (const t of await db.q<Task>(
          "SELECT * FROM tasks WHERE goal_id=$1 AND status='ready'",
          [id],
        ))
          await enqueue(db, id, 'turn', t.id);
        await enqueue(db, id, 'verify');
      }
      await event(db, id, 'goal.revised', { version: g.version + 1 });
      return this.goal(id, db);
    });
  }
  async human(
    db: Sql,
    g: Goal,
    taskId: string | null,
    type: string,
    title: string,
    details: any = {},
    dedupe?: string,
  ) {
    const key = dedupe ?? hash(canonical({ goal: g.id, version: g.version, taskId, type, title }));
    const [old] = await db.q("SELECT * FROM human_tasks WHERE dedupe=$1 AND status='pending'", [
      key,
    ]);
    if (old) return old;
    const [task] = taskId
      ? await db.q('SELECT resource,progress,attempts FROM tasks WHERE id=$1', [taskId])
      : [];
    const evidence = await db.q(
      'SELECT id,body,observed_at,expires_at FROM evidence WHERE goal_id=$1 AND goal_version=$2 ORDER BY observed_at DESC LIMIT 3',
      [g.id, g.version],
    );
    details = {
      ...details,
      impact: task?.resource || g.spec.scope,
      attempted: task?.progress || '暂无历史方案',
      evidence,
      options:
        type === 'approval'
          ? ['批准当前方案', '拒绝当前方案']
          : ['提供结果与证据', '说明阻碍或请求调整目标'],
    };
    const [h] = await db.q(
      `INSERT INTO human_tasks(id,goal_id,task_id,goal_version,type,dedupe,title,details,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(dedupe) WHERE status='pending' DO UPDATE SET dedupe=EXCLUDED.dedupe RETURNING *`,
      [
        randomUUID(),
        g.id,
        taskId,
        g.version,
        type,
        key,
        title,
        JSON.stringify(details),
        new Date(Date.now() + (type === 'approval' ? 86400000 : 7 * 86400000)),
      ],
    );
    if (taskId) await db.q("UPDATE tasks SET status='waiting_human' WHERE id=$1", [taskId]);
    await event(db, g.id, 'human.requested', { id: h.id, type, title });
    await notify(db, g.id, `human:${h.id}`, {
      title,
      summary: details.reason || '需要你的判断或协助',
      humanId: h.id,
    });
    return h;
  }
  async answer(id: string, input: unknown) {
    const answer = z
      .object({
        decision: z.enum(['approve', 'reject', 'answer']),
        text: z.string().max(16000).default(''),
      })
      .parse(input);
    const [lookup] = await this.db.q('SELECT goal_id FROM human_tasks WHERE id=$1', [id]);
    if (!lookup) throw new DomainError('人工事项不存在', 404);
    return this.db.tx(async (db) => {
      await db.q('SELECT id FROM goals WHERE id=$1 FOR UPDATE', [lookup.goal_id]);
      const [h] = await db.q('SELECT * FROM human_tasks WHERE id=$1 FOR UPDATE', [id]);
      const g = await this.goal(h.goal_id, db);
      if (h.status === 'answered') {
        if (canonical(h.answer) !== canonical(answer)) throw new DomainError('此事项已经被回答');
        return h;
      }
      if (
        h.status !== 'pending' ||
        h.expires_at.getTime() <= Date.now() ||
        h.goal_version !== g.version ||
        terminal.has(g.status)
      )
        throw new DomainError('事项或授权已失效');
      if (h.type === 'approval' && answer.decision === 'answer')
        throw new DomainError('审批请选择批准或拒绝', 400);
      if (h.type === 'approval') {
        const [a] = await db.q('SELECT * FROM actions WHERE approval_id=$1 FOR UPDATE', [id]);
        if (!a || a.status !== 'prepared') throw new DomainError('动作已失效');
        const cap = this.packs.capability(g, a.capability);
        const current = await cap.precondition(g, a.args);
        if (canonical(current) !== canonical(a.precondition))
          throw new DomainError('资源已变化，旧方案不能批准，请修改目标规则触发重新调查');
        await db.q('UPDATE actions SET status=$2,updated_at=now() WHERE id=$1', [
          a.id,
          answer.decision === 'approve' ? 'authorized' : 'rejected',
        ]);
      }
      const [result] = await db.q(
        "UPDATE human_tasks SET status='answered',answer=$2,answered_at=now() WHERE id=$1 RETURNING *",
        [id, JSON.stringify(answer)],
      );
      if (h.task_id) {
        await db.q("UPDATE tasks SET status='ready',attempts=0 WHERE id=$1", [h.task_id]);
        if (g.status === 'active') await enqueue(db, g.id, 'turn', h.task_id);
      }
      if (g.status === 'active') await enqueue(db, g.id, 'verify');
      await event(db, g.id, 'human.answered', { id, answer });
      return result;
    });
  }
  async assertRun(db: Sql, runId: string) {
    const [r] = await db.q(
      `SELECT r.*,g.spec,g.status AS goal_status,g.version,g.deadline_at,j.status AS job_status,j.epoch AS job_epoch,j.lease_until FROM runs r JOIN goals g ON g.id=r.goal_id JOIN jobs j ON j.id=r.job_id WHERE r.id=$1`,
      [runId],
    );
    if (
      !r ||
      r.status !== 'running' ||
      r.goal_status !== 'active' ||
      r.version !== r.goal_version ||
      r.job_status !== 'running' ||
      r.epoch !== r.job_epoch ||
      r.lease_until.getTime() <= Date.now() ||
      (r.deadline_at && r.deadline_at.getTime() <= Date.now())
    )
      throw new DomainError('运行租约或授权已失效', 403);
    return r;
  }
  async authorizeToken(token: string) {
    const [r] = await this.db.q('SELECT id FROM runs WHERE token_hash=$1', [hash(token)]);
    if (!r) throw new DomainError('无效运行令牌', 401);
    await this.assertRun(this.db, r.id);
    return r.id;
  }
  async propose(runId: string, name: string, input: unknown) {
    const r = await this.assertRun(this.db, runId),
      g = await this.goal(r.goal_id);
    const cap = this.packs.capability(g, name);
    const args: any = cap.schema.parse(input);
    const resource = String(args.resource);
    if (!g.spec.scope.includes(resource)) throw new DomainError('资源越界', 403);
    const effect = decision(g.spec.policy, name, resource);
    if (effect === 'deny') throw new DomainError('规则禁止或未授权此能力', 403);
    if (!cap.write && effect === 'allow') {
      await this.assertRun(this.db, runId);
      const result = await cap.execute(g, args, null);
      await event(this.db, g.id, 'tool.read', { capability: name, resource });
      return result;
    }
    // A stable pending proposal survives re-runs; completed proposals are reused only for the same state.
    const pending = await this.db.q(
      "SELECT * FROM actions WHERE goal_id=$1 AND task_id=$2 AND goal_version=$3 AND capability=$4 AND args=$5::jsonb AND status IN ('prepared','authorized','dispatched','outcome_unknown','rejected') ORDER BY created_at DESC LIMIT 1",
      [g.id, r.task_id, g.version, name, JSON.stringify(args)],
    );
    const precondition = pending[0]?.precondition ?? (await cap.precondition(g, args));
    const fingerprint = hash(
      canonical({ goal: g.id, task: r.task_id, version: g.version, name, args, precondition }),
    );
    const action = await this.db.tx(async (db) => {
      await db.q('SELECT id FROM goals WHERE id=$1 FOR UPDATE', [g.id]);
      await this.assertRun(db, runId);
      const [a] = await db.q(
        `INSERT INTO actions(id,goal_id,task_id,goal_version,capability,resource,args,proposal_hash,precondition,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(proposal_hash) DO UPDATE SET proposal_hash=EXCLUDED.proposal_hash RETURNING *`,
        [
          randomUUID(),
          g.id,
          r.task_id,
          g.version,
          name,
          cap.lockKey?.(g, args) ?? `${g.id}:${resource}`,
          JSON.stringify(args),
          fingerprint,
          JSON.stringify(precondition),
          effect === 'allow' ? 'authorized' : 'prepared',
        ],
      );
      if (a.status === 'prepared') {
        const h = await this.human(
          db,
          g,
          r.task_id,
          'approval',
          `批准 ${name} · ${resource}？`,
          {
            actionId: a.id,
            capability: name,
            args,
            precondition,
            reason: '此动作需要单次人工授权',
            proposalHash: fingerprint,
          },
          `action:${a.id}`,
        );
        await db.q('UPDATE actions SET approval_id=$2 WHERE id=$1', [a.id, h.id]);
        return { ...a, approval_id: h.id };
      }
      return a;
    });
    if (action.status === 'prepared')
      return { status: 'waiting_human', humanId: action.approval_id };
    if (action.status === 'confirmed')
      return { status: 'confirmed', actionId: action.id, result: action.result };
    if (
      action.status === 'rejected' ||
      action.status === 'invalidated' ||
      action.status === 'failed'
    )
      return { status: action.status, actionId: action.id };
    if (action.status === 'dispatched' || action.status === 'outcome_unknown') {
      await this.reconcile(action);
      return { status: 'reconciling', actionId: action.id };
    }
    await this.db.tx(async (db) => {
      await db.q('SELECT id FROM goals WHERE id=$1 FOR UPDATE', [g.id]);
      await this.assertRun(db, runId);
      const [current] = await db.q('SELECT * FROM actions WHERE id=$1 FOR UPDATE', [action.id]);
      if (current.status !== 'authorized') throw new DomainError('动作已被其他执行器处理');
      if (effect === 'approval_required') {
        const [h] = await db.q(
          "SELECT * FROM human_tasks WHERE id=$1 AND status='answered' AND answer->>'decision'='approve'",
          [current.approval_id],
        );
        if (!h || h.expires_at.getTime() <= Date.now() || h.goal_version !== g.version)
          throw new DomainError('审批失效');
      }
      if (canonical(await cap.precondition(g, args)) !== canonical(precondition))
        throw new DomainError('资源前置条件变化');
      const locked = await db.q(
        'INSERT INTO resource_locks(resource,action_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING *',
        [action.resource, action.id],
      );
      if (!locked.length) throw new DomainError('资源有未决动作，等待核对');
      await db.q("UPDATE actions SET status='dispatched',updated_at=now() WHERE id=$1", [
        action.id,
      ]);
      await event(db, g.id, 'action.dispatched', { id: action.id, capability: name, resource });
    });
    try {
      const result = await cap.execute(g, args, action);
      if (this.afterEffect) await this.afterEffect(action);
      await this.confirm(action, result);
      return { status: 'confirmed', actionId: action.id, result };
    } catch (e) {
      await this.db.tx(async (db) => {
        await db.q(
          "UPDATE actions SET status='outcome_unknown',error=$2,updated_at=now() WHERE id=$1",
          [action.id, String(e)],
        );
        await event(db, g.id, 'action.unknown', { id: action.id });
        await enqueue(db, g.id, 'reconcile');
      });
      throw e;
    }
  }
  // Injectable transport failure for deterministic recovery tests; never exposed through Agent tools.
  afterEffect?: (action: any) => Promise<void>;
  async confirm(action: any, result: any) {
    await this.db.tx(async (db) => {
      await db.q("UPDATE actions SET status='confirmed',result=$2,updated_at=now() WHERE id=$1", [
        action.id,
        JSON.stringify(result),
      ]);
      await db.q('DELETE FROM resource_locks WHERE action_id=$1', [action.id]);
      await event(db, action.goal_id, 'action.confirmed', { id: action.id });
    });
  }
  async reconcile(action: any) {
    const g = await this.goal(action.goal_id);
    const cap = this.packs.capability(g, action.capability);
    const outcome = await cap.reconcile(g, action);
    if (outcome.known) {
      await this.confirm(action, outcome.result);
      return true;
    }
    await this.db.tx(async (db) => {
      await db.q("UPDATE actions SET status='outcome_unknown' WHERE id=$1", [action.id]);
      await this.human(
        db,
        g,
        action.task_id,
        'collaboration',
        '动作结果未知，需要核对外部效果',
        { actionId: action.id, reason: '不会自动重复派发；请核对动作结果并通过动作核对接口结案' },
        `unknown:${action.id}`,
      );
    });
    return false;
  }
  async resolveAction(id: string, outcome: 'confirmed' | 'not_applied', note: string) {
    const [a] = await this.db.q('SELECT * FROM actions WHERE id=$1', [id]);
    if (!a || a.status !== 'outcome_unknown') throw new DomainError('动作无需人工核对');
    if (!note.trim()) throw new DomainError('需要提供核对证据', 400);
    await this.db.tx(async (db) => {
      await db.q('UPDATE actions SET status=$2,result=$3,updated_at=now() WHERE id=$1', [
        id,
        outcome === 'confirmed' ? 'confirmed' : 'failed',
        JSON.stringify({ manual: true, note }),
      ]);
      await db.q('DELETE FROM resource_locks WHERE action_id=$1', [id]);
      await db.q(
        "UPDATE human_tasks SET status='answered',answer=$2,answered_at=now() WHERE dedupe=$1 AND status='pending'",
        [`unknown:${id}`, JSON.stringify({ decision: 'answer', text: note })],
      );
      await db.q("UPDATE tasks SET status='ready' WHERE id=$1", [a.task_id]);
      const g = await this.goal(a.goal_id, db);
      if (g.status === 'active') await enqueue(db, g.id, 'turn', a.task_id);
      await event(db, a.goal_id, 'action.reconciled', { id, outcome, note });
    });
  }
  async addTask(runId: string, input: unknown) {
    const v = z
      .object({
        title: z.string().min(1).max(200),
        resource: z.string(),
        dependencies: z.array(z.string().uuid()).default([]),
      })
      .parse(input);
    return this.db.tx(async (db) => {
      const r = await this.assertRun(db, runId);
      await db.q('SELECT id FROM goals WHERE id=$1 FOR UPDATE', [r.goal_id]);
      await this.assertRun(db, runId);
      const g = await this.goal(r.goal_id, db);
      if (!g.spec.scope.includes(v.resource)) throw new DomainError('子任务越界', 403);
      for (const dep of v.dependencies) {
        if (!(await db.q('SELECT id FROM tasks WHERE id=$1 AND goal_id=$2', [dep, g.id])).length)
          throw new DomainError('依赖不属于当前目标');
      }
      const [existing] = await db.q(
        'SELECT * FROM tasks WHERE goal_id=$1 AND title=$2 AND resource=$3',
        [g.id, v.title, v.resource],
      );
      if (existing) return existing;
      const [t] = await db.q(
        'INSERT INTO tasks(id,goal_id,title,resource,dependencies) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [randomUUID(), g.id, v.title, v.resource, v.dependencies],
      );
      await enqueue(db, g.id, 'turn', t.id);
      await event(db, g.id, 'task.created', { id: t.id, title: t.title });
      return t;
    });
  }
  async inject(id: string, nodeId: string, input: unknown) {
    const v = z
      .object({
        score: z.number().int().min(0).max(100).optional(),
        fault: z.enum(['none', 'disk', 'process', 'hardware']).optional(),
        stale: z.boolean().optional(),
      })
      .parse(input);
    const g = await this.goal(id);
    if (g.spec.pack !== 'cluster' || !g.spec.scope.includes(nodeId))
      throw new DomainError('无此模拟资源');
    await this.db.tx(async (db) => {
      await db.q(
        'UPDATE simulator_nodes SET score=coalesce($3,score),fault=coalesce($4,fault),stale=coalesce($5,stale),version=version+1 WHERE goal_id=$1 AND id=$2',
        [id, nodeId, v.score, v.fault, v.stale],
      );
      await event(db, id, 'simulator.changed', { nodeId, ...v });
      if (g.status === 'active') await enqueue(db, id, 'verify');
    });
  }
}
