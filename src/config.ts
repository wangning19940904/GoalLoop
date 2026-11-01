import 'dotenv/config';
import path from 'node:path';
export const config = {
  databaseUrl: process.env.DATABASE_URL || 'postgresql://localhost/goalloop',
  port: Number(process.env.GOALLOOP_PORT || 12400),
  dataDir: path.resolve(process.env.GOALLOOP_DATA_DIR || '.data'),
  get baseUrl() {
    return process.env.GOALLOOP_BASE_URL || `http://127.0.0.1:${this.port}`;
  },
  leaseMs: Number(process.env.GOALLOOP_LEASE_MS || 30000),
  pollMs: Number(process.env.GOALLOOP_POLL_MS || 1000),
};
