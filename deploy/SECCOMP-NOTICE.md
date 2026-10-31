# Chromium seccomp profile

`chromium-seccomp.json` is adapted from Moby profiles' default seccomp policy at commit `4b8214fc4971e06172938a1f1554ccff6647ee80`, retrieved October 31, 2026.

Source: https://github.com/moby/profiles/blob/4b8214fc4971e06172938a1f1554ccff6647ee80/seccomp/default.json

The upstream Apache 2.0 license is retained in `SECCOMP-LICENSE`.

The final syscall entry allows `clone`, `setns`, `unshare`, and `chroot` to support Chromium's user-namespace sandbox without adding host capabilities. Namespace creation follows the Playwright crawling guidance at https://playwright.dev/docs/docker. `chroot` is needed within the new namespace when host capabilities are dropped.
