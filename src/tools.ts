import { z } from 'zod';
import { turnResult, type ToolDefinition } from './contracts.js';
import { Engine } from './engine.js';
import { event } from './db.js';
const schemas = {
  read_goal: z.object({}).strict(),
  observe: z.object({ resource: z.string() }).strict(),
  read_workspace: z.object({ resource: z.literal('calculator.js') }).strict(),
  run_check: z.object({ resource: z.literal('calculator.js') }).strict(),
  propose_action: z
    .object({
      capability: z.string(),
      resource: z.string(),
      content: z.string().max(64000).optional(),
      args: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  request_human: z
    .object({
      type: z.enum(['clarification', 'capability', 'collaboration', 'acceptance']),
      question: z.string().min(1).max(4000),
      reason: z.string().max(8000).default(''),
    })
    .strict(),
  add_task: z.object({
    title: z.string().min(1).max(200),
    resource: z.string(),
    dependencies: z.array(z.string().uuid()).default([]),
  }),
  record_progress: z.object({ summary: z.string().max(8000) }).strict(),
  finish_turn: turnResult,
};
const descriptions: Record<keyof typeof schemas, string> = {
  read_goal:
    'Read the current goal, tasks, evidence and human decisions. These override remembered state.',
  observe: 'Read current cluster node state; resource must be in scope.',
  read_workspace: 'Read an authorized workspace file.',
  run_check: 'Run the registered independent workspace checker. Cannot modify its tests.',
  propose_action:
    'Propose a registered action. Policy may execute it, require human approval, or deny it. Never bypass a denial.',
  request_human:
    'Persist a question, missing capability or external collaboration request. Return control rather than wait in a loop.',
  add_task: 'Add an in-scope dependent task. Does not expand goal authority.',
  record_progress: 'Record meaningful progress with evidence references.',
  finish_turn:
    'Submit the structured outcome of this turn. candidate means ready for independent verification, not goal success.',
};
export const toolDefinitions: ToolDefinition[] = Object.entries(schemas).map(([name, schema]) => ({
  name,
  description: descriptions[name as keyof typeof schemas],
  schema: z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>,
}));
export async function callTool(
  engine: Engine,
  runId: string,
  name: string,
  raw: unknown,
): Promise<any> {
  if (!(name in schemas)) throw new Error('Unknown tool');
  const args = (schemas as any)[name].parse(raw);
  const run = await engine.assertRun(engine.db, runId);
  const goal = await engine.goal(run.goal_id);
  switch (name) {
    case 'read_goal': {
      const d: any = await engine.detail(goal.id);
      return {
        goal: d.goal,
        tasks: d.tasks,
        evidence: d.evidence,
        decisions: d.human_tasks.filter((h: any) => h.status === 'answered'),
      };
    }
    case 'observe':
      return engine.propose(runId, 'cluster.observe', args);
    case 'read_workspace':
      return engine.propose(runId, 'workspace.read', args);
    case 'run_check':
      return engine.propose(runId, 'workspace.run_check', args);
    case 'propose_action': {
      const { capability, args: parameters, ...input } = args;
      return engine.propose(runId, capability, { ...parameters, ...input });
    }
    case 'add_task':
      return engine.addTask(runId, args);
    case 'request_human':
      return engine.db.tx(async (db) => {
        await db.q('SELECT id FROM goals WHERE id=$1 FOR UPDATE', [goal.id]);
        await engine.assertRun(db, runId);
        return engine.human(db, goal, run.task_id, args.type, args.question, {
          reason: args.reason,
        });
      });
    case 'record_progress':
      return engine.db.tx(async (db) => {
        await db.q('SELECT id FROM goals WHERE id=$1 FOR UPDATE', [goal.id]);
        await engine.assertRun(db, runId);
        await db.q('UPDATE tasks SET progress=$2 WHERE id=$1', [run.task_id, args.summary]);
        await event(db, goal.id, 'run.progress', { runId, summary: args.summary });
        return { recorded: true };
      });
    case 'finish_turn':
      return engine.db.tx(async (db) => {
        await db.q('SELECT id FROM goals WHERE id=$1 FOR UPDATE', [goal.id]);
        await engine.assertRun(db, runId);
        await db.q('UPDATE runs SET summary=$2 WHERE id=$1', [runId, JSON.stringify(args)]);
        return { recorded: true, verificationRequired: args.outcome === 'candidate' };
      });
  }
}
