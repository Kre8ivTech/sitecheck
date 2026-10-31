# Web interface deployment

SiteCheck's web app needs a running Node service and Chromium. GitHub Pages continues to serve the static sample reports; it cannot run submitted scans.

## Local development

```sh
npm ci
npx playwright install chromium
npm run web
```

Open http://localhost:3100. The local service starts a public-address egress proxy on a loopback port. Local mode is a development convenience; deploy the isolated container layout for public access.

## Docker Compose

```sh
PUBLIC_ORIGIN=https://sitecheck.example.com TRUST_PROXY_HOPS=1 docker compose up -d --build
```

Terminate HTTPS at your existing reverse proxy and forward to `127.0.0.1:3100`. The app never trusts the Host header to derive its origin. Set PUBLIC_ORIGIN to the exact public origin; browser POST/DELETE Origin must match it.

The edge service appends its peer address to X-Forwarded-For. TRUST_PROXY_HOPS=1 is appropriate when it is the only proxy. Add one for each additional trusted proxy that appends the real peer address; never count arbitrary client-supplied entries. For the cPanel Apache → container edge → app deployment, use 2. Keep the edge port bound to loopback, and configure upstream proxies to preserve the actual client address.

## Boundaries and limits

- One running scan and three queued scans; six accepted scans per client IP per hour. Capacity is capped at 100 retained jobs.
- Each scan has a two-minute process deadline, three pages, twenty internal links, and ten-second operation timeouts. A separate worker process is terminated with its child processes on cancellation/deadline.
- Session cookies are opaque, HttpOnly, SameSite=Strict, and Secure for HTTPS origins. Job status and report routes verify session ownership. Job IDs alone do not grant access.
- Reports expire after one hour. Expired files are cleaned up every thirty seconds. Pending jobs become failed after a service restart; finished reports retain their original ownership and expiry.
- Generated reports are served in an opaque-origin sandbox; report text is escaped by the existing renderer. JSON and HTML downloads require the same session. Neither reports nor status endpoints are cacheable or indexable.
- Browser workers have no direct external network route. Only the separate egress proxy has outbound access. It validates every destination's resolved addresses, rejects private/reserved addresses and non-web ports, and connects to the exact validated address. HTTPS uses CONNECT to port 443; HTTP proxying only accepts GET/HEAD. Proxy tunnels have lifetime, idle, and byte limits.
- Chromium runs as a non-root user with its namespace sandbox enabled. The seccomp profile is adapted from Moby's default profile, adding namespace creation and chroot inside that namespace, following Playwright's crawling guidance. Host capabilities remain dropped; the app is read-only except temporary space and report data.
- Container CPU, memory, process counts, temporary space, and log rotation are bounded. The scan worker inherits an allowlist of environment variables, not hosting credentials.

The report data directory should be dedicated to SiteCheck. Do not mount cloud credentials, the container engine socket, customer application directories, or host secrets. The app is intentionally a single-instance queue; deploying multiple independent replicas would require a shared queue and coordinated rate limits. In-process rate limits reset on restart. Use an edge challenge or additional rate policy if public abuse warrants it.

Self-hosters remain responsible for OS/browser updates, disk monitoring, TLS, upstream proxy configuration, and network isolation. A DNS preflight by itself is not the network boundary; the supplied isolated network and pinned egress connections are part of the deployment.

## Sources

- [Playwright Docker crawling guidance](https://playwright.dev/docs/docker)
- [Moby default seccomp profile](https://github.com/moby/profiles/blob/main/seccomp/default.json)
- [Docker internal networks](https://docs.docker.com/reference/compose-file/networks/#internal)

## Maintenance

Use `/health` for liveness. Keep reports out of source control and general web document roots. Operators can inspect a failed job's `worker-error.log` in the private data directory; it is never served by the web API and expires with the job. Back up source/configuration as needed; the intentionally ephemeral reports do not require long-term backups.

Deploy an exact tested Git revision, preserve the previous image/configuration until verification completes, and verify a real scan, a report download, cross-session denial, private-address refusal, TLS, and restart persistence before announcing a public release.
