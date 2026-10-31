import { createHash } from 'node:crypto';
import type { Finding, ScanReport, Comparison } from './types.js';

export function finding(input: Omit<Finding, 'id'>): Finding {
  return { ...input, id: createHash('sha256').update(JSON.stringify([input.category, input.rule, input.url])).digest('hex').slice(0, 16) };
}

export function compareReports(current: ScanReport, baseline: ScanReport): Comparison {
  if (baseline.schemaVersion !== 1 || !Array.isArray(baseline.findings) || !Array.isArray(baseline.pages)) throw new Error('Unsupported baseline report. Use a SiteCheck v1 JSON report.');
  if (new URL(current.url).origin !== new URL(baseline.url).origin) throw new Error('Baseline must be from the same website origin.');
  const previous = new Set(baseline.findings.map(item => item.id));
  const present = new Set(current.findings.map(item => item.id));
  const resolved: Finding[] = [], unverified: Finding[] = [];
  for (const old of baseline.findings) {
    if (present.has(old.id)) continue;
    const page = current.pages.find(p => p.url === old.url && !p.error);
    const checked = old.category === 'links' ? current.links.some(l => l.url === old.url && l.outcome === 'ok')
      : old.category === 'journey' ? current.journeys.some(j => `journey:${j.name}` === old.rule && j.status === 'passed')
      : old.category === 'metadata' ? Boolean(page && (old.rule !== 'duplicate-title' || baseline.pages.every(p => current.pages.some(c => c.url === p.url && !c.error))))
      : old.category === 'accessibility' ? Boolean(page && page.accessibility !== 'unavailable' && !page.accessibilityIncomplete?.includes(old.rule))
      : old.category === 'scan' && old.rule === 'page-unavailable' ? Boolean(page)
      : old.category === 'scan' && old.rule === 'axe-unavailable' ? Boolean(page && page.accessibility !== 'unavailable')
      : old.category === 'scan' && old.rule === 'screenshot-unavailable' ? Boolean(page?.screenshot)
      : false;
    (checked ? resolved : unverified).push(old);
  }
  return {
    baselineDate: baseline.startedAt,
    added: current.findings.filter(f => !previous.has(f.id)).map(f => f.id),
    persisting: current.findings.filter(f => previous.has(f.id)).map(f => f.id),
    resolved, unverified,
  };
}
