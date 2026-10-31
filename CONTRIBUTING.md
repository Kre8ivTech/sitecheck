# Contributing to SiteCheck

Start with an issue for a substantial feature or behavior change. Small fixes can go directly to a pull request.

1. Install Node.js 22+, run `npm ci`, and run `npx playwright install chromium`.
2. Make a focused change. Keep dependencies justified and report claims specific.
3. Add meaningful tests for changed scanner, configuration, comparison, or report behavior. Use the local fixture rather than third-party websites.
4. Run `npm run check`. For report changes, review desktop and mobile output and keyboard controls.
5. Explain what changed, why, and how you verified it in your pull request.

Keep report examples fictional. Do not commit client data, credentials, private URLs, or real customer screenshots. Contributions are provided under the project's MIT license.

Be respectful and specific. Critique the work, not the person. Harassment and disclosure of other people's private information are not accepted. Maintainers may remove inappropriate content or restrict participation. Contact [info@kre8ivtech.com](mailto:info@kre8ivtech.com) for conduct concerns.
