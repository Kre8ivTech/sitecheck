import { fixture } from '../test/fixture.js';
import { optionsFrom } from '../src/config.js';
import { scan } from '../src/scanner.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

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
  if (process.argv.includes('--site')) {
    await mkdir('docs', { recursive: true });
    for (const [input, output, label, other] of [
      ['reports/demo/report.html', 'docs/index.html', 'View the follow-up scan', 'after.html'],
      ['reports/demo-after/report.html', 'docs/after.html', 'View the original scan', 'index.html'],
    ]) {
      const html = (await readFile(input!, 'utf8'))
        .replace(/href="http:\/\/127\.0\.0\.1:[0-9]+[^\"]*"/g, 'href="#scope"')
        .replace('<body>', `<body><div style="padding:12px 4vw;background:#fff3cd;color:#493900;font-size:13px" role="note"><strong>Fictional sample report.</strong> This demo audits a temporary local website with deliberate problems. Target links are disabled. <a href="${other}">${label} →</a> · <a href="https://github.com/Kre8ivTech/sitecheck">Get SiteCheck</a></div>`);
      await writeFile(output!, html);
    }
    await writeFile('docs/.nojekyll', '');
    console.log('Static demo website generated in docs/');
  }
} finally { await site.close(); }
