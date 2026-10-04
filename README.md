# nexusmods-mcp-server

MCP server for [Nexus Mods](https://www.nexusmods.com): search mods and collections, read
files/changelogs/requirements, download files, track and endorse mods, upload new file
versions (v3 API), and — through your own browser session — mod comments, bug reports,
forums, private messages, and your mods' media and page text.

## Install

```bash
npm install
npx patchright install chromium   # only for the web tier (comments, bugs, forums, PMs, media)
npm run build
npm run setup                     # API key + optional web session
```

MCP client config:

```json
{
  "mcpServers": {
    "nexusmods-mcp-server": { "command": "node", "args": ["/path/to/nexusmods-mcp-server/build/index.js"] }
  }
}
```

## Access levels

| Level | Needs | Tools |
|---|---|---|
| Zero-config | nothing | GraphQL: `search_mods`, `list_games`, `get_mod_details`, `search_collections`, `get_collection`, `get_collection_comments`, `get_user`, `get_news`, `graphql_query`; web reads: `get_mod_comments`, `get_mod_bugs`, `get_mod_bug`, `forum_list`, `forum_topic` |
| API key | `NEXUS_API_KEY` in `.env` | v1: `validate_user`, `get_game`, `get_mod`, `get_mod_files`, `get_mod_file`, `get_changelogs`, `list_mods`, `get_updated_mods`, `md5_lookup`, `get_download_link`, `download_file`, `get_tracked_mods`, `track_mod`, `endorse_mod`, `get_endorsements`; v3: `get_upload_targets`, `get_mod_file_versions`, `upload_file_version`, `add_changelog` |
| Web session | logged-in nexusmods.com session | comments: `post_mod_comment`, `edit_mod_comment`, `post_collection_comment`, `edit_collection_comment`, `delete_collection_comment`; bugs: `post_mod_bug`, `reply_mod_bug`; forums/PMs: `forum_reply`, `pm_list`, `pm_read`, `pm_send`, `pm_reply`, `pm_leave` |
| Web session, mod author | session of the mod's author/team | `edit_mod_page`, `get_mod_media`, `upload_mod_image`, `delete_mod_image`, `add_mod_video`, `delete_mod_video`, `hide_mod_comment`, `delete_mod_bug` |

Session helpers: `web_status`, `web_login`, `web_login_cancel`, `web_set_cookies`, `web_logout` (deletes the stored cookies, clears the session from the browser profile, stops a pending sign-in window; no silent browser-cookie extraction at startup until the next `web_login` / `web_set_cookies`). Every web write takes
`dry_run: true` to return the exact prepared request without sending it.

Get a personal API key at <https://www.nexusmods.com/users/myaccount?tab=api>.
Downloads: premium accounts get direct links; free accounts must pass `key` + `expires`
from the site's `nxm://` link (Files tab → Mod Manager Download).

## Uploading a new version

1. `get_upload_targets(game, mod_id)` → v3 mod uid + mod_file ids
2. `upload_file_version(mod_file_id, file_path, version, changelog?, mod_uid?)`

The flow mirrors the official [upload-action](https://github.com/Nexus-Mods/upload-action):
multipart upload → finalise → wait until available → publish version → optional changelog.
New mod pages and a mod's first file must still be created on the website.

## Web tier

Operations the official API only allows with OAuth run through a dedicated headless
Chromium (patchright) with its own profile in `~/.nexusmods-mcp/chrome-profile`. Only
requests the website itself makes are used — see [docs/web-endpoints.md](docs/web-endpoints.md)
for the evidence and the list of not-yet-supported actions (forum search, forum topic
creation, deleting your comments on other authors' mods). Forum/PM tools sign in to the
forums automatically through the site's SSO. This is unofficial and may break when the
site changes. `NEXUS_BROWSER_VISIBLE=1` shows the browser window for debugging.

## Structured output (`format: "json"`)

For programs (e.g. IssueWatcher) these tools take `format: "json"` (default `"text"`,
unchanged): `search_mods`, `get_mod_comments`, `get_mod_bugs`, `get_mod_bug`,
`post_mod_comment`, `reply_mod_bug`, `web_status`, `web_login`, `web_login_cancel`, `web_logout`. The result is the full, untruncated
object as MCP `structuredContent`, and the same JSON in the text block. No `outputSchema`
is declared (the SDK would then demand structuredContent in text mode too); the zod
schemas live in `src/tools/json-shapes.ts` and are checked by `npm test` against saved
site widgets in `test/fixtures/`.

Conventions: comment / bug / reply ids are strings; `modId`, `threadId`, `authorId` /
`memberId` and counts are numbers;
`*At` = ISO-8601 UTC or `null`; bodies are plain text with line breaks (BBCode rendered by
the site, not raw).

| Tool | Result |
|---|---|
| `search_mods` | `{total, offset, count, mods:[{game, modId, uid, name, version, author, uploader:{name, memberId}, summary, downloads, endorsements, createdAt, updatedAt, url}]}` — own mods: `author`/`game` filter, page with `offset` (`count` ≤ 50) |
| `get_mod_comments` | `{game, modId, threadId, page, pages, perPage:10, total, url, comments:[{id, parentId:null, author, authorId, isModAuthor, createdAt, updatedAt:null, body, sticky, locked, replies:[{id, parentId, author, authorId, isModAuthor, createdAt, updatedAt:null, body}]}]}` — 10 root threads per page, sticky first, then newest; `total` counts replies too |
| `get_mod_bugs` | `{game, modId, filter, page, pages, perPage:10, canReport, url, bugs:[{id, title, status, statusKey, open, replies, version, priority, lastPostAt}]}` — `statusKey` ∈ `new, known, looking, fixed, duplicate, not_a_bug, wont_fix, need_info` (null if unknown label); `open` = not fixed/duplicate/not_a_bug/wont_fix |
| `get_mod_bug` | `{issueId, canReply, report:{id, parentId:null, author, authorId, createdAt:null, createdAtLocal, body}, replies:[{… parentId: issueId}]}` — the widget shows only a site-local time without offset (`"YYYY-MM-DDTHH:MM"`, the logged-in profile's zone), so `createdAt` is null; use `lastPostAt` from `get_mod_bugs` for UTC |
| `post_mod_comment` | `{posted:true, dryRun:false, id, parentId, verified, httpStatus}` — the site answers `1` without an id: `id` is found by reading the thread back (same body, not seen before); `verified:false, id:null` if not found |
| `reply_mod_bug` | same shape; always read back (the endpoint may answer HTTP 500 yet save); `dry_run:true` → `{posted:false, dryRun:true, id:null, request}` |
| `web_status` | `{loggedIn, loginInProgress, cookiesStored, detail, account:{memberId, name} \| null, accountError?, sessionSource, sessionBrowser, loginVia, loginBrowser}` — `loginVia`/`loginBrowser` as in `web_login`; `sessionSource` = where the stored cookies came from: `"browser"` (extracted from an installed browser, incl. the startup background extraction; `sessionBrowser` = its name), `"window"` (captured from the visible sign-in window), `"manual"` (`web_set_cookies`), `null` (no cookies, or unknown — e.g. a cookies file from before this field); kept in `session.json` beside the cookies file; `account` is the logged-in Nexus account (member id from the api-router `preferences` global id, name from `user(id)`), cached until the cookies change; lookup failure → `account:null` + `accountError`, `loggedIn` unchanged |
| `web_login` | `{loggedIn, loginWindowOpened, detail, loginInProgress, loginVia, loginBrowser, sessionSource, sessionBrowser}` — order: (1) silent cookie extraction from installed browsers (`loginVia:"browser-extract"`); (2) else the default browser (Windows https `UserChoice` ProgId → `chrome`/`edge`/`firefox`/`brave`/`opera`/`opera-gx`/`vivaldi`/`yandex`/`centbrowser`) if its cookie store is readable (a store whose cookie values all fail to decrypt counts as unreadable): the sign-in page opens there and its cookies are polled every 4 s (`loginVia:"default-browser"`, `loginBrowser` = its name; success → `sessionSource:"browser"`, `sessionBrowser` = it); (3) else the server's own sign-in window (`loginVia:"window"`, `loginWindowOpened:true`). Polls last up to 10 min (`loginInProgress:true`); poll `web_status` until `loggedIn`. `loginVia` is null before any login and after cancel/logout. Every step is logged to stderr as `[login] …` |
| `web_login_cancel` | `{cancelled}` — true if a sign-in poll was running; closes the own sign-in window (a page in the user's browser stays) |
| `web_logout` | `{loggedOut:true, cookiesStored:false}` — idempotent |

Errors (`isError: true`): `structuredContent = {error:{code, message}}`, `code` ∈
`not_logged_in` (no session / no form token), `cloudflare`, `not_found` (unknown game,
deleted bug), `disabled` (comments or bug reports off for the mod), `rate_limited`,
`invalid`, `outcome_unknown` (a write request was sent but failed without a 4xx
refusal — timeout, 5xx, odd answer — and the read-back did not find it: it may have been
saved, read back before retrying), `error`. `search_mods` also filters by `uploader`
(exact account name) or `uploader_id`, which identify an account; `author` is free text.
Writes are never retried; GET / GraphQL reads back off once on
429/503 (`Retry-After` ≤ 30 s, else 2 s).

## Rules

Requests send `Application-Name` / `Application-Version` as required by the
[API acceptable use policy](https://help.nexusmods.com/article/114-api-acceptable-use-policy).
Don't use this server for bulk scraping.

## License

CC BY-NC 4.0 — Copyright (c) 2026 Morgott. See [LICENSE](LICENSE).

## Browser downloads

Call `get_mod_files` to select a file, then `download_mod_file(game, mod_id, file_id, dest_subdir?)`
or `download_mod_files(files)`. The downloader opens a visible dedicated browser, clicks the site's
ordinary Slow download control, and captures the generated URL for an independent streamed transfer.
Existing cookie extraction, default-browser login, manual cookie import, and setup remain available.

Configure an existing absolute `NEXUS_DOWNLOAD_DIR`. `NEXUS_BROWSER_CHANNEL` selects
`chromium` (default), `chrome`, or `msedge`. Login and site verification remain manual.
`NEXUS_HUMAN_TIMEOUT_MS` defaults to 300000; `NEXUS_DOWNLOAD_DELAY_MS` to 3000;
`NEXUS_DOWNLOAD_BATCH_LIMIT` to 25. Set `NEXUS_ALLOW_DOWNLOADS=0` to disable the new tools.

Navigation starts automation at commit. One browser task checks the page and clicks controls inside
open shadow roots; enabled controls can be retried while handlers mount. CDN response filenames
are honoured even when the URL uses an opaque object ID. No preliminary account or metadata lookup
is needed. Transfers verify CDN byte counts and supplied checksums, using bounded memory.
