import { describe, it, expect } from 'vitest';
import { decision, hash, canonical, parsePolicy } from '../src/policy.js';
import { childEnv, parseResult } from '../src/runtimes/common.js';
import { harnessPatch } from '../src/runtimes/deepseek.js';
import { disableInheritedMcp } from '../src/runtimes/codex.js';
describe('policy and protocol boundaries', () => {
  it('disables inherited MCP from valid TOML forms and fails closed on ambiguous names', () => {
    expect(
      disableInheritedMcp(
        '[mcp_servers]\na={command="example"}\n[mcp_servers."b"]\nurl="https://example.invalid"\n',
      ),
    ).toEqual(['mcp_servers.a.enabled=false', 'mcp_servers.b.enabled=false']);
    expect(disableInheritedMcp('[profiles.demo.mcp_servers.c]\ncommand="example"')).toContain(
      'profiles.demo.mcp_servers.c.enabled=false',
    );
    expect(() => disableInheritedMcp('[mcp_servers."dotted.name"]\ncommand="example"')).toThrow(
      'safely overridden',
    );
    expect(() => disableInheritedMcp('broken = ')).toThrow('safely parse');
  });
  it('denies unspecified resources and prioritizes denial over allow and approval', () => {
    expect(decision([], 'x', 'node')).toBe('deny');
    const rules = parsePolicy(
      '- capability: x\n  effect: allow\n  resources: [node]\n- capability: x\n  effect: approval_required\n- capability: x\n  effect: deny\n',
    );
    expect(decision(rules, 'x', 'node')).toBe('deny');
    expect(decision(rules.slice(0, 2), 'x', 'node')).toBe('approval_required');
    expect(decision(rules.slice(0, 1), 'x', 'other')).toBe('deny');
  });
  it('hashes proposals independent of key order', () =>
    expect(hash(canonical({ a: 1, b: { d: 2, c: 3 } }))).toBe(
      hash(canonical({ b: { c: 3, d: 2 }, a: 1 })),
    ));
  it('does not inherit database or notification secrets into subprocesses', () => {
    process.env.DATABASE_URL = 'secret-test';
    process.env.FEISHU_SECRET = 'secret-test';
    expect(childEnv().DATABASE_URL).toBeUndefined();
    expect(childEnv().FEISHU_SECRET).toBeUndefined();
    delete process.env.DATABASE_URL;
    delete process.env.FEISHU_SECRET;
  });
  it('never treats prose completion as success', () =>
    expect(parseResult('All done!').outcome).toBe('no_progress'));
  it('disables native shell tools in DeepSeek and only injects a scoped gateway', () => {
    const patch = harnessPatch({ apiUrl: 'http://localhost', token: 'scoped' });
    expect(patch).toContainEqual({ id: 'persistent-bash', disabled: true });
    expect(JSON.stringify(patch)).not.toContain('danger-full-access');
  });
});
