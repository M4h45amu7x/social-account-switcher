# Popup mockup reference

`popup.html` is a self-contained visual reference with fictional accounts. Open it in a browser; its controls select states, language and theme. Its example password is `orange-cat-2026`. It has no extension API or live website login.

Production popup E2E compares rendered states directly with this HTML in `tests/e2e/popup-states.spec.ts`. Stored screenshots are not test inputs. The current small documentation captures are in `../docs/images/` and are generated with `bun run screenshots`.

## Optional reference runner

After the repository's frozen dependency install and Playwright browser installation:

```bash
node mockup/e2e/popup.e2e.mjs
```

The runner checks states, flows, language, themes, layout, contrast and motion. It writes ignored screenshots under `shots/` and an ignored `e2e/e2e.log`; generated run evidence is not committed. The production gates remain `bun run check` and `bun run e2e` from the repository root.

| Variable | Purpose |
|---|---|
| `PLAYWRIGHT_MODULE` | Path to a Playwright package when normal module resolution is unavailable |
| `CHROMIUM_PATH` | Optional Chromium executable override |
| `POPUP_HTML` | Optional alternate HTML reference |
| `E2E_SHOTS=0` | Disable screenshot output |
| `E2E_LOG` | Alternate log path |
| `E2E_TIMEOUT` | Optional per-action timeout in milliseconds |

Exit 0 means the reference checks passed; exit 1 means a check failed; exit 2 means Playwright could not be loaded. Browser contexts are closed by the runner. See [design](../docs/design.md) and [known issues](../docs/known-issues.md) for implementation and live-account limits.
