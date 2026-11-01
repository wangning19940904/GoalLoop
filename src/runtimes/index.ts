import type { RuntimeAdapter } from '../contracts.js';
import { Simulator } from './simulator.js';
import { Codex } from './codex.js';
import { Claude } from './claude.js';
import { DeepSeek } from './deepseek.js';
import { DeepAgents } from './deepagents.js';
export const runtimes: Record<string, RuntimeAdapter> = {
  simulator: new Simulator(),
  codex: new Codex(),
  claude: new Claude(),
  deepseek: new DeepSeek(),
  deepagents: new DeepAgents(),
};
export function getRuntime(id: string) {
  const r = runtimes[id];
  if (!r) throw new Error('Unknown runtime');
  return r;
}
export async function probeRuntimes() {
  return Promise.all(Object.values(runtimes).map((r) => r.probe()));
}
