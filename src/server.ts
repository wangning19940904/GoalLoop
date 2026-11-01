import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { z, ZodError } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Engine } from './engine.js';
import { config } from './config.js';
import { DomainError, goalInput } from './contracts.js';
import { enqueue, event } from './db.js';
import { probeRuntimes } from './runtimes/index.js';
import { toolDefinitions, callTool } from './tools.js';
const uuid = z.string().uuid();
function equal(a: string, b: string) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export async function createServer(
  engine: Engine,
  options: { port?: number; logger?: boolean } = {},
) {
  const port = options.port ?? config.port;
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 256 * 1024,
    trustProxy: false,
  });
  const csrf = randomBytes(32).toString('hex');
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  if (port === 12411) origins.add('http://127.0.0.1:12410');
  const streams = new Set<import('node:http').ServerResponse>();
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.end();
    streams.clear();
  });
  app.setErrorHandler((error, _, reply) => {
    const status =
      error instanceof ZodError ? 400 : error instanceof DomainError ? error.statusCode : 500;
    if (status === 500) app.log.error(error);
    reply
      .code(status)
      .send({ error: status === 500 ? '内部错误，请检查服务日志' : (error as Error).message });
  });
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host || '').toLowerCase();
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host))
      throw new DomainError('Invalid Host', 403);
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) throw new DomainError('Cross-origin request denied', 403);
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      );
    if (req.url.startsWith('/api/v1/mcp')) {
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      if (!token) throw new DomainError('Missing run token', 401);
      (req as any).runId = await engine.authorizeToken(token);
    } else if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const token = String(req.headers['x-goalloop-token'] || '');
      if (!equal(token, csrf)) throw new DomainError('Invalid local control token', 403);
    }
  });
  app.get('/api/v1/session', async () => ({
    csrf,
    localOnly: true,
    notificationConfigured: !!process.env.FEISHU_WEBHOOK,
  }));
  app.get('/api/v1/health', async () => {
    await engine.db.q('SELECT 1');
    return { ok: true, version: '0.1.0' };
  });
  app.get('/api/v1/runtimes', async () => probeRuntimes());
  app.get('/api/v1/packs', async () =>
    [...engine.packs.registry.values()].map((p) => ({
      id: p.id,
      capabilities: p.capabilities.map((c) => ({
        name: c.name,
        write: c.write,
        schema: z.toJSONSchema(c.schema),
      })),
      policyTemplate: engine.packs.defaultPolicy(p.id),
    })),
  );
  app.get('/api/v1/goals', async () => engine.db.listGoals());
  app.post('/api/v1/goals', async (req, reply) => {
    const g = await engine.create(goalInput.parse(req.body));
    reply.code(201);
    return g;
  });
  app.get('/api/v1/goals/:id', async (req) => engine.detail(uuid.parse((req.params as any).id)));
  app.patch('/api/v1/goals/:id', async (req) => {
    const body = z
      .object({ version: z.number().int(), patch: z.record(z.string(), z.unknown()) })
      .parse(req.body);
    return engine.revise(uuid.parse((req.params as any).id), body.version, body.patch);
  });
  app.post('/api/v1/goals/:id/:command', async (req) => {
    const { id, command } = z
      .object({ id: uuid, command: z.enum(['start', 'pause', 'resume', 'cancel']) })
      .parse(req.params);
    return engine.control(id, command);
  });
  app.get('/api/v1/inbox', async () =>
    engine.db.q(
      "SELECT h.*,g.title AS goal_title FROM human_tasks h JOIN goals g ON g.id=h.goal_id WHERE h.status='pending' ORDER BY h.created_at",
    ),
  );
  app.post('/api/v1/human/:id/answer', async (req) =>
    engine.answer(uuid.parse((req.params as any).id), req.body),
  );
  app.post('/api/v1/actions/:id/reconcile', async (req) => {
    const b = z
      .object({ outcome: z.enum(['confirmed', 'not_applied']), note: z.string().min(1) })
      .parse(req.body);
    await engine.resolveAction(uuid.parse((req.params as any).id), b.outcome, b.note);
    return { ok: true };
  });
  app.post('/api/v1/goals/:id/simulator/:node', async (req) => {
    const p = req.params as any;
    await engine.inject(uuid.parse(p.id), p.node, req.body);
    return { ok: true };
  });
  app.post('/api/v1/goals/:id/events', async (req) => {
    const id = uuid.parse((req.params as any).id);
    const body = z
      .object({
        eventId: z.string().min(1).max(200),
        taskId: uuid.optional(),
        name: z.string().min(1).max(200),
        data: z.unknown().optional(),
      })
      .parse(req.body);
    return engine.db.tx(async (db) => {
      await db.q('SELECT id FROM goals WHERE id=$1 FOR UPDATE', [id]);
      const g = await engine.goal(id, db);
      const duplicate = await db.q(
        "SELECT id FROM events WHERE goal_id=$1 AND type='external.received' AND data->>'eventId'=$2",
        [id, body.eventId],
      );
      if (duplicate.length) return { duplicate: true };
      await event(db, id, 'external.received', body);
      const tasks = await db.q(
        "UPDATE tasks SET status='ready' WHERE goal_id=$1 AND status='waiting_event' AND ($2::uuid IS NULL OR id=$2) RETURNING id",
        [id, body.taskId || null],
      );
      if (g.status === 'active') for (const t of tasks) await enqueue(db, id, 'turn', t.id);
      return { accepted: true };
    });
  });
  app.post('/api/v1/notifications/:id/retry', async (req) => {
    await engine.db.q(
      "UPDATE outbox SET status='pending',attempts=0,due_at=now() WHERE id=$1 AND status='failed'",
      [uuid.parse((req.params as any).id)],
    );
    return { ok: true };
  });
  app.get('/api/v1/events', async (req, reply) => {
    const query = z
      .object({ after: z.coerce.number().int().min(0).default(0), goalId: uuid.optional() })
      .parse(req.query);
    let cursor = Math.max(query.after, Number(req.headers['last-event-id']) || 0);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    let busy = false;
    streams.add(reply.raw);
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const rows = await engine.db.q(
          'SELECT * FROM events WHERE id>$1 AND ($2::uuid IS NULL OR goal_id=$2) ORDER BY id LIMIT 200',
          [cursor, query.goalId || null],
        );
        for (const e of rows) {
          reply.raw.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
          cursor = Number(e.id);
        }
        if (!rows.length) reply.raw.write(': heartbeat\n\n');
      } catch {
        reply.raw.end();
      } finally {
        busy = false;
      }
    }, 700);
    reply.raw.on('close', () => {
      clearInterval(timer);
      streams.delete(reply.raw);
    });
  });
  app.post('/api/v1/mcp', async (req, reply) => {
    const server = new Server(
      { name: 'goalloop', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    const runId = (req as any).runId;
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: toolDefinitions.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.schema as any,
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      try {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                await callTool(engine, runId, r.params.name, r.params.arguments || {}),
              ),
            },
          ],
        };
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: String(e) }] };
      }
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  app.route({
    method: ['GET', 'DELETE'],
    url: '/api/v1/mcp',
    handler: async (_, reply) =>
      reply.code(405).send({ error: 'Stateless MCP supports POST only' }),
  });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/web/dist');
  if (existsSync(root)) {
    await app.register(staticFiles, { root, wildcard: false });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'Not found' })
        : reply.sendFile('index.html'),
    );
  }
  return app;
}
