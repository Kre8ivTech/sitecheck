export type Severity = 'high' | 'medium' | 'low';
export type Category = 'accessibility' | 'links' | 'metadata' | 'journey' | 'scan';
export interface Finding {
  id: string;
  category: Category;
  severity: Severity;
  rule: string;
  url: string;
  title: string;
  detail: string;
  recommendation: string;
  evidence: string[];
  helpUrl?: string;
}
export interface PageResult {
  url: string;
  finalUrl?: string;
  status?: number;
  title?: string;
  description?: string;
  durationMs: number;
  screenshot?: string;
  accessibility: 'passed' | 'findings' | 'unavailable';
  accessibilityIncomplete?: string[];
  error?: string;
}
export interface LinkResult {
  url: string;
  sources: string[];
  status?: number;
  outcome: 'ok' | 'broken' | 'unverified';
  detail?: string;
}
export interface JourneyStep { path: string; expect: string }
export interface Journey { name: string; steps: JourneyStep[] }
export interface JourneyResult { name: string; status: 'passed' | 'failed'; stepsCompleted: number; totalSteps: number; detail?: string }
export interface ScanOptions {
  url: string;
  maxPages: number;
  maxLinks: number;
  timeout: number;
  output: string;
  allowPrivate: boolean;
  paths: string[];
  exclude: string[];
  journeys: Journey[];
  baseline?: string;
}
export interface Comparison {
  baselineDate: string;
  added: string[];
  persisting: string[];
  resolved: Finding[];
  unverified: Finding[];
}
export interface ScanReport {
  schemaVersion: 1;
  version: string;
  url: string;
  startedAt: string;
  durationMs: number;
  status: 'complete' | 'partial';
  scope: { maxPages: number; maxLinks: number; queuedPagesRemaining: number; linksNotChecked: number; robotsSkipped: string[]; excluded: string[] };
  pages: PageResult[];
  links: LinkResult[];
  journeys: JourneyResult[];
  findings: Finding[];
  comparison?: Comparison;
}
