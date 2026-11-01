import { createHmac } from 'node:crypto';
import { Store, event } from './db.js';
import { config } from './config.js';
export async function deliverNotifications(db: Store, send: typeof fetch = fetch) {
  if (!process.env.FEISHU_WEBHOOK) return;
  const job = await db.tx(async (tx) => {
    const [r] = await tx.q(
      "SELECT * FROM outbox WHERE (status='pending' AND due_at<=now()) OR (status='sending' AND lease_until<now()) ORDER BY due_at FOR UPDATE SKIP LOCKED LIMIT 1",
    );
    if (!r) return null;
    await tx.q(
      "UPDATE outbox SET status='sending',lease_until=now()+interval '30 seconds',attempts=attempts+1 WHERE id=$1",
      [r.id],
    );
    return { ...r, attempts: r.attempts + 1 };
  });
  if (!job) return;
  try {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sign = process.env.FEISHU_SECRET
      ? createHmac('sha256', `${timestamp}\n${process.env.FEISHU_SECRET}`)
          .update('')
          .digest('base64')
      : undefined;
    const response = await send(process.env.FEISHU_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp,
        sign,
        msg_type: 'text',
        content: {
          text: `GoalLoop · ${job.payload.title}\n${job.payload.summary}\n${config.baseUrl}/?goal=${job.goal_id}\n事项 ${job.event_key}`,
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const body: any = await response.json();
    if (!response.ok || !(body.code === 0 || body.StatusCode === 0))
      throw new Error(
        `Feishu rejected notification (${response.status}, ${body.code ?? body.StatusCode})`,
      );
    await db.q(
      "UPDATE outbox SET status='sent',sent_at=now(),lease_until=NULL,error=NULL WHERE id=$1",
      [job.id],
    );
  } catch (e) {
    await db.q(
      "UPDATE outbox SET status=$2,error=$3,lease_until=NULL,due_at=now()+($4::text||' seconds')::interval WHERE id=$1",
      [
        job.id,
        job.attempts >= 8 ? 'failed' : 'pending',
        String(e).replace(/https?:\/\/\S+/g, '[redacted-url]'),
        Math.min(3600, 2 ** job.attempts),
      ],
    );
    await event(db, job.goal_id, 'notification.failed', { id: job.id, attempts: job.attempts });
  }
}
