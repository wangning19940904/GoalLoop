import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

test('hard restart preserves human decisions and an already-open browser can continue', async ({
  page,
}) => {
  const url = new URL(process.env.TEST_DATABASE_URL || 'postgresql://localhost/goalloop_test');
  const admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  try {
    if (
      !(await admin.query("SELECT 1 FROM pg_database WHERE datname='goalloop_recovery_test'"))
        .rowCount
    )
      await admin.query('CREATE DATABASE goalloop_recovery_test');
  } finally {
    await admin.end();
  }
  url.pathname = '/goalloop_recovery_test';
  const dir = await mkdtemp(path.join(os.tmpdir(), 'goalloop-restart-'));
  let child: ChildProcess | undefined;
  const errors: string[] = [];
  const base = 'http://127.0.0.1:12411';
  const start = async () => {
    child = spawn(process.execPath, ['dist/cli.js', 'serve', '--worker'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: url.href,
        GOALLOOP_PORT: '12411',
        GOALLOOP_BASE_URL: base,
        GOALLOOP_DATA_DIR: dir,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (d) => errors.push(String(d)));
    await expect
      .poll(
        async () => {
          if (child?.exitCode !== null) throw new Error(errors.join('\n'));
          return fetch(base + '/api/v1/health')
            .then((r) => r.ok)
            .catch(() => false);
        },
        { timeout: 20000 },
      )
      .toBe(true);
  };
  const stop = async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  };
  try {
    await start();
    await page.goto(base);
    await page.getByRole('button', { name: '创建目标', exact: true }).click();
    await page.getByLabel('目标名称').fill('重启恢复验证');
    await page.getByLabel('想要达到什么结果？').fill('治理隔离模拟集群');
    await page.getByLabel('快速演示：每秒采样，稳定 2 秒后验收').check();
    await page.getByRole('button', { name: '创建目标', exact: true }).last().click();
    await page.getByRole('button', { name: '启动目标' }).click();
    await expect(page.getByRole('button', { name: '批准', exact: true })).toBeVisible({
      timeout: 20000,
    });
    await stop();
    await start();
    // Keep the same page and its now-stale browser control token; the client must recover it.
    await page.getByRole('button', { name: '批准', exact: true }).click();
    await page.getByRole('button', { name: '模拟完成硬件更换' }).click();
    await page.getByPlaceholder('回复结论、证据或处理结果').fill('重启后确认硬件修复');
    await page.getByRole('button', { name: '提交回复' }).click();
    await expect(page.locator('.badge.succeeded')).toBeVisible({ timeout: 40000 });
    await page.screenshot({ path: 'test-results/restart-verified.png', fullPage: true });
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
