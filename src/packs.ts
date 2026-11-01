import { z } from 'zod';
import { mkdir, readFile, realpath, lstat, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { getQuickJS } from 'quickjs-emscripten';
import { config } from './config.js';
import {
  DomainError,
  policies,
  type Goal,
  type GoalInput,
  type GoalSpec,
  type Verification,
} from './contracts.js';
import { type Store, type Sql } from './db.js';
import { hash } from './policy.js';

export type Capability = {
  name: string;
  write: boolean;
  schema: z.ZodType;
  lockKey?: (goal: Goal, args: any) => string;
  precondition: (goal: Goal, args: any) => Promise<any>;
  execute: (goal: Goal, args: any, action: any) => Promise<any>;
  reconcile: (goal: Goal, action: any) => Promise<{ known: boolean; result?: any }>;
};
export interface CapabilityPack {
  id: string;
  capabilities: Capability[];
  freezeScope?: (input: GoalInput) => Promise<string[]>;
  policyTemplate?: GoalSpec['policy'];
  context?: (goal: Goal) => Promise<unknown>;
  initialize: (db: Sql, goal: Goal) => Promise<{ title: string; resource: string }[]>;
  verify: (goal: Goal, resource?: string) => Promise<Verification>;
}
const nodeArgs = z.object({ resource: z.string().min(1) }).strict();
export class Packs {
  static factories: ((db: Store) => CapabilityPack)[] = [];
  registry = new Map<string, CapabilityPack>();
  constructor(public db: Store) {
    this.register(this.cluster());
    this.register(this.workspace());
    this.register({
      id: 'manual',
      capabilities: [],
      initialize: async () => [{ title: '整理目标与验收证据', resource: 'manual' }],
      verify: async (goal) => {
        const accepted = await this.db.q(
          "SELECT id FROM human_tasks WHERE goal_id=$1 AND goal_version=$2 AND type='acceptance' AND status='answered' AND answer->>'decision'='approve'",
          [goal.id, goal.version],
        );
        return {
          satisfied: accepted.length > 0,
          missing: false,
          summary: accepted.length ? '人工验收通过' : '等待独立人工验收',
          details: {},
        };
      },
    });
  }
  register(pack: CapabilityPack) {
    if (this.registry.has(pack.id)) throw new Error('Duplicate capability pack');
    this.registry.set(pack.id, pack);
  }
  loadInstalled() {
    for (const factory of Packs.factories) this.register(factory(this.db));
  }
  async scope(input: GoalInput) {
    const p = this.get(input.pack || 'cluster');
    const scope = p.freezeScope
      ? await p.freezeScope(input)
      : p.id === 'cluster'
        ? ['node-01', 'node-02', 'node-03']
        : p.id === 'workspace'
          ? ['calculator.js']
          : p.id === 'manual'
            ? ['manual']
            : [];
    if (!scope.length || new Set(scope).size !== scope.length)
      throw new DomainError('能力包必须提供非空且无重复的冻结资源清单', 400);
    return scope;
  }
  defaultPolicy(id: string): GoalSpec['policy'] {
    return (
      this.get(id).policyTemplate ??
      ((policies as any)[id] || []).map((p: any) => ({ ...p, resources: ['*'] }))
    );
  }
  get(id: string) {
    const p = this.registry.get(id);
    if (!p) throw new DomainError('Unknown capability pack', 400);
    return p;
  }
  capability(goal: Goal, name: string) {
    const c = this.get(goal.spec.pack).capabilities.find((c) => c.name === name);
    if (!c) throw new DomainError('未注册的能力', 403);
    return c;
  }
  private cluster(): CapabilityPack {
    const precondition = async (goal: Goal, args: any) => {
      if (!goal.spec.scope.includes(args.resource))
        throw new DomainError('资源不在目标范围内', 403);
      const [n] = await this.db.q('SELECT * FROM simulator_nodes WHERE goal_id=$1 AND id=$2', [
        goal.id,
        args.resource,
      ]);
      if (!n) throw new DomainError('目标资源缺失');
      return { version: n.version };
    };
    const read: Capability = {
      name: 'cluster.observe',
      write: false,
      schema: nodeArgs,
      precondition,
      execute: async (g, a) => {
        await precondition(g, a);
        const [node] = await this.db.q('SELECT * FROM simulator_nodes WHERE goal_id=$1 AND id=$2', [
          g.id,
          a.resource,
        ]);
        return node;
      },
      reconcile: async () => ({ known: false }),
    };
    const write = (name: string, fault: string): Capability => ({
      name,
      write: true,
      schema: nodeArgs,
      precondition,
      execute: async (g, a, action) =>
        this.db.tx(async (db) => {
          const [previous] = await db.q(
            'SELECT result FROM simulator_operations WHERE action_id=$1',
            [action.id],
          );
          if (previous) return previous.result;
          const [node] = await db.q(
            'SELECT * FROM simulator_nodes WHERE goal_id=$1 AND id=$2 FOR UPDATE',
            [g.id, a.resource],
          );
          if (!node || node.version !== action.precondition.version)
            throw new DomainError('资源已变化，需要重新调查');
          if (node.fault !== fault) throw new DomainError('修复动作不适用于当前故障');
          const [updated] = await db.q(
            "UPDATE simulator_nodes SET score=92,fault='none',version=version+1,observed_at=now() WHERE goal_id=$1 AND id=$2 RETURNING *",
            [g.id, a.resource],
          );
          await db.q('INSERT INTO simulator_operations(action_id,result) VALUES($1,$2)', [
            action.id,
            JSON.stringify(updated),
          ]);
          return updated;
        }),
      reconcile: async (_, action) => {
        const [r] = await this.db.q('SELECT result FROM simulator_operations WHERE action_id=$1', [
          action.id,
        ]);
        return { known: !!r, result: r?.result };
      },
    });
    return {
      id: 'cluster',
      capabilities: [
        read,
        write('cluster.clean_cache', 'disk'),
        write('cluster.restart', 'process'),
      ],
      initialize: async (db, g) => {
        const nodes = [
          ['node-01', 62, 'disk'],
          ['node-02', 55, 'process'],
          ['node-03', 43, 'hardware'],
        ];
        for (const [id, score, fault] of nodes)
          await db.q('INSERT INTO simulator_nodes(goal_id,id,score,fault) VALUES($1,$2,$3,$4)', [
            g.id,
            id,
            score,
            fault,
          ]);
        return nodes.map(([id]) => ({ title: `治理 ${id} 的健康问题`, resource: String(id) }));
      },
      verify: async (g, resource) => {
        await this.db.q(
          'UPDATE simulator_nodes SET observed_at=now() WHERE goal_id=$1 AND stale=false',
          [g.id],
        );
        const rows = await this.db.q('SELECT * FROM simulator_nodes WHERE goal_id=$1 ORDER BY id', [
          g.id,
        ]);
        const scope = resource ? [resource] : g.spec.scope;
        const details = scope.map((id) => {
          const n = rows.find((n) => n.id === id);
          return {
            id,
            score: n?.score ?? null,
            version: n?.version ?? null,
            fresh:
              !!n && !n.stale && Date.now() - new Date(n.observed_at).getTime() <= g.spec.freshMs,
          };
        });
        const missing = details.some((n) => !n.fresh);
        const satisfied =
          !missing && details.length > 0 && details.every((n) => n.score >= g.spec.threshold);
        return {
          satisfied,
          missing,
          summary: satisfied
            ? `全部 ${details.length} 台机器达到 ${g.spec.threshold} 分`
            : `${details.filter((n) => !n.fresh || n.score < g.spec.threshold).length} 台机器未达标或观测缺失`,
          details,
        };
      },
    };
  }
  workspaceDir(goalId: string) {
    return path.join(config.dataDir, 'workspaces', goalId);
  }
  async file(goal: Goal, name: string) {
    if (name !== 'calculator.js' || !goal.spec.scope.includes(name))
      throw new DomainError('文件不在可操作清单内', 403);
    const root = await realpath(this.workspaceDir(goal.id));
    const target = path.join(root, name);
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new DomainError('不允许符号链接或非普通文件', 403);
    const resolved = await realpath(target);
    if (path.dirname(resolved) !== root) throw new DomainError('文件越界', 403);
    return target;
  }
  private workspace(): CapabilityPack {
    const args = z.object({ resource: z.literal('calculator.js') }).strict();
    const precondition = async (g: Goal, a: any) => ({
      sha256: hash(await readFile(await this.file(g, a.resource), 'utf8')),
    });
    const check = async (g: Goal) => {
      const source = await readFile(await this.file(g, 'calculator.js'), 'utf8');
      const Q = await getQuickJS();
      const runtime = Q.newRuntime();
      runtime.setMemoryLimit(8 * 1024 * 1024);
      runtime.setMaxStackSize(256 * 1024);
      const until = Date.now() + 1000;
      runtime.setInterruptHandler(() => Date.now() > until);
      const context = runtime.newContext();
      try {
        const result = context.evalCode(source);
        if (result.error) {
          const error = context.dump(result.error);
          result.error.dispose();
          return { satisfied: false, missing: false, summary: '独立检查失败', details: error };
        }
        result.value.dispose();
        // Expected outputs and comparisons live in the host, never in the mutable guest program.
        const fn = context.getProp(context.global, 'add');
        const rows: any[] = [];
        try {
          for (const [a, b, want] of [
            [2, 3, 5],
            [-2, 5, 3],
            [0, 0, 0],
            [1.5, 2.5, 4],
          ]) {
            const left = context.newNumber(a),
              right = context.newNumber(b);
            try {
              const value = context.callFunction(fn, context.undefined, left, right);
              if (value.error) {
                const error = context.dump(value.error);
                value.error.dispose();
                rows.push({ a, b, want, passed: false, error });
              } else {
                const actual =
                  context.typeof(value.value) === 'number' ? context.getNumber(value.value) : null;
                value.value.dispose();
                rows.push({ a, b, want, actual, passed: actual === want });
              }
            } finally {
              left.dispose();
              right.dispose();
            }
          }
        } finally {
          fn.dispose();
        }
        const pass = rows.every((r) => r.passed);
        return {
          satisfied: pass,
          missing: false,
          summary: pass ? '4 项独立函数检查全部通过' : '函数行为未达到验收条件',
          details: rows,
        };
      } finally {
        context.dispose();
        runtime.dispose();
      }
    };
    return {
      id: 'workspace',
      initialize: async (_, g) => {
        const dir = this.workspaceDir(g.id);
        let source =
          '// Implement addition for positive, negative, zero and decimal inputs.\nfunction add(a, b) { return a - b; }\n';
        if (g.spec.workspace) {
          const file = path.join(path.resolve(g.spec.workspace), 'calculator.js');
          const stat = await lstat(file);
          if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64000)
            throw new DomainError('源文件必须为 64KB 以内的普通 calculator.js 文件', 400);
          source = await readFile(file, 'utf8');
        }
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await open(path.join(dir, 'calculator.js'), 'wx', 0o600).then(async (f) => {
          await f.writeFile(source);
          await f.close();
        });
        return [{ title: '修复 calculator.js 并通过独立检查', resource: 'calculator.js' }];
      },
      verify: check,
      capabilities: [
        {
          name: 'workspace.read',
          write: false,
          schema: args,
          precondition,
          execute: async (g, a) => ({
            content: await readFile(await this.file(g, a.resource), 'utf8'),
            ...(await precondition(g, a)),
          }),
          reconcile: async () => ({ known: false }),
        },
        {
          name: 'workspace.run_check',
          write: false,
          schema: args,
          precondition,
          execute: async (g) => check(g),
          reconcile: async () => ({ known: false }),
        },
        {
          name: 'workspace.write',
          write: true,
          schema: args.extend({ content: z.string().max(64000) }),
          precondition,
          execute: async (g, a, action) => {
            const file = await this.file(g, a.resource);
            if (hash(await readFile(file, 'utf8')) !== action.precondition.sha256)
              throw new DomainError('文件已变化，需重新读取');
            const temp = file + '.' + action.id + '.tmp';
            const f = await open(temp, 'w', 0o600);
            try {
              await f.writeFile(a.content);
              await f.sync();
            } finally {
              await f.close();
            }
            await rename(temp, file);
            const dir = await open(path.dirname(file), 'r');
            try {
              await dir.sync();
            } finally {
              await dir.close();
            }
            return { sha256: hash(a.content) };
          },
          reconcile: async (g, action) => {
            try {
              const actual = hash(await readFile(await this.file(g, action.args.resource), 'utf8'));
              return { known: actual === hash(action.args.content), result: { sha256: actual } };
            } catch {
              return { known: false };
            }
          },
        },
      ],
    };
  }
}
