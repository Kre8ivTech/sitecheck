import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { renderReport } from '../src/report.js';
import { finding } from '../src/findings.js';
import type { ScanReport } from '../src/types.js';

test('standalone report is accessible, responsive, keyboard-operable, and filters/export work', { timeout: 60000 }, async () => {
  const report: ScanReport = {
    schemaVersion: 1, version: '0.1.0', url: 'https://example.com/a-very-long-path-that-should-wrap-without-breaking-the-layout/',
    startedAt: '2026-10-31T12:00:00Z', durationMs: 1000, status: 'partial',
    scope: { maxPages: 5, maxLinks: 50, queuedPagesRemaining: 2, linksNotChecked: 3, robotsSkipped: [], excluded: [] },
    pages: [{ url: 'https://example.com/', title: 'Example', status: 200, durationMs: 1, accessibility: 'findings' }],
    links: [], journeys: [], findings: [
      finding({ category: 'accessibility', severity: 'high', rule: 'image-alt', url: 'https://example.com/', title: 'Image alternative text is missing', detail: 'One affected element.', recommendation: 'Describe the image.', evidence: ['<img src="example.jpg">'] }),
      finding({ category: 'metadata', severity: 'low', rule: 'missing-description', url: 'https://example.com/', title: 'Search description is missing', detail: 'No description.', recommendation: 'Add a description.', evidence: [] }),
    ],
  };
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(renderReport(report));
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `No document overflow at ${width}px`);
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      assert.deepEqual(results.violations.map(v => v.id), [], `Report accessibility at ${width}px`);
    }
    await page.keyboard.press('Tab');
    assert.equal(await page.locator(':focus').innerText(), 'Skip to report');
    await page.getByLabel('PRIORITY', { exact: true }).selectOption('high');
    assert.equal(await page.locator('.finding:visible').count(), 1);
    assert.equal(await page.getByRole('status').innerText(), '1 finding');
    await page.getByLabel('CHECK TYPE', { exact: true }).selectOption('metadata');
    assert.equal(await page.locator('.finding:visible').count(), 0);
    assert.equal(await page.locator('#no-findings').isVisible(), true);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export JSON' }).click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'sitecheck-report.json');
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), report);
    const clean = { ...report, findings: [], pages: [], status: 'complete' as const };
    await page.setContent(renderReport(clean));
    assert.equal(await page.locator('#no-findings').isVisible(), true);
    assert.ok((await page.locator('.status').innerText()).includes('Scan complete'));
  } finally { await browser.close(); }
});
