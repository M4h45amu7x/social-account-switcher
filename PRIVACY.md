# Privacy Policy

_Last updated: 2026-11-10_

Social Account Switcher saves sessions so you can switch between your own Facebook, Instagram and YouTube accounts. You sign in on each website yourself; the extension does not save website passwords or fill login forms.

TikTok support is experimental, disabled by default and absent from the popup. The owner supplied cookie names only; cookie roles and the viewer schema remain unverified against the live website. If enabled, the backend snapshots all cookies within TikTok's domain boundary except the configured preserved names: `ttwid`, `msToken`, `s_v_web_id`, `tt_chain_token`, `odin_tt`, `tt_ticket_guard_has_set_public_key`, `security_verification_ticket`, `x-web-secsdk-uid` and `gd_random`. All copies of those names stay untouched. The encrypted snapshot includes unknown cookies, `multi_sids`, CSRF state, preferences, routing and SDK state as well as session credentials. Cookie API access uses HTTPS and retains original cookie attributes, including a missing Secure flag. It does not read page-storage keys associated with ticket guard. This policy has only been tested with synthetic fixtures; live switching compatibility is unconfirmed.

## What the extension stores

| Data | Where | Purpose and protection |
|---|---|---|
| Account labels and initials, internal IDs, platform, Facebook/Instagram user IDs and experimental TikTok viewer IDs, status, active-account choices, and creation, last-use and session-capture times | `chrome.storage.local`, under `store` | Display and manage the account list. These fields are not encrypted. |
| Optional display name, handle, email, avatar data URL and automatic/custom label choice | The same local store, without encryption | Identify saved accounts without decrypting session cookies. Names/handles are limited to 80 Unicode code points, email to 254; avatars are PNG/JPEG/WebP, at most 64 by 64 pixels and 32 KiB decoded. The locked popup still shows the lock screen. |
| YouTube account index (`authuser`) and optional channel ID (`pageid`) | The same local store, without encryption | Build YouTube's multi-account sign-in URL and verify the selected account. No Google or YouTube cookies are saved by the extension. |
| Facebook, Instagram and experimental TikTok saved session cookies, including values and cookie attributes | An encrypted vault in the local store | Restore a saved session. New vaults use PBKDF2-SHA-256 with 600,000 iterations and a random 16-byte salt to derive an AES-GCM-256 key. Vault writes use a fresh 12-byte IV. The salt, iteration count, IV and encrypted password-check value are stored with the ciphertext. |
| Theme and language preferences; malformed or duplicate account records retained in `quarantine` | The local store, without encryption | Keep preferences and preserve records that fail validation rather than silently discarding them. |
| A copy of the theme preference | The popup's `localStorage`, under `theme` | Paint the saved theme before the asynchronous store is read. It contains no session or account data. |
| The platform tab you last picked in the popup (`facebook`, `instagram` or `youtube`) | The popup's `localStorage`, under `platform` | Open the popup on that tab when the page you are on is not one of the three sites. It holds no address, account or session data. |
| The unlocked raw encryption key, encoded as base64 | `chrome.storage.session`, under `vaultKey` | Keep the vault unlocked across service worker restarts. Base64 is not encryption. Access is restricted to trusted extension contexts. A non-extractable working key is cached in worker memory. |
| Per-platform switch journals: platform, source/target IDs, expected source viewer ID for TikTok, start time and an encrypted backup of the previous cookies | `chrome.storage.session`, under `journal.facebook`, `journal.instagram` or `journal.tiktok` | Attempt rollback after an interrupted switch. Cookie backups are encrypted with the vault key; journal metadata is not encrypted. |
| Wrong-unlock attempt count and last-attempt time | `chrome.storage.session`, under `unlockFailures` | Delay further unlock attempts after repeated wrong passwords. |

The master password is used to derive the key and is not saved in extension storage. Password inputs and decrypted cookies are used in popup and worker memory during operations. Account metadata and an unlocked key are not protected from someone who can inspect your running browser or extension context.

### The page you are on

When the popup opens, it asks Chrome for the address of the active tab in the current window. The host permissions below let Chrome expose addresses for Facebook, Instagram and YouTube, and reserve HTTPS TikTok access for the disabled experimental backend. For pages outside these permissions the extension gets no address or title. The popup recognizes only the first three platforms; a TikTok page follows the same fallback as other unrecognized pages. The popup uses the address in memory to choose which platform tab to show. On a supported site it also asks the service worker which saved account is logged in there, using the same local read as adding an account. The address is not stored, logged or sent anywhere, and no new permission is requested for this.

### Profile details from the open page

On Add and Update session, and during an account probe, the extension can read the signed-in account's display name, handle, email if already present, and avatar from the page in the captured active tab of the current window. It uses existing page JSON/configuration or narrowly selected profile UI. It does not open menus, click, navigate, request an API or read passwords, messages or unrelated page content. Metadata is discarded if its identity does not match the session probe and subsequent identity confirmation, the tab navigates or reloads during the read, or the source is unavailable. Optional profile reading has a one-second deadline; expiry discards metadata and lets the session save continue. A rendered YouTube account header is ignored unless it independently identifies the same account and channel coordinates. YouTube matching uses its account index and optional channel ID, not a stable Google user ID. TikTok's profile reader is synthetic and remains behind the disabled backend.

An avatar is copied only from an embedded raster data URL or pixels of an image the page already loaded. A detached canvas can resize those pixels without fetching the image again; if canvas access is blocked, the popup falls back to initials and the platform colour. The popup never loads platform CDN avatars. Profile strings are bounded and displayed as text, and image data is checked for MIME type, magic bytes, dimensions and byte size. Missing or invalid profile details do not prevent saving a session. A manually chosen account label is never overwritten on refresh; automatic labels may follow the latest matched display name. Profiles read for a probe remain in memory until the popup closes unless saved by Add/Update. See [profile sources and verification limits](docs/profile-sources.md).

### Retention and locking

The local store persists across browser restarts until you remove entries, wipe it or uninstall the extension. Invalid records in `quarantine` remain until the store is wiped; they are not shown as normal accounts.

Chrome holds `storage.session` in memory and clears it when the browser restarts or the extension is disabled, reloaded or updated. Stopping only the service worker does not clear it. See the [Chrome storage documentation](https://developer.chrome.com/docs/extensions/reference/api/storage#storage_areas).

**Lock now** removes the unlocked key and its worker cache. It does not delete the saved vault, account metadata, unlock-attempt record or an outstanding encrypted journal. Journal recovery is attempted at worker startup and after unlocking; recovery can remain pending or fail. It is not a backup that survives a browser restart.

Use a strong, unique master password. Someone who copies the encrypted vault can guess passwords offline. The in-extension delay after wrong attempts does not prevent offline guessing, and there is no password recovery or guaranteed secure erasure of browser files or backups.

## Permissions and what each one is for

| Permission | Used for |
|---|---|
| `cookies` | Read, remove and restore Facebook, Instagram and experimental TikTok session cookies when adding, updating, switching or recovering a session. The host permissions bound the API's domain access. |
| `storage` | Keep the local store and in-memory key, journals and unlock-attempt record described above. The extension does not use `chrome.storage.sync`. |
| `scripting` | Read YouTube sign-in coordinates and the optional matched profile fields described above from an open supported page in its main world. The disabled TikTok backend also reads viewer ID or signed-out, checkpoint or unknown state from a synthetic fixture. These readers make no network call. |
| `*://*.facebook.com/*`, `*://*.instagram.com/*` | Read matched profile details from the captured tab, access those sites' cookies, identify tabs to reload or check after a switch, and open the popup on the platform of the page you are on. |
| `https://*.tiktok.com/*` | Reserve cookie access and main-world viewer reading for the experimental TikTok backend. It is disabled by default and hidden from the popup. |
| `*://*.youtube.com/*` | Read sign-in coordinates and optional matched profile details, identify, navigate and reload YouTube tabs, and open the popup on YouTube when you are on it. |

No Google-domain host permission, all-sites permission, browsing-history permission or network-interception permission is requested. Incognito use is disabled.

## Network use and sharing

The extension has no server, analytics, telemetry, crash reporting or advertising integration. It does not upload saved sessions or account lists to an extension service, sell them, or sync them between devices. Its executable code and UI assets are included in the installed package.

Switching still uses the websites. Reloaded pages make their normal requests with the browser's current cookies. For YouTube, the extension navigates to a `youtube.com/signin` URL containing the saved account index, optional channel ID and a return path. Those URL parameters go to YouTube through normal browser navigation. The extension does not replace Google cookies or make a separate data-upload request. The websites' own data practices apply to their pages.

## Deleting your data

- **One account:** choose its delete button in the popup and confirm. A Facebook or Instagram entry and its encrypted saved session are removed; a YouTube entry is removed from the list. This does not sign the website out. Experimental TikTok entries have no popup controls yet; both wipe actions below remove them.
- **Forgot password:** confirm the wipe on the locked page. This removes the vault and saved Facebook/Instagram/TikTok entries, and all optional profile details, including quarantined copies. YouTube shortcut coordinates and preferences remain; their custom labels remain, while automatic labels become “YouTube”. Quarantine is cleared. If the store cannot be read safely, the entire local store is removed instead.
- **Settings → Wipe all data:** confirm to remove the local `store`, including all entries, the vault, preferences and `quarantine`. Both wipe actions remove the unlocked key, unlock-attempt record and switch journals. A wipe is refused while a platform is busy. The theme cache is separate from the store and is not explicitly erased by the worker's wipe operation.
- **Uninstall:** remove the extension at `chrome://extensions`. Chrome removes its `storage.local` data, as described in the linked storage documentation.

These actions do not delete your accounts on the websites, revoke sessions held elsewhere, or erase copies in browser-profile backups. They do not clear the websites' current cookies.

## Contact and policy changes

Open an issue in this repository about this policy. Do not include cookies, passwords or other secrets. For a security problem, follow [SECURITY.md](SECURITY.md). Policy changes are recorded here and in [CHANGELOG.md](CHANGELOG.md).
