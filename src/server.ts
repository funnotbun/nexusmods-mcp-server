import { registerDownloadTools } from "./tools/downloads.js";
// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, PKG_VERSION } from "./config.js";
import { NexusApiClient } from "./clients/nexus-api.js";
import { WebClient } from "./clients/web-client.js";
import { registerRestApiTools } from "./tools/rest-api.js";
import { registerGraphqlTools } from "./tools/graphql-api.js";
import { registerUploadTools } from "./tools/upload-api.js";
import { registerWebTools } from "./tools/web-api.js";
import { registerWebModTools } from "./tools/web-mod.js";

// Sent to MCP clients on initialize so agents know the workflows without trial and error.
function buildInstructions(hasKey: boolean): string {
  return [
    "Nexus Mods tools (any game).",
    'IDs: game = domain name from site URLs ("skyrimspecialedition", "fallout4", "stardewvalley"; find with list_games). mod_id = number in /<game>/mods/<id>. file_id from get_mod_files.',
    `API key: ${hasKey ? "configured" : "NOT configured — v1 (get_mod, get_mod_files, downloads, tracking, endorse) and v3 upload tools will fail until NEXUS_API_KEY is set (npm run setup)"}. GraphQL tools (search_mods, list_games, get_mod_details, collections, get_user, get_news, graphql_query) work without a key.`,
    "Rate limits (v1/v3, per API key): hourly + daily quotas (daily 20,000); remaining budget is shown by validate_user and in API errors. Avoid bulk loops.",
    "Discover: search_mods(query, game) → get_mod_details (description, requirements, uid) or get_mod (v1) → get_mod_files → get_download_link / download_file(dest_dir).",
    "Browser downloads: download_mod_file(game, mod_id, file_id, dest_subdir?) and download_mod_files(files) open a visible dedicated window, click the ordinary Slow download control, capture the site-generated URL, then stream the archive. Login and verification require the human. This path avoids preliminary API requests. Downloads are serial; configure NEXUS_DOWNLOAD_DIR, NEXUS_BROWSER_CHANNEL, NEXUS_HUMAN_TIMEOUT_MS, NEXUS_DOWNLOAD_DELAY_MS and NEXUS_DOWNLOAD_BATCH_LIMIT.",
    "Downloads: premium accounts download directly; non-premium need key + expires from the site's nxm:// link (Files tab → Mod Manager Download).",
    "Upload a new version of an existing mod file: 1) get_upload_targets(game, mod_id) → mod uid + mod_file ids; 2) upload_file_version(mod_file_id, file_path, version, changelog?, mod_uid?). Publishes immediately. If publish fails after upload, retry with upload_id. New mod pages and first files must be created on the website.",
    "Mod comments (Posts tab): get_mod_comments(game, mod_id, page) → post_mod_comment(text, parent_id?) / edit_mod_comment(comment_id). Collection comments: get_collection → get_collection_comments(comment_thread_id) → post/edit/delete_collection_comment.",
    "Bug reports: get_mod_bugs(game, mod_id, status?) → get_mod_bug(issue_id) → reply_mod_bug; post_mod_bug files a new one; authors: delete_mod_bug.",
    "Forums: forum_list(forum?) → forum_topic(topic, page) → forum_reply(topic, text). Private messages: pm_list → pm_read(conversation_id) → pm_reply; pm_send(to[], title, text) starts one; pm_leave removes it from your inbox. Text is plain (html=true passes editor HTML).",
    "Your own mods (author session): edit_mod_page(game, mod_id) shows name/summary/description (BBCode)/version; pass fields to change them (others are resent unchanged). get_mod_media → upload_mod_image / delete_mod_image, add_mod_video (YouTube) / delete_mod_video. hide_mod_comment hides a comment on your mod.",
    "Web tier runs through a dedicated headless browser (first call ~5-10 s to pass Cloudflare). Reads of public pages need no login. Writes, PMs and author tools need a session: web_status → web_login (extracts browser cookies, else opens sign-in in the default browser or a sign-in window; retry after signing in; web_login_cancel stops waiting) or web_set_cookies; web_logout signs out. Every web write accepts dry_run=true to preview the exact request.",
    "Not supported (no verified endpoint): forum search (returns no results even logged in), creating forum topics, deleting your own comments on other authors' mods.",
  ].join("\n");
}

export async function createServer(): Promise<{ server: McpServer; webClient: WebClient }> {
  const config = loadConfig();
  const api = new NexusApiClient(config.apiKey);

  const server = new McpServer(
    { name: "nexusmods-mcp-server", version: PKG_VERSION },
    { instructions: buildInstructions(api.hasKey()) },
  );

  registerRestApiTools(server, api, config);
  registerGraphqlTools(server, api);
  registerUploadTools(server, api, config);

  // init() is non-blocking: on-disk cookies load instantly; auto-extraction runs in the
  // background so the MCP initialize handshake is never delayed.
  const webClient = new WebClient(config);
  webClient.init();
  registerWebTools(server, webClient, api);
  registerWebModTools(server, webClient, api);
  registerDownloadTools(server, api, webClient, config);

  console.error(
    `[nexusmods-mcp] ready (api key: ${api.hasKey() ? "yes" : "no"}, web cookies: ${webClient.hasCookies() ? "loaded" : "none"})`,
  );
  return { server, webClient };
}
