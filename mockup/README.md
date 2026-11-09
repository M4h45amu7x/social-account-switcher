# mockup: popup of the account switcher (v2)

- `popup.html` opens in any browser (double-click or drag it into Chrome). Everything is fake data. It calls no extension API and uses no network.
  The "Mockup controls" panel jumps to any state and switches theme and language. Master password in the mockup: `orange-cat-2026`.
- Language: English (default) or Thai, from Settings (gear icon) or the panel. `Auto` follows the browser language.
  The strings are one table per language in the script (`I18N.en`, `I18N.th`). In the extension they become `public/_locales/{en,th}/messages.json`.
- Theme: System, Light or Dark. Switching runs a Circle Reveal from the click point. The saved theme is applied before the first paint.
- Motion: six View Transitions animations (theme reveal, tab pill and panel slide, animated list, status morph, expand and collapse, toast). All durations come from `--dur-*` tokens. `prefers-reduced-motion: reduce` turns every animation off, and a browser without View Transitions changes the DOM at once. Details: `docs/design.md` section 12.
- `shots/<lang>-<theme>-<state>.png`: every state (15) in both languages (`en`, `th`) and both themes (`light`, `dark`).
- `media/*.gif`: `theme-switch` (Circle Reveal), `switch-account` (tabs, spinner, success, toast), `delete-account` (confirm, fade out, glide, pop in). Recorded slowed down (`--motion-scale`).
- `e2e/popup.e2e.mjs`: Playwright run over every state and flow in both languages, plus layout overflow, contrast, reduced motion and no-View-Transitions checks. It writes `shots/` and `e2e/e2e.log`.
- `e2e/e2e.before.log`: the same script run against the v1 mockup (before this change), kept as the failing run.
- `e2e/record.mjs`: records the GIFs (needs `ffmpeg`).

## Run the e2e

Needs Node and the `playwright` package (not installed in this repo, which only holds the design; the real project uses `@playwright/test`, see docs/design.md section 9).

```bash
# 1) playwright is already resolvable from here
node mockup/e2e/popup.e2e.mjs

# 2) point at a playwright package installed elsewhere
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node mockup/e2e/popup.e2e.mjs

# 3) the browser that playwright wants is not installed: point at any chrome/chromium
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
CHROMIUM_PATH=~/.cache/ms-playwright/chromium-<rev>/chrome-linux64/chrome \
node mockup/e2e/popup.e2e.mjs
```

| Variable | Set it when | Value |
|---|---|---|
| `PLAYWRIGHT_MODULE` | `require('playwright')` is not found | path of the `playwright` package folder |
| `CHROMIUM_PATH` | the browser build that playwright needs is not installed | a chrome/chromium executable |
| `POPUP_HTML` | you want to test another file (for example the v1 mockup) | path of an html file |
| `E2E_SHOTS=0` | you do not want `shots/` rewritten | `0` |
| `E2E_LOG` | you want the log somewhere else | file path |
| `E2E_TIMEOUT` | the default 6000 ms per action is too long or too short | milliseconds |

Result: exit 0 = every check passed, exit 1 = at least one failed (see `FAIL` in the log), exit 2 = playwright not found.
