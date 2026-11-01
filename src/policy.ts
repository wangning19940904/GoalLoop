import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { z } from 'zod';
import { policyRule } from './contracts.js';
export function parsePolicy(text: string) {
  const value = parse(text);
  return z.array(policyRule).parse(
    Array.isArray(value)
      ? value
      : z
          .object({ rules: z.array(policyRule) })
          .strict()
          .parse(value).rules,
  );
}
export function decision(
  rules: z.infer<typeof policyRule>[],
  capability: string,
  resource: string,
) {
  const matches = rules.filter(
    (r) =>
      (r.capability === '*' || r.capability === capability) &&
      r.resources.some((x) => x === '*' || x === resource),
  );
  if (matches.some((r) => r.effect === 'deny')) return 'deny';
  if (matches.some((r) => r.effect === 'approval_required')) return 'approval_required';
  return matches.some((r) => r.effect === 'allow') ? 'allow' : 'deny';
}
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object')
    return (
      '{' +
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => JSON.stringify(k) + ':' + canonical(x))
        .join(',') +
      '}'
    );
  return JSON.stringify(v);
}
export const hash = (v: string) => createHash('sha256').update(v).digest('hex');
