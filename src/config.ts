import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Journey, ScanOptions } from './types.js';

export function httpUrl(value: string, base?: string): URL {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS URL without embedded credentials.');
  url.hash = '';
  return url;
}

export function boundedNumber(value: unknown, name: string, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  return number;
}

export async function optionsFrom(input: Record<string, unknown>): Promise<ScanOptions> {
  let config: Record<string, unknown> = {};
  if (input.config) {
    const parsed: unknown = JSON.parse(await readFile(String(input.config), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Config must be a JSON object.');
    config = parsed as Record<string, unknown>;
  }
  const values = { ...config, ...input };
  if (typeof values.url !== 'string') throw new Error('Provide a website URL or set url in your config.');
  const url = httpUrl(values.url).href;
  const strings = (value: unknown, name: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error(`${name} must be an array of strings.`);
    return value as string[];
  };
  const paths = strings(values.paths, 'paths');
  if (paths.length > 25) throw new Error('Provide at most 25 seed paths.');
  for (const path of paths) if (httpUrl(path, url).origin !== new URL(url).origin) throw new Error('Seed paths must stay on the starting origin.');
  const journeys = values.journeys ?? [];
  if (!Array.isArray(journeys) || journeys.length > 5) throw new Error('journeys must be an array with at most five entries.');
  for (const journey of journeys) {
    if (!journey || typeof journey.name !== 'string' || !journey.name.trim() || !Array.isArray(journey.steps) || !journey.steps.length || journey.steps.length > 10) throw new Error('Each journey needs a name and 1–10 steps.');
    for (const step of journey.steps) {
      if (!step || typeof step.path !== 'string' || typeof step.expect !== 'string' || !step.expect.trim()) throw new Error('Each journey step needs path and expect (a CSS selector).');
      if (httpUrl(step.path, url).origin !== new URL(url).origin) throw new Error('Journey steps must stay on the starting origin.');
    }
  }
  if (values.allowPrivate !== undefined && typeof values.allowPrivate !== 'boolean') throw new Error('allowPrivate must be true or false.');
  return {
    url, maxPages: boundedNumber(values.maxPages ?? 5, 'maxPages', 1, 25),
    maxLinks: boundedNumber(values.maxLinks ?? 50, 'maxLinks', 1, 200),
    timeout: boundedNumber(values.timeout ?? 15000, 'timeout', 1000, 60000),
    output: resolve(String(values.output ?? 'reports/latest')),
    allowPrivate: values.allowPrivate === true,
    paths, exclude: strings(values.exclude, 'exclude'), journeys: journeys as Journey[],
    baseline: values.baseline ? resolve(String(values.baseline)) : undefined,
  };
}
