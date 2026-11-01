import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Code2,
  FileCheck2,
  Inbox,
  Layers3,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  Waypoints,
  X,
} from 'lucide-react';
import './style.css';

let csrf = '';
async function api(route: string, body?: unknown, method = 'POST', retry = true): Promise<any> {
  if (!csrf) {
    const s = await fetch('/api/v1/session').then((r) => r.json());
    csrf = s.csrf;
  }
  const r = await fetch('/api/v1' + route, {
    method: body === undefined ? 'GET' : method,
    headers: { 'Content-Type': 'application/json', 'X-GoalLoop-Token': csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await r.json();
  if (r.status === 403 && result.error === 'Invalid local control token' && retry) {
    csrf = '';
    return api(route, body, method, false);
  }
  if (!r.ok) throw new Error(result.error);
  return result;
}
const labels: Record<string, string> = {
  draft: '待启动',
  active: '推进中',
  paused: '已暂停',
  blocked: '受阻',
  succeeded: '已达成',
  expired: '期限结束',
  cancelled: '已取消',
  failed: '失败',
  ready: '待执行',
  running: '执行中',
  done: '已完成',
  waiting_human: '等你处理',
  waiting_event: '等待事件',
  pending: '待处理',
  answered: '已回答',
  invalidated: '已失效',
  confirmed: '已确认',
  authorized: '已授权',
  prepared: '待审批',
  dispatched: '已派发',
  outcome_unknown: '结果待核对',
  rejected: '已拒绝',
  completed: '本轮结束',
  interrupted: '已中断',
  sent: '已发送',
};
const runtimeNames: Record<string, string> = {
  simulator: '模拟执行器',
  codex: 'Codex',
  claude: 'Claude Code',
  deepseek: 'DeepSeek Harness',
  deepagents: 'Deep Agents',
};
const eventNames: Record<string, string> = {
  'goal.created': '目标已创建',
  'goal.start': '开始推进',
  'goal.pause': '目标已暂停',
  'goal.resume': '恢复推进',
  'goal.cancel': '目标已取消',
  'goal.succeeded': '独立验收通过',
  'goal.expired': '目标期限结束',
  'goal.revised': '目标规则已更新',
  'run.started': '执行器开始本轮工作',
  'run.finished': '本轮工作结束',
  'run.output': '执行器输出',
  'run.progress': '进展记录',
  'run.recovered': '恢复中断的运行',
  'human.requested': '需要你的帮助',
  'human.answered': '已收到人工决策',
  'action.dispatched': '执行受控动作',
  'action.confirmed': '已确认动作效果',
  'action.unknown': '动作结果待核对',
  'verification.updated': '独立验收结果更新',
  'simulator.changed': '模拟环境变化',
  'task.regressed': '发现退化，重新治理',
};
const time = (v: string) =>
  new Date(v).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
function Badge({ status }: { status: string }) {
  return (
    <span className={`badge ${status}`}>
      <i />
      {labels[status] || status}
    </span>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}
function App() {
  const [packs, setPacks] = useState<any[]>([]);
  const [goals, setGoals] = useState<any[]>([]),
    [inbox, setInbox] = useState<any[]>([]),
    [runtimes, setRuntimes] = useState<any[]>([]),
    [selected, setSelected] = useState(new URLSearchParams(location.search).get('goal')),
    [detail, setDetail] = useState<any>(null),
    [view, setView] = useState('goals'),
    [tab, setTab] = useState('overview'),
    [form, setForm] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [answer, setAnswer] = useState<Record<string, string>>({}),
    [connected, setConnected] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const [g, h] = await Promise.all([api('/goals'), api('/inbox')]);
      setGoals(g);
      setInbox(h);
      if (selected) setDetail(await api(`/goals/${selected}`));
      setConnected(true);
    } catch (e) {
      setConnected(false);
      setError(String(e));
    }
  }, [selected]);
  useEffect(() => {
    void refresh();
    const es = new EventSource('/api/v1/events');
    let timer: ReturnType<typeof setTimeout> | undefined;
    es.onmessage = () => {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          void refresh();
        }, 250);
    };
    es.onerror = () => setConnected(false);
    es.onopen = () => setConnected(true);
    const poll = setInterval(() => void refresh(), 10000);
    return () => {
      es.close();
      clearInterval(poll);
      clearTimeout(timer);
    };
  }, [refresh]);
  useEffect(() => {
    void api('/packs')
      .then(setPacks)
      .catch((e) => setError(String(e)));
    void api('/runtimes')
      .then(setRuntimes)
      .catch((e) => setError(String(e)));
  }, []);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function choose(id: string | null) {
    setSelected(id);
    setDetail(null);
    setTab('overview');
    setView('goals');
    history.replaceState(null, '', id ? `/?goal=${id}` : '/');
  }
  function create() {
    setForm({
      title: '',
      objective: '',
      pack: 'cluster',
      runtime: 'simulator',
      mode: 'achieve',
      rules: '',
      policyText: '',
      stableMinutes: 30,
      deadlineDays: 7,
      model: '',
      workspace: '',
      fast: false,
    });
  }
  function revise() {
    const s = detail.goal.spec;
    setForm({
      ...s,
      editing: true,
      policyText: JSON.stringify(s.policy, null, 2),
      stableMinutes: s.stableMs / 60000,
      deadlineDays: s.deadlineMs / 86400000,
    });
  }
  const active = goals.filter((g) => g.status === 'active').length,
    complete = goals.filter((g) => g.status === 'succeeded').length;
  const g = detail?.goal;
  const tasks = detail?.tasks || [];
  const human = detail?.human_tasks?.filter((h: any) => h.status === 'pending') || [];
  const next = detail?.jobs
    ?.filter((j: any) => j.status === 'pending')
    .sort((a: any, b: any) => a.due_at.localeCompare(b.due_at))[0];
  return (
    <div className="shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            choose(null);
          }}
        >
          <span className="brand-mark">
            <Waypoints size={23} />
          </span>
          <span>
            GoalLoop<small>持续推进 · 有据可循</small>
          </span>
        </a>
        <div className="workspace-label">
          个人工作空间 <span>LOCAL</span>
        </div>
        <nav>
          <button
            className={view === 'goals' ? 'nav active-nav' : 'nav'}
            onClick={() => choose(null)}
          >
            <Layers3 size={18} />
            目标空间<span>{goals.length}</span>
          </button>
          <button
            className={view === 'inbox' ? 'nav active-nav' : 'nav'}
            onClick={() => {
              setView('inbox');
              setSelected(null);
            }}
          >
            <Inbox size={18} />
            待我处理{inbox.length > 0 && <b>{inbox.length}</b>}
          </button>
          <button
            className={view === 'settings' ? 'nav active-nav' : 'nav'}
            onClick={() => {
              setView('settings');
              setSelected(null);
            }}
          >
            <Settings2 size={18} />
            执行器与连接
          </button>
        </nav>
        <div className="side-note">
          <ShieldCheck size={22} />
          <strong>你定义边界，Agent 负责推进</strong>
          <p>
            每一次等待都有原因，
            <br />
            每一次完成都有证据。
          </p>
        </div>
        <div className="side-footer">
          <span className={`dot ${connected ? '' : 'offline'}`} />
          {connected ? '本机服务已连接' : '正在重新连接'}
          <small>v0.1.0</small>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            工作空间 <ChevronRight size={14} />{' '}
            {view === 'inbox'
              ? '待我处理'
              : view === 'settings'
                ? '执行器与连接'
                : selected
                  ? '目标详情'
                  : '目标空间'}
          </span>
          <div>
            <span className="local-tag">本机 · 无账号</span>
            <button className="icon-button" title="刷新" onClick={() => void refresh()}>
              <RefreshCw size={16} />
            </button>
          </div>
        </header>
        <div className="content">
          {error && (
            <div className="error" role="alert">
              {error}
              <button onClick={() => setError('')}>
                <X size={15} />
              </button>
            </div>
          )}
          {view === 'goals' && !selected && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">YOUR GOALS, IN MOTION</div>
                  <h1>把目标交给持续的行动</h1>
                  <p>定义想要的结果与操作边界，剩下的每一步，都有迹可循。</p>
                </div>
                <button className="primary" onClick={create}>
                  <Plus size={18} />
                  创建目标
                </button>
              </div>
              <div className="stats">
                <Stat icon={<Activity />} label="正在推进" value={active} note="Agent 持续跟进中" />
                <Stat
                  icon={<Inbox />}
                  label="需要你处理"
                  value={inbox.length}
                  note="让关键决策回到你手中"
                  orange
                />
                <Stat
                  icon={<CheckCircle2 />}
                  label="已经达成"
                  value={complete}
                  note="通过独立验收的目标"
                />
              </div>
              <div className="section-heading">
                <h2>
                  全部目标 <span>{goals.length}</span>
                </h2>
                <span className="muted">等待期间不消耗模型调用</span>
              </div>
              {goals.length === 0 ? (
                <div className="welcome">
                  <Waypoints size={42} />
                  <h2>第一个目标，从这里开始</h2>
                  <p>
                    试试让 Agent 把三台模拟机器的健康分提升到 80，
                    <br />
                    或者修复一个真实的本地代码问题。
                  </p>
                  <button className="primary" onClick={create}>
                    <Plus size={16} />
                    定义第一个目标
                  </button>
                </div>
              ) : (
                <div className="goal-grid">
                  {goals.map((goal) => (
                    <button key={goal.id} className="goal-card" onClick={() => choose(goal.id)}>
                      <div className="card-top">
                        <span
                          className={`pack-icon ${goal.spec.pack === 'workspace' ? 'purple' : ''}`}
                        >
                          {goal.spec.pack === 'workspace' ? (
                            <Code2 size={21} />
                          ) : (
                            <Activity size={21} />
                          )}
                        </span>
                        <Badge status={goal.status} />
                      </div>
                      <h3>{goal.title}</h3>
                      <p>{goal.objective || goal.spec.objective}</p>
                      <div className="card-meta">
                        <span>{goal.spec.mode === 'achieve' ? '达成型目标' : '持续维持'}</span>
                        <span>{runtimeNames[goal.spec.runtime]}</span>
                      </div>
                      <div className="card-bottom">
                        <span>{goal.report?.latest?.summary || '等待激活目标契约'}</span>
                        <ArrowUpRight size={16} />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          {view === 'goals' && selected && !detail && (
            <Empty>
              <LoaderCircle className="spin" />
              读取目标状态…
            </Empty>
          )}
          {view === 'goals' && g && (
            <>
              <button className="back" onClick={() => choose(null)}>
                <ArrowLeft size={15} />
                全部目标
              </button>
              <div className="page-heading detail-heading">
                <div>
                  <div className="inline">
                    <Badge status={g.status} />
                    <span className="muted">
                      {g.spec.mode === 'achieve' ? '达成型' : '维持型'} · 契约 v{g.version}
                    </span>
                  </div>
                  <h1>{g.title}</h1>
                  <p>{g.spec.objective}</p>
                </div>
                <div className="actions">
                  {g.status === 'draft' && (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => void act(() => api(`/goals/${g.id}/start`, {}))}
                    >
                      <Play size={16} />
                      启动目标
                    </button>
                  )}
                  {g.status === 'active' && (
                    <button
                      disabled={busy}
                      onClick={() => void act(() => api(`/goals/${g.id}/pause`, {}))}
                    >
                      <Pause size={16} />
                      暂停
                    </button>
                  )}
                  {['paused', 'blocked'].includes(g.status) && (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => void act(() => api(`/goals/${g.id}/resume`, {}))}
                    >
                      <Play size={16} />
                      继续推进
                    </button>
                  )}
                  {['draft', 'active', 'paused', 'blocked'].includes(g.status) && (
                    <>
                      <button onClick={revise}>
                        <Settings2 size={16} />
                        调整契约
                      </button>
                      <button
                        className="danger subtle"
                        disabled={busy}
                        onClick={() => {
                          if (confirm('取消此目标并停止派发新动作？'))
                            void act(() => api(`/goals/${g.id}/cancel`, {}));
                        }}
                      >
                        <Square size={14} />
                        取消
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="detail-metrics">
                <div>
                  <small>执行器</small>
                  <strong>{runtimeNames[g.spec.runtime]}</strong>
                </div>
                <div>
                  <small>任务进度</small>
                  <strong>
                    {tasks.filter((t: any) => t.status === 'done').length}{' '}
                    <span>/ {tasks.length}</span>
                  </strong>
                </div>
                <div>
                  <small>等待人工</small>
                  <strong>
                    {human.length} <span>项</span>
                  </strong>
                </div>
                <div>
                  <small>下次唤醒</small>
                  <strong className="small-value">{next ? time(next.due_at) : '暂无计划'}</strong>
                </div>
                <div>
                  <small>运行预算</small>
                  <strong>
                    {detail.runs.length} <span>/ {g.spec.maxTurns} 轮</span>
                  </strong>
                </div>
              </div>
              <div className="tabs">
                {[
                  ['overview', '进展概览'],
                  ['evidence', '验收证据'],
                  ['actions', '动作与授权'],
                  ['timeline', '运行时间线'],
                  ['contract', '目标契约'],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    className={tab === key ? 'selected' : ''}
                    onClick={() => setTab(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {tab === 'overview' && (
                <div className="detail-columns">
                  <div>
                    <section className="panel">
                      <div className="section-heading">
                        <h2>
                          <Waypoints size={18} />
                          当前工作
                        </h2>
                        <span className="muted">{tasks.length} 个任务</span>
                      </div>
                      {tasks.map((t: any) => (
                        <div className="task-row" key={t.id}>
                          <span className={`task-status ${t.status}`}>
                            {t.status === 'done' ? (
                              <Check size={15} />
                            ) : t.status === 'running' ? (
                              <LoaderCircle className="spin" size={15} />
                            ) : (
                              <Clock3 size={15} />
                            )}
                          </span>
                          <div>
                            <strong>{t.title}</strong>
                            <p>{t.progress || '准备调查现状，选择下一步行动'}</p>
                            <small>
                              {t.dependencies.length
                                ? `${t.dependencies.length} 项前置依赖 · `
                                : ''}
                              连续未推进 {t.attempts} 次
                            </small>
                          </div>
                          <Badge status={t.status} />
                        </div>
                      ))}
                    </section>
                    {g.spec.pack === 'cluster' && (
                      <section className="panel">
                        <div className="section-heading">
                          <h2>
                            <Activity size={18} />
                            模拟集群
                          </h2>
                          <span className="demo-tag">隔离的演示环境</span>
                        </div>
                        <div className="nodes">
                          {detail.nodes.map((n: any) => (
                            <div className="node" key={n.id}>
                              <strong>{n.id}</strong>
                              <span className={n.score >= 80 ? 'score good' : 'score'}>
                                {n.score}
                                <small>/100</small>
                              </span>
                              <div className="meter">
                                <i
                                  style={{ width: `${n.score}%` }}
                                  className={n.score >= 80 ? 'good' : ''}
                                />
                              </div>
                              <p>
                                {n.stale
                                  ? '数据过期'
                                  : (
                                      {
                                        disk: '磁盘缓存积压',
                                        process: '进程异常',
                                        hardware: '硬件故障',
                                        none: '健康',
                                      } as any
                                    )[n.fault]}
                              </p>
                              {n.fault === 'hardware' && (
                                <button
                                  disabled={busy}
                                  onClick={() =>
                                    void act(() =>
                                      api(`/goals/${g.id}/simulator/${n.id}`, {
                                        score: 92,
                                        fault: 'none',
                                        stale: false,
                                      }),
                                    )
                                  }
                                >
                                  模拟完成硬件更换
                                </button>
                              )}
                              {n.fault === 'none' && g.spec.mode === 'maintain' && (
                                <button
                                  onClick={() =>
                                    void act(() =>
                                      api(`/goals/${g.id}/simulator/${n.id}`, {
                                        score: 60,
                                        fault: 'disk',
                                      }),
                                    )
                                  }
                                >
                                  注入退化
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </section>
                    )}
                  </div>
                  <div>
                    <section className="panel verification">
                      <div className="section-heading">
                        <h2>
                          <FileCheck2 size={18} />
                          独立验收
                        </h2>
                      </div>
                      <span
                        className={`verification-symbol ${g.report?.latest?.satisfied ? 'good' : ''}`}
                      >
                        <ShieldCheck size={28} />
                      </span>
                      <h3>{g.report?.latest?.summary || '尚未开始验收'}</h3>
                      <p>
                        {g.spec.pack === 'cluster'
                          ? `冻结 ${g.spec.scope.length} 台机器，逐台 ≥ ${g.spec.threshold} 分`
                          : '独立检查产物与实际结果'}
                      </p>
                      <div className="key-line">
                        <span>稳定观察期</span>
                        <b>{Math.round(g.spec.stableMs / 1000)} 秒</b>
                      </div>
                      <div className="key-line">
                        <span>采样周期</span>
                        <b>{Math.round(g.spec.sampleMs / 1000)} 秒</b>
                      </div>
                      <div className="key-line">
                        <span>截止时间</span>
                        <b>{g.deadline_at ? time(g.deadline_at) : '激活后开始计时'}</b>
                      </div>
                      {g.spec.mode === 'maintain' && (
                        <div className="key-line">
                          <span>已观测达标覆盖率</span>
                          <b>{((g.report.healthyRatio || 0) * 100).toFixed(1)}%</b>
                        </div>
                      )}
                    </section>
                    <section className="panel">
                      <div className="section-heading">
                        <h2>
                          <Inbox size={18} />
                          等待你的帮助
                        </h2>
                      </div>
                      {human.length ? (
                        human.map((h: any) => (
                          <Human
                            key={h.id}
                            h={h}
                            answer={answer[h.id] || ''}
                            setAnswer={(v) => setAnswer({ ...answer, [h.id]: v })}
                            busy={busy}
                            submit={(decision) =>
                              act(() =>
                                api(`/human/${h.id}/answer`, {
                                  decision,
                                  text: answer[h.id] || '',
                                }),
                              )
                            }
                          />
                        ))
                      ) : (
                        <Empty>
                          暂无待处理事项
                          <br />
                          <small>需要你参与时，会在这里出现。</small>
                        </Empty>
                      )}
                    </section>
                  </div>
                </div>
              )}
              {tab === 'evidence' && (
                <section className="panel">
                  <div className="section-heading">
                    <h2>独立观测记录</h2>
                    <span className="muted">仅展示最近 100 条</span>
                  </div>
                  {detail.evidence.length ? (
                    detail.evidence.map((e: any) => (
                      <details className="evidence-row" key={e.id}>
                        <summary>
                          <span className={`dot ${e.satisfied ? '' : 'warning'}`} />
                          <strong>{e.body.summary}</strong>
                          <span>{e.missing ? '缺失观测' : e.satisfied ? '达标' : '未达标'}</span>
                          <time>{time(e.observed_at)}</time>
                        </summary>
                        <pre>{JSON.stringify(e.body.details, null, 2)}</pre>
                      </details>
                    ))
                  ) : (
                    <Empty>还没有验收证据。启动目标后会定期采样。</Empty>
                  )}
                  <details className="evidence-row">
                    <summary>覆盖率报告</summary>
                    <pre>{JSON.stringify(g.report, null, 2)}</pre>
                  </details>
                </section>
              )}
              {tab === 'actions' && (
                <section className="panel">
                  <div className="section-heading">
                    <h2>受控动作账本</h2>
                    <span className="muted">每次动作均经过规则与前置条件检查</span>
                  </div>
                  {detail.actions.length ? (
                    detail.actions.map((a: any) => (
                      <div className="action-row" key={a.id}>
                        <div className="inline">
                          <ShieldCheck size={18} />
                          <strong>{a.capability}</strong>
                          <Badge status={a.status} />
                        </div>
                        <p>
                          {a.args.resource} · 目标版本 {a.goal_version} · {time(a.created_at)}
                        </p>
                        <details>
                          <summary>查看参数、前置条件与结果</summary>
                          <pre>
                            {JSON.stringify(
                              {
                                args: a.args,
                                precondition: a.precondition,
                                result: a.result,
                                error: a.error,
                              },
                              null,
                              2,
                            )}
                          </pre>
                        </details>
                        {a.status === 'outcome_unknown' && (
                          <div className="answer-box">
                            <textarea
                              placeholder="记录外部核对证据"
                              value={answer[a.id] || ''}
                              onChange={(e) => setAnswer({ ...answer, [a.id]: e.target.value })}
                            />
                            <button
                              disabled={busy || !answer[a.id]}
                              onClick={() =>
                                void act(() =>
                                  api(`/actions/${a.id}/reconcile`, {
                                    outcome: 'confirmed',
                                    note: answer[a.id],
                                  }),
                                )
                              }
                            >
                              确认已经生效
                            </button>
                            <button
                              disabled={busy || !answer[a.id]}
                              onClick={() =>
                                void act(() =>
                                  api(`/actions/${a.id}/reconcile`, {
                                    outcome: 'not_applied',
                                    note: answer[a.id],
                                  }),
                                )
                              }
                            >
                              确认未生效
                            </button>
                          </div>
                        )}
                      </div>
                    ))
                  ) : (
                    <Empty>暂无写操作。调查和读取不会计入动作账本。</Empty>
                  )}
                </section>
              )}
              {tab === 'timeline' && (
                <section className="panel">
                  <div className="section-heading">
                    <h2>运行时间线</h2>
                    <span className="muted">实时更新 · 可恢复事件流</span>
                  </div>
                  {detail.events.map((e: any) => (
                    <details className="timeline-row" key={e.id}>
                      <summary>
                        <span className="timeline-dot" />
                        <time>{time(e.created_at)}</time>
                        <strong>{eventNames[e.type] || e.type}</strong>
                      </summary>
                      <pre>{JSON.stringify(e.data, null, 2)}</pre>
                    </details>
                  ))}
                  <h3>通知投递</h3>
                  {detail.outbox.map((n: any) => (
                    <div className="action-row" key={n.id}>
                      <div className="inline">
                        <strong>{n.payload.title}</strong>
                        <Badge status={n.status} />
                      </div>
                      <p>{n.error || `尝试 ${n.attempts} 次`}</p>
                      {n.status === 'failed' && (
                        <button
                          onClick={() => void act(() => api(`/notifications/${n.id}/retry`, {}))}
                        >
                          重试通知
                        </button>
                      )}
                    </div>
                  ))}
                  <h3>模型用量</h3>
                  {detail.runs.map((r: any) => (
                    <div className="key-line" key={r.id}>
                      <span>
                        {runtimeNames[r.runtime]} · {time(r.started_at)}
                      </span>
                      <b>
                        {r.input_tokens === null
                          ? '未知'
                          : `${r.input_tokens} 输入 / ${r.output_tokens} 输出`}
                      </b>
                    </div>
                  ))}
                </section>
              )}
              {tab === 'contract' && (
                <section className="panel">
                  <h2>目标契约 v{g.version}</h2>
                  <p className="muted">规则变更会生成新版本，并使不再适用的审批失效。</p>
                  <pre>{JSON.stringify(g.spec, null, 2)}</pre>
                </section>
              )}
            </>
          )}
          {view === 'inbox' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">HUMAN IN THE LOOP</div>
                  <h1>让每一次参与都有价值</h1>
                  <p>需要你判断的事项集中在这里。未回复的事项会可靠等待。</p>
                </div>
                <span className="count-pill">{inbox.length} 项待处理</span>
              </div>
              {inbox.length ? (
                <div className="inbox-grid">
                  {inbox.map((h) => (
                    <section className="panel" key={h.id}>
                      <button className="goal-link" onClick={() => choose(h.goal_id)}>
                        {h.goal_title}
                        <ArrowUpRight size={14} />
                      </button>
                      <Human
                        h={h}
                        answer={answer[h.id] || ''}
                        setAnswer={(v) => setAnswer({ ...answer, [h.id]: v })}
                        busy={busy}
                        submit={(decision) =>
                          act(() =>
                            api(`/human/${h.id}/answer`, { decision, text: answer[h.id] || '' }),
                          )
                        }
                      />
                    </section>
                  ))}
                </div>
              ) : (
                <div className="welcome">
                  <CheckCircle2 size={40} />
                  <h2>暂时没有需要你处理的事</h2>
                  <p>Agent 会在边界内继续推进，需要帮助时再来找你。</p>
                </div>
              )}
            </>
          )}
          {view === 'settings' && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">RUNTIME CONNECTIONS</div>
                  <h1>同一个目标，多种执行能力</h1>
                  <p>GoalLoop 保存业务状态，执行器负责每一轮的具体工作。</p>
                </div>
                <button onClick={() => void act(async () => setRuntimes(await api('/runtimes')))}>
                  <RefreshCw size={16} />
                  重新检测
                </button>
              </div>
              <div className="runtime-grid">
                {runtimes.map((r) => (
                  <section className="panel runtime-card" key={r.id}>
                    <div className="inline">
                      <Terminal size={22} />
                      <h2>{runtimeNames[r.id]}</h2>
                      <span className={`dot ${r.available ? '' : 'warning'}`} />
                    </div>
                    <p>{r.version || '未检测到版本'}</p>
                    <div className="key-line">
                      <span>运行环境</span>
                      <b>{r.available ? '已就绪' : '未安装'}</b>
                    </div>
                    <div className="key-line">
                      <span>模型认证</span>
                      <b>
                        {r.authenticated
                          ? '已配置'
                          : r.authenticated === null
                            ? '未核实'
                            : '待配置'}
                      </b>
                    </div>
                    {r.reason && <p className="runtime-reason">{r.reason}</p>}
                  </section>
                ))}
              </div>
              <section className="panel settings-note">
                <ShieldCheck size={24} />
                <div>
                  <h3>本机工作空间</h3>
                  <p>
                    凭证通过本机环境配置读取，不会发送到浏览器。飞书机器人可通过环境配置启用；通知后在本机网页中处理。当前版本不提供公网访问或账号系统。
                  </p>
                </div>
              </section>
            </>
          )}
        </div>
      </main>
      {form && (
        <div className="modal-backdrop">
          <form
            className="modal"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                let policy;
                if (form.policyText.trim()) policy = JSON.parse(form.policyText);
                const spec = {
                  title: form.title,
                  objective: form.objective,
                  pack: form.pack,
                  runtime: form.runtime,
                  model: form.model || undefined,
                  mode: form.mode,
                  rules: form.rules,
                  workspace: form.workspace || undefined,
                  policy,
                  deadlineMs: Number(form.deadlineDays) * 86400000,
                  stableMs: form.fast ? 2000 : Number(form.stableMinutes) * 60000,
                  ...(form.fast ? { sampleMs: 1000, freshMs: 3000 } : {}),
                };
                const created = await api(
                  form.editing ? `/goals/${g.id}` : '/goals',
                  form.editing ? { version: g.version, patch: spec } : spec,
                  form.editing ? 'PATCH' : 'POST',
                );
                setForm(null);
                choose(created.id);
              });
            }}
          >
            <div className="modal-heading">
              <div>
                <small>GOAL CONTRACT</small>
                <h2>{form.editing ? '调整目标契约' : '定义一个值得托付的目标'}</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setForm(null)}>
                <X size={20} />
              </button>
            </div>
            <label>
              目标名称
              <input
                autoFocus
                required
                maxLength={200}
                placeholder="例如：把集群机器健康分治理到 80 以上"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </label>
            <label>
              想要达到什么结果？
              <textarea
                required
                rows={3}
                placeholder="描述结果、验收标准，以及遇到问题时你希望如何参与…"
                value={form.objective}
                onChange={(e) => setForm({ ...form, objective: e.target.value })}
              />
            </label>
            <div className="form-grid">
              <label>
                场景能力包
                <select
                  disabled={form.editing}
                  value={form.pack}
                  onChange={(e) => setForm({ ...form, pack: e.target.value })}
                >
                  {packs.map((p) => (
                    <option key={p.id} value={p.id}>
                      {(
                        {
                          cluster: '模拟集群治理',
                          workspace: '本地代码修复',
                          manual: '通用任务 · 人工验收',
                        } as any
                      )[p.id] || p.id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                执行器
                <select
                  value={form.runtime}
                  onChange={(e) => setForm({ ...form, runtime: e.target.value })}
                >
                  {Object.entries(runtimeNames).map(([id, n]) => (
                    <option key={id} value={id}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                目标模式
                <select
                  value={form.mode}
                  onChange={(e) => setForm({ ...form, mode: e.target.value })}
                >
                  <option value="achieve">达成后结束</option>
                  <option value="maintain">期限内持续维持</option>
                </select>
              </label>
              <label>
                期限（天）
                <input
                  type="number"
                  min="0.001"
                  step="0.001"
                  max="90"
                  value={form.deadlineDays}
                  onChange={(e) => setForm({ ...form, deadlineDays: e.target.value })}
                />
              </label>
              <label>
                稳定观察期（分钟）
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.stableMinutes}
                  onChange={(e) => setForm({ ...form, stableMinutes: e.target.value })}
                />
              </label>
              <label>
                模型（留空使用本机配置）
                <input
                  value={form.model}
                  placeholder="执行器支持的模型标识"
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                />
              </label>
            </div>
            <label>
              示例源工作区（可选，复制 calculator.js，原文件保留）
              <input
                disabled={form.editing}
                value={form.workspace || ''}
                placeholder="留空使用内置示例"
                onChange={(e) => setForm({ ...form, workspace: e.target.value })}
              />
            </label>
            <details className="form-details">
              <summary>规则与操作边界</summary>
              <label>
                工作指导（Markdown）
                <textarea
                  rows={3}
                  value={form.rules}
                  onChange={(e) => setForm({ ...form, rules: e.target.value })}
                />
              </label>
              <label>
                授权策略（JSON，留空使用场景默认值）
                <textarea
                  rows={4}
                  className="code-input"
                  value={form.policyText}
                  onChange={(e) => setForm({ ...form, policyText: e.target.value })}
                />
              </label>
              <p>
                策略仅匹配已注册的能力。禁止优先，未声明的能力不可执行；指导文字不会自动扩大权限。
              </p>
            </details>
            {!form.editing && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={form.fast}
                  onChange={(e) => setForm({ ...form, fast: e.target.checked })}
                />
                快速演示：每秒采样，稳定 2 秒后验收
              </label>
            )}
            <div className="modal-footer">
              <span>创建后先检查契约，再手动启动。</span>
              <button type="submit" className="primary" disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}{' '}
                {form.editing ? '保存新版本' : '创建目标'}
              </button>
            </div>
            {error && <p className="form-error">{error}</p>}
          </form>
        </div>
      )}
    </div>
  );
}
function Stat({
  icon,
  label,
  value,
  note,
  orange = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  note: string;
  orange?: boolean;
}) {
  return (
    <div className="stat">
      <div>
        <span className="stat-label">{label}</span>
        <strong>
          {value}
          <small>个</small>
        </strong>
        <p>{note}</p>
      </div>
      <span className={`stat-icon ${orange ? 'orange' : ''}`}>{icon}</span>
    </div>
  );
}
function Human({
  h,
  answer,
  setAnswer,
  busy,
  submit,
}: {
  h: any;
  answer: string;
  setAnswer: (s: string) => void;
  busy: boolean;
  submit: (decision: string) => Promise<void>;
}) {
  const approval = ['approval', 'acceptance'].includes(h.type);
  const expired = new Date(h.expires_at).getTime() <= Date.now();
  return (
    <div className="human">
      <span className="human-kind">
        {
          (
            {
              approval: '动作审批',
              clarification: '目标澄清',
              capability: '能力请求',
              collaboration: '外部协作',
              acceptance: '人工验收',
            } as any
          )[h.type]
        }
      </span>
      <h3>{h.title}</h3>
      <p>{h.details.reason}</p>
      {h.details.args && <pre>{JSON.stringify(h.details.args, null, 2)}</pre>}
      <details>
        <summary>证据、已尝试方案与影响范围</summary>
        <pre>
          {JSON.stringify(
            {
              impact: h.details.impact,
              attempted: h.details.attempted,
              precondition: h.details.precondition,
              evidence: h.details.evidence,
              options: h.details.options,
            },
            null,
            2,
          )}
        </pre>
      </details>
      <small>
        有效至 {time(h.expires_at)} · 目标 v{h.goal_version}
      </small>
      <textarea
        placeholder={approval ? '补充决策说明（可选）' : '回复结论、证据或处理结果'}
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
      />
      <div className="actions">
        {approval ? (
          <>
            <button
              className="primary"
              disabled={busy || expired}
              onClick={() => void submit('approve')}
            >
              <Check size={15} />
              批准
            </button>
            <button disabled={busy || expired} onClick={() => void submit('reject')}>
              拒绝
            </button>
          </>
        ) : (
          <button
            className="primary"
            disabled={busy || expired || !answer.trim()}
            onClick={() => void submit('answer')}
          >
            提交回复
            <ArrowUpRight size={15} />
          </button>
        )}
        {expired && <span className="muted">已过期，请刷新方案</span>}
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
