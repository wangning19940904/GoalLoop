import { z } from 'zod';

export const runtimeId = z.enum(['simulator', 'codex', 'claude', 'deepseek', 'deepagents']);
export const policyRule = z.object({
  capability: z.string().min(1),
  effect: z.enum(['allow', 'approval_required', 'deny']),
  resources: z.array(z.string()).default(['*']),
});
export const policies = {
  cluster: [
    { capability: 'cluster.observe', effect: 'allow' },
    { capability: 'cluster.clean_cache', effect: 'allow' },
    { capability: 'cluster.restart', effect: 'approval_required' },
  ],
  workspace: [
    { capability: 'workspace.read', effect: 'allow' },
    { capability: 'workspace.write', effect: 'allow' },
    { capability: 'workspace.run_check', effect: 'allow' },
  ],
  manual: [],
} as const;
export const goalInput = z.object({
  title: z.string().min(1).max(200),
  objective: z.string().min(1).max(16000),
  mode: z.enum(['achieve', 'maintain']).default('achieve'),
  pack: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,63}$/)
    .default('cluster'),
  runtime: runtimeId.default('simulator'),
  model: z.string().max(200).optional(),
  rules: z.string().max(64000).default(''),
  policy: z.array(policyRule).optional(),
  workspace: z.string().max(4096).optional(),
  deadlineMs: z
    .number()
    .int()
    .min(1000)
    .max(90 * 86400000)
    .default(7 * 86400000),
  stableMs: z
    .number()
    .int()
    .min(0)
    .default(30 * 60000),
  sampleMs: z.number().int().min(100).default(60000),
  freshMs: z.number().int().min(100).default(120000),
  threshold: z.number().min(0).max(100).default(80),
  maxTurns: z.number().int().min(1).max(10000).default(100),
  turnTimeoutMs: z.number().int().min(1000).max(3600000).default(600000),
  maxAttempts: z.number().int().min(1).max(20).default(3),
  tokenBudget: z.number().int().positive().optional(),
});
export type GoalInput = z.input<typeof goalInput>;
export type GoalSpec = z.output<typeof goalInput> & {
  policy: z.infer<typeof policyRule>[];
  scope: string[];
};
export type Goal = {
  id: string;
  title: string;
  status: string;
  version: number;
  spec: GoalSpec;
  created_at: Date;
  updated_at: Date;
  activated_at: Date | null;
  deadline_at: Date | null;
  stable_since: Date | null;
  report: any;
};
export type Task = {
  id: string;
  goal_id: string;
  title: string;
  resource: string;
  status: string;
  dependencies: string[];
  attempts: number;
  progress: string;
  created_at: Date;
};
export type RuntimeStatus = {
  id: string;
  available: boolean;
  authenticated: boolean | null;
  version?: string;
  reason?: string;
};
export const turnResult = z.object({
  outcome: z.enum(['progress', 'need_human', 'wait_event', 'candidate', 'no_progress', 'failed']),
  summary: z.string().max(16000),
  wakeAfterMs: z.number().int().min(100).max(86400000).optional(),
  question: z.string().max(4000).optional(),
  humanType: z.enum(['clarification', 'capability', 'collaboration', 'acceptance']).optional(),
});
export type TurnResult = z.infer<typeof turnResult>;
export type RuntimeEvent =
  | { type: 'text'; text: string }
  | { type: 'session'; sessionId: string }
  | { type: 'usage'; input: number; output: number }
  | { type: 'result'; result: TurnResult };
export type ToolDefinition = { name: string; description: string; schema: Record<string, unknown> };
export type TurnPacket = {
  runId: string;
  goal: Goal;
  task: Task;
  tasks: Task[];
  evidence: any[];
  decisions: any[];
  capabilities?: { name: string; write: boolean; schema: Record<string, unknown> }[];
  context?: unknown;
  sessionId?: string;
  tools: ToolDefinition[];
  callTool: (name: string, args: any) => Promise<any>;
  apiUrl: string;
  token: string;
  runtimeHome: string;
};
export interface RuntimeAdapter {
  probe(): Promise<RuntimeStatus>;
  runTurn(packet: TurnPacket, signal: AbortSignal): AsyncIterable<RuntimeEvent>;
}
export type Verification = {
  satisfied: boolean;
  missing: boolean;
  summary: string;
  details: unknown;
};
export class DomainError extends Error {
  constructor(
    message: string,
    public statusCode = 409,
  ) {
    super(message);
  }
}
export const terminal = new Set(['succeeded', 'cancelled', 'expired', 'failed']);
