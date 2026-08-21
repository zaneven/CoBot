# CoBot Docs

This directory holds the project documentation and the source of the public
GitHub Pages site.

| File | What it is |
|------|------------|
| [`commands.md`](./commands.md) | Every bot command, mirroring `BOT_COMMANDS` in `src/bot/commands.ts`. |
| [`development.md`](./development.md) | Dev guide: setup, running, testing, proxy, env vars, source layout. |
| [`markdown_rendering.md`](./markdown_rendering.md) | How streamed Markdown is rendered to Telegram — Rich/HTML fallback, `mdToTelegramHtml`, tool formatting, the `showTraceText` live process view. |
| [`landing.html`](./landing.html) | Source for the public landing page. `.github/workflows/deploy-pages.yml` copies it to `_site/index.html` on every push to `main`. |
| [`assets/`](./assets/) | Logos and `preview.html` used by the landing page; also referenced as the logo in the root [`README.md`](../README.md). |

For the project overview, quick start, and screenshots, see the
[root `README.md`](../README.md). For the full developer/agent guide, see
[`AGENTS.md`](../AGENTS.md).
