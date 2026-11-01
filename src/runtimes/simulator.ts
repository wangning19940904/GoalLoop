import type { RuntimeAdapter, RuntimeEvent, TurnPacket } from '../contracts.js';
export class Simulator implements RuntimeAdapter {
  async probe() {
    return { id: 'simulator', available: true, authenticated: true, version: '1' };
  }
  async *runTurn(p: TurnPacket, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    signal.throwIfAborted();
    yield { type: 'text', text: '读取当前事实与目标边界' };
    if (p.goal.spec.pack === 'cluster') {
      const node = await p.callTool('observe', { resource: p.task.resource });
      if (node.stale) {
        yield {
          type: 'result',
          result: {
            outcome: 'wait_event',
            summary: '观测过期，等待新数据',
            wakeAfterMs: p.goal.spec.sampleMs,
          },
        };
        return;
      }
      if (node.score >= p.goal.spec.threshold) {
        yield {
          type: 'result',
          result: { outcome: 'candidate', summary: '当前节点已达标，请独立验收' },
        };
        return;
      }
      if (node.fault === 'hardware') {
        await p.callTool('request_human', {
          type: 'collaboration',
          question: `${node.id} 需要硬件处理`,
          reason: '软件操作无法修复。请在模拟面板完成硬件修复后回复；回复本身不视为修复证据。',
        });
        yield { type: 'result', result: { outcome: 'need_human', summary: '等待外部硬件修复' } };
        return;
      }
      const name = node.fault === 'disk' ? 'cluster.clean_cache' : 'cluster.restart';
      const action = await p.callTool('propose_action', { capability: name, resource: node.id });
      yield {
        type: 'result',
        result: {
          outcome:
            action.status === 'confirmed'
              ? 'candidate'
              : action.status === 'waiting_human'
                ? 'need_human'
                : action.status === 'rejected'
                  ? 'no_progress'
                  : 'wait_event',
          summary: `${name}: ${action.status}`,
          wakeAfterMs: p.goal.spec.sampleMs,
        },
      };
    } else if (p.goal.spec.pack === 'workspace') {
      const source = await p.callTool('read_workspace', { resource: 'calculator.js' });
      const check = await p.callTool('run_check', { resource: 'calculator.js' });
      if (!check.satisfied) {
        await p.callTool('propose_action', {
          capability: 'workspace.write',
          resource: 'calculator.js',
          content: source.content.replace('return a - b', 'return a + b'),
        });
      }
      yield {
        type: 'result',
        result: { outcome: 'candidate', summary: '已检查并修复示例加法函数，请运行独立验收' },
      };
    } else {
      await p.callTool('request_human', {
        type: 'acceptance',
        question: '请检查目标交付物是否满足约定',
        reason: '此目标配置为人工验收',
      });
      yield { type: 'result', result: { outcome: 'need_human', summary: '等待人工验收' } };
    }
  }
}
