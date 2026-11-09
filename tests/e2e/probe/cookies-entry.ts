// Bundled by tests/e2e/cookies.spec.ts and evaluated inside the extension's service worker, so the
// real src/lib/cookies.ts runs against Chromium's cookie store. Never part of the extension build.
import * as cookies from '../../../src/lib/cookies';

Object.assign(globalThis, { __samCookies: cookies });
