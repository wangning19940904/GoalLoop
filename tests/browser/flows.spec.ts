import { test, expect } from '@playwright/test';
test('workspace goal goes from creation through independent verification', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '创建目标', exact: true }).click();
  const title = `浏览器验收 · 代码修复 ${Date.now()}`;
  await page.getByLabel('目标名称').fill(title);
  await page.getByLabel('想要达到什么结果？').fill('修复加法函数并通过独立测试');
  await page.getByLabel('场景能力包').selectOption('workspace');
  await page.getByLabel('快速演示：每秒采样，稳定 2 秒后验收').check();
  await page.getByRole('button', { name: '创建目标', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.getByRole('button', { name: '启动目标' }).click();
  await expect(page.locator('.badge.succeeded')).toBeVisible({ timeout: 40000 });
  await page.getByRole('button', { name: '验收证据', exact: true }).click();
  await expect(page.getByText('4 项独立函数检查全部通过').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/workspace-verified.png', fullPage: true });
});
test('cluster goal asks for approval and external assistance, then resumes after page reload', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '创建目标', exact: true }).click();
  await page.getByLabel('目标名称').fill(`浏览器验收 · 集群治理 ${Date.now()}`);
  await page.getByLabel('想要达到什么结果？').fill('全部节点健康分达到 80，生产重启需要审批');
  await page.getByLabel('快速演示：每秒采样，稳定 2 秒后验收').check();
  await page.getByRole('button', { name: '创建目标', exact: true }).last().click();
  await page.getByRole('button', { name: '启动目标' }).click();
  await expect(page.getByRole('button', { name: '批准', exact: true })).toBeVisible({
    timeout: 30000,
  });
  await page.screenshot({ path: 'test-results/cluster-awaiting-human.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: '批准', exact: true }).click();
  await page.getByRole('button', { name: '模拟完成硬件更换' }).click();
  await page
    .getByPlaceholder('回复结论、证据或处理结果')
    .fill('已完成模拟硬件更换，请核实当前观测');
  await page.getByRole('button', { name: '提交回复' }).click();
  await expect(page.locator('.badge.succeeded')).toBeVisible({ timeout: 40000 });
  await page.screenshot({ path: 'test-results/cluster-verified.png', fullPage: true });
});
test('small viewport remains navigable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '创建目标', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
});
