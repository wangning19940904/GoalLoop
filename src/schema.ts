import { pgTable, uuid, text, jsonb, integer, timestamp, bigserial } from 'drizzle-orm/pg-core';
export const goals = pgTable('goals', {
  id: uuid('id').primaryKey(),
  title: text('title').notNull(),
  status: text('status').notNull(),
  version: integer('version').notNull(),
  spec: jsonb('spec').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull(),
  activated_at: timestamp('activated_at', { withTimezone: true }),
  deadline_at: timestamp('deadline_at', { withTimezone: true }),
  stable_since: timestamp('stable_since', { withTimezone: true }),
  report: jsonb('report').notNull(),
});
export const events = pgTable('events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  goalId: uuid('goal_id'),
  type: text('type').notNull(),
  data: jsonb('data').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
