import { fixture } from '../test/fixture.js';
import { optionsFrom } from '../src/config.js';
import { scan } from '../src/scanner.js';

const site = await fixture();
try {
  const options = await optionsFrom({ url: site.url, output: 'reports/demo', maxPages: 3, allowPrivate: true,
    journeys: [{ name: 'Find the contact form', steps: [{ path: '/', expect: 'nav a[href="/contact"]' }, { path: '/contact', expect: 'form input[type="email"]' }] }],
  });
  const report = await scan(options, console.log);
  console.log(`\nDemo generated: ${options.output}/report.html (${report.findings.length} findings)`);
  site.fix();
  await scan({ ...options, output: 'reports/demo-after', baseline: `${options.output}/report.json` });
  console.log('Comparison generated: reports/demo-after/report.html');
} finally { await site.close(); }
