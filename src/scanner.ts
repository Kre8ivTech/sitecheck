import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { httpUrl } from './config.js';
import { finding, compareReports } from './findings.js';
import { networkGuard, safeGet } from './network.js';
import { renderReport } from './report.js';
import type { ScanOptions, ScanReport, Finding, PageResult } from './types.js';

const AGENT = 'Kre8ivSiteCheck/0.1 (+https://github.com/Kre8ivTech/sitecheck)';
// robots-parser's CommonJS export and ambient declarations disagree under NodeNext.
const robotsParser = createRequire(import.meta.url)('robots-parser') as (url: string, text: string) => { isAllowed(url: string, agent: string): boolean | undefined; getCrawlDelay(agent: string): number | undefined };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const skipPath = /\/(?:logout|log-out|signout|sign-out|delete|unsubscribe)(?:\/|$)/i;
const assetPath = /\.(?:pdf|zip|gz|jpe?g|png|gif|svg|webp|mp[34]|woff2?|css|js|xml|json|ico)$/i;

export async function scan(options: ScanOptions, progress: (text: string) => void = () => {}): Promise<ScanReport> {
  const started = Date.now();
  const baseline = options.baseline ? JSON.parse(await readFile(options.baseline, 'utf8')) as ScanReport : undefined;
  const origin = new URL(options.url).origin;
  const guard = networkGuard(options.allowPrivate);
  await guard(options.url);
  await mkdir(join(options.output, 'screenshots'), { recursive: true });
  const report: ScanReport = {
    schemaVersion: 1, version: '0.1.0', url: options.url, startedAt: new Date(started).toISOString(),
    durationMs: 0, status: 'complete',
    scope: { maxPages: options.maxPages, maxLinks: options.maxLinks, queuedPagesRemaining: 0, linksNotChecked: 0, robotsSkipped: [], excluded: [] },
    pages: [], links: [], journeys: [], findings: [],
  };
  const add = (input: Omit<Finding, 'id'>) => report.findings.push(finding(input));
  const problem = (url: string, rule: string, title: string, detail: string) => {
    report.status = 'partial';
    add({ url, rule, title, detail, category: 'scan', severity: 'medium', recommendation: 'Resolve the unavailable check and run the scan again.', evidence: [] });
  };
  let browser;
  try { browser = await chromium.launch(); }
  catch { throw new Error('Chromium could not start. Run npx playwright install chromium, then try again.'); }
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 }, userAgent: AGENT,
      serviceWorkers: 'block', acceptDownloads: false,
    });
    context.setDefaultTimeout(options.timeout);
    await context.route('**/*', async route => {
      const request = route.request();
      try {
        if (!['GET', 'HEAD'].includes(request.method())) return await route.abort('blockedbyclient');
        if (request.isNavigationRequest() && new URL(request.url()).origin !== origin) return await route.abort('blockedbyclient');
        await guard(request.url());
        await route.continue();
      } catch { await route.abort('blockedbyclient'); }
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    // Dialogs must not pause an unattended audit.
    page.on('dialog', dialog => void dialog.dismiss());
    // axe creates its own context page; close only popups opened by the target.
    page.on('popup', popup => void popup.close());
    let robots = robotsParser(`${origin}/robots.txt`, '');
    try {
      const response = await safeGet(context.request, `${origin}/robots.txt`, guard, options.timeout, origin);
      if (response.status() === 200) robots = robotsParser(`${origin}/robots.txt`, await response.text());
      else if (response.status() !== 404 && response.status() !== 410) throw new Error(`robots.txt returned HTTP ${response.status()}`);
      await response.dispose();
    } catch (error) {
      throw new Error(`Could not establish robots.txt access: ${message(error)}. Scan stopped without crawling pages.`);
    }
    const delay = Math.max(250, (robots.getCrawlDelay('Kre8ivSiteCheck') ?? 0) * 1000);
    if (!Number.isFinite(delay) || delay > 60000) throw new Error('robots.txt requests a crawl delay above 60 seconds. This bounded scanner will not crawl the site.');
    let lastVisit = Date.now();
    const throttle = async () => { await new Promise(resolve => setTimeout(resolve, Math.max(0, delay - (Date.now() - lastVisit)))); lastVisit = Date.now(); };
    const queue = [options.url, ...options.paths.map(path => httpUrl(path, options.url).href)];
    const seen = new Set<string>();
    const links = new Map<string, Set<string>>();
    const allowed = (url: string) => {
      const parsed = new URL(url);
      if (skipPath.test(parsed.pathname) || options.exclude.some(prefix => parsed.pathname.startsWith(prefix))) {
        if (!report.scope.excluded.includes(url)) report.scope.excluded.push(url);
        return false;
      }
      if (robots.isAllowed(url, 'Kre8ivSiteCheck') === false) {
        if (!report.scope.robotsSkipped.includes(url)) report.scope.robotsSkipped.push(url);
        return false;
      }
      return true;
    };
    while (queue.length && report.pages.length < options.maxPages) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);
      if (!allowed(url)) continue;
      progress(`Scanning ${report.pages.length + 1}/${options.maxPages}: ${url}`);
      const pageStart = Date.now();
      const result: PageResult = { url, durationMs: 0, accessibility: 'unavailable' };
      report.pages.push(result);
      try {
        await throttle();
        const response = await page.goto(url, { waitUntil: 'load', timeout: options.timeout });
        result.status = response?.status();
        result.finalUrl = page.url();
        if (!response || response.status() >= 400) throw new Error(`Page returned ${response ? `HTTP ${response.status()}` : 'no HTTP response'}.`);
        if (!(response.headers()['content-type'] ?? '').includes('text/html')) throw new Error('Page is not an HTML document.');
        const info = await page.evaluate(() => ({
          title: document.title.trim(),
          description: document.querySelector('meta[name="description" i]')?.getAttribute('content')?.trim() ?? '',
          h1: document.querySelectorAll('h1').length,
          links: Array.from(document.querySelectorAll('a[href]')).map(a => a.getAttribute('href') ?? ''),
        }));
        result.title = info.title;
        result.description = info.description;
        const meta = (rule: string, title: string, detail: string, recommendation: string, severity: 'medium' | 'low' = 'medium') => add({ category: 'metadata', severity, rule, url, title, detail, recommendation, evidence: [] });
        if (!info.title) meta('missing-title', 'Page title is missing', 'This page has no nonempty document title.', 'Add a unique, descriptive <title> for this page.');
        if (!info.description) meta('missing-description', 'Search description is missing', 'No nonempty meta description was found.', 'Write a description that explains this page in search results.', 'low');
        if (info.h1 === 0) meta('missing-h1', 'Main heading is missing', 'No h1 element was found.', 'Give the page a clear main heading.');
        for (const href of info.links) {
          let linked: URL;
          try { linked = httpUrl(href, page.url()); } catch { continue; }
          if (linked.origin !== origin || linked.search || !href || href.startsWith('#') || !allowed(linked.href)) continue;
          // Bound discovery memory independently from network checks.
          if (!links.has(linked.href) && links.size >= 1000) continue;
          if (!links.has(linked.href)) links.set(linked.href, new Set());
          links.get(linked.href)!.add(url);
          if (!assetPath.test(linked.pathname) && !seen.has(linked.href) && !queue.includes(linked.href)) queue.push(linked.href);
        }
        try {
          const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
          result.accessibility = axe.violations.length ? 'findings' : 'passed';
          for (const violation of axe.violations) add({
            category: 'accessibility', severity: ['critical', 'serious'].includes(violation.impact ?? '') ? 'high' : violation.impact === 'moderate' ? 'medium' : 'low',
            rule: violation.id, url, title: violation.help,
            detail: `${violation.nodes.length} affected element(s). ${violation.description}`,
            recommendation: violation.nodes[0]?.failureSummary ?? 'Review the affected elements and the linked rule guidance.',
            evidence: violation.nodes.slice(0, 5).map(node => `${node.target.join(' → ')}: ${node.html.slice(0, 500)}`),
            helpUrl: violation.helpUrl,
          });
          if (axe.incomplete.length) problem(url, 'manual-review', 'Some accessibility checks need manual review', `${axe.incomplete.length} rule(s) could not be decided automatically: ${axe.incomplete.map(r => r.id).join(', ')}.`);
        } catch (error) { problem(url, 'axe-unavailable', 'Accessibility check did not finish', message(error)); }
        try {
          const name = `page-${String(report.pages.length).padStart(2, '0')}.jpg`;
          await page.screenshot({ path: join(options.output, 'screenshots', name), type: 'jpeg', quality: 70, animations: 'disabled', timeout: options.timeout });
          result.screenshot = `screenshots/${name}`;
        } catch (error) { problem(url, 'screenshot-unavailable', 'Screenshot could not be captured', message(error)); }
      } catch (error) {
        result.error = message(error);
        problem(url, 'page-unavailable', 'Page could not be audited', result.error);
      }
      result.durationMs = Date.now() - pageStart;
    }
    report.scope.queuedPagesRemaining = queue.filter(url => !seen.has(url)).length;
    for (const result of report.pages) {
      if (!result.title || result.error) continue;
      const duplicates = report.pages.filter(other => !other.error && other.title === result.title && other.url !== result.url);
      if (duplicates.length) add({ category: 'metadata', severity: 'low', rule: 'duplicate-title', url: result.url, title: 'Page title is shared by other scanned pages', detail: result.title, recommendation: 'Use a distinct title that describes each page.', evidence: duplicates.map(p => p.url) });
    }
    const candidates = Array.from(links.entries());
    report.scope.linksNotChecked = Math.max(0, candidates.length - options.maxLinks);
    for (const [url, sources] of candidates.slice(0, options.maxLinks)) {
      progress(`Checking link: ${url}`);
      const checked = report.pages.find(p => p.url === url);
      let status = checked?.status;
      try {
        if (status === undefined) {
          await throttle();
          const response = await safeGet(context.request, url, guard, options.timeout, origin);
          status = response.status();
          await response.dispose();
        }
        const uncertain = status === 401 || status === 403 || status === 429 || (status >= 300 && status < 400);
        const outcome = uncertain ? 'unverified' : status >= 400 ? 'broken' : 'ok';
        report.links.push({ url, sources: [...sources], status, outcome, ...(uncertain ? { detail: 'Access, rate limiting, or redirect behavior prevented verification.' } : {}) });
        if (outcome === 'broken') add({ category: 'links', severity: 'high', rule: 'broken-link', url, title: `Link returns HTTP ${status}`, detail: `Found on ${sources.size} scanned page(s).`, recommendation: 'Correct the destination, restore the page, or remove the link.', evidence: [...sources] });
        if (uncertain) report.status = 'partial';
      } catch (error) {
        report.status = 'partial';
        report.links.push({ url, sources: [...sources], outcome: 'unverified', detail: message(error) });
      }
    }
    for (const journey of options.journeys) {
      progress(`Checking journey: ${journey.name}`);
      let completed = 0;
      try {
        for (const step of journey.steps) {
          const url = httpUrl(step.path, options.url).href;
          if (!allowed(url)) throw new Error('Journey destination is excluded or disallowed by robots.txt.');
          await throttle();
          const response = await page.goto(url, { waitUntil: 'load', timeout: options.timeout });
          if (!response || response.status() >= 400) throw new Error(`Journey page failed: ${url}`);
          await page.locator(step.expect).first().waitFor({ state: 'visible', timeout: options.timeout });
          completed++;
        }
        report.journeys.push({ name: journey.name, status: 'passed', stepsCompleted: completed, totalSteps: journey.steps.length });
      } catch (error) {
        const detail = `Step ${completed + 1}: ${message(error)}`;
        report.journeys.push({ name: journey.name, status: 'failed', stepsCompleted: completed, totalSteps: journey.steps.length, detail });
        add({ category: 'journey', severity: 'high', rule: `journey:${journey.name}`, url: options.url, title: `Journey failed: ${journey.name}`, detail, recommendation: 'Review the expected page and visible selector, then rerun the journey.', evidence: [] });
      }
    }
    if (!report.pages.length) problem(options.url, 'no-pages', 'No pages were audited', 'All seed pages were excluded or disallowed by robots.txt.');
    report.durationMs = Date.now() - started;
    if (baseline) report.comparison = compareReports(report, baseline);
    await writeFile(join(options.output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    const images: Record<string, string> = {};
    for (const item of report.pages) if (item.screenshot) images[item.screenshot] = (await readFile(join(options.output, item.screenshot))).toString('base64');
    await writeFile(join(options.output, 'report.html'), renderReport(report, images));
    return report;
  } finally { await browser.close(); }
}
