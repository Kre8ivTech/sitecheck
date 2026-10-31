#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { optionsFrom } from './config.js';
import { scan } from './scanner.js';

const HELP = `SiteCheck by Kre8ivTech · v0.2.0

Usage: sitecheck <url> [options]

  --config <file>        JSON configuration (paths, exclusions, journeys)
  --output <directory>   Report destination (default: reports/latest)
  --max-pages <number>   Pages to audit, 1–25 (default: 5)
  --max-links <number>   Internal links to check, 1–200 (default: 50)
  --timeout <ms>         Per-operation timeout, 1000–60000 (default: 15000)
  --baseline <file>      Compare against a previous report.json
  --allow-private        Allow trusted localhost/private-network targets
  --fail-on <level>      Exit 1 on high, medium, low, or none (default: high)
  --help                 Show this help
  --version              Show version

Reports: report.html (self-contained), report.json, screenshots/
Exit codes: 0 threshold passed; 1 findings reached threshold; 2 error or partial scan.
Only scan websites you own or have permission to check.
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, output: { type: 'string' },
    'max-pages': { type: 'string' }, 'max-links': { type: 'string' }, timeout: { type: 'string' },
    baseline: { type: 'string' }, 'allow-private': { type: 'boolean' }, 'fail-on': { type: 'string', default: 'high' },
    help: { type: 'boolean' }, version: { type: 'boolean' },
  } });
  if (values.help) { console.log(HELP); return; }
  if (values.version) { console.log('0.2.0'); return; }
  if (positionals.length > 1) throw new Error('Provide one starting URL. Use config.paths for additional pages.');
  if (!['high', 'medium', 'low', 'none'].includes(values['fail-on']!)) throw new Error('--fail-on must be high, medium, low, or none.');
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) if (value !== undefined) input[key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  if (positionals[0]) input.url = positionals[0];
  const options = await optionsFrom(input);
  console.log(`\nSiteCheck · ${options.url}\n`);
  const report = await scan(options, text => console.log(`  ${text}`));
  const counts = ['high', 'medium', 'low'].map(level => `${report.findings.filter(f => f.severity === level).length} ${level}`).join(' · ');
  console.log(`\n${report.pages.length} pages · ${report.links.length} links · ${counts}`);
  console.log(`${report.status === 'partial' ? 'Partial scan' : 'Scan complete'}. Report: ${options.output}/report.html\n`);
  const severity = { high: 3, medium: 2, low: 1, none: 4 };
  const threshold = severity[values['fail-on'] as keyof typeof severity];
  process.exitCode = report.status === 'partial' ? 2 : report.findings.some(f => severity[f.severity] >= threshold) ? 1 : 0;
}

main().catch(error => { console.error(`SiteCheck: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; });
