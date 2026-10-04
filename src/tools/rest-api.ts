import { safeDownload } from "../clients/safe-download.js";
// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

import { mkdirSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { Config } from "../config.js";
import type { NexusApiClient } from "../clients/nexus-api.js";
import { success, error, errMsg } from "../utils/types.js";
import { fmtDate, fmtNum, fmtSize, oneLine, truncate, stripHtml } from "../utils/helpers.js";

const game = z.string().min(1).describe('Game domain name as in site URLs, e.g. "skyrimspecialedition", "fallout4", "stardewvalley"');
const modId = z.number().int().positive().describe("Mod ID (number in the mod page URL /mods/<id>)");
const fileId = z.number().int().positive().describe("File ID (from get_mod_files)");

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function formatV1Mod(m: any): string {
  const lines = [`${m.name ?? "(unavailable)"} [${m.domain_name}/${m.mod_id}] v${m.version ?? "?"}`];
  lines.push(`by ${m.author ?? "?"} (uploader: ${m.uploaded_by ?? "?"}) | status: ${m.status ?? "?"}${m.contains_adult_content ? " | adult" : ""}`);
  lines.push(
    `downloads: ${fmtNum(m.mod_downloads)} (unique ${fmtNum(m.mod_unique_downloads)}) | endorsements: ${fmtNum(m.endorsement_count)} | category: ${m.category_id ?? "?"}`,
  );
  lines.push(`created: ${fmtDate(m.created_time)} | updated: ${fmtDate(m.updated_time)}`);
  if (m.endorsement?.endorse_status) lines.push(`your endorsement: ${m.endorsement.endorse_status}`);
  if (m.summary) lines.push(`summary: ${oneLine(stripHtml(m.summary), 400)}`);
  lines.push(`url: https://www.nexusmods.com/${m.domain_name}/mods/${m.mod_id}`);
  return lines.join("\n");
}

function formatV1ModShort(m: any): string {
  return `[${m.mod_id}] ${m.name ?? "(unavailable)"} v${m.version ?? "?"} — ${fmtNum(m.mod_downloads)} dl, ${fmtNum(m.endorsement_count)} end | by ${m.author ?? "?"} | upd ${fmtDate(m.updated_time)}`;
}

function formatV1File(f: any): string {
  const size = f.size_in_bytes ?? (f.size_kb ? f.size_kb * 1024 : f.size);
  let line = `[${f.file_id}] ${f.name} v${f.version ?? "?"} (${f.category_name ?? f.category_id ?? "?"}, ${fmtSize(size)}) | ${fmtDate(f.uploaded_timestamp ?? f.uploaded_time)}`;
  if (f.is_primary) line += " | primary";
  if (f.file_name) line += `\n  file: ${f.file_name}`;
  if (f.description) line += `\n  ${oneLine(stripHtml(f.description), 200)}`;
  return line;
}

export function registerRestApiTools(server: McpServer, api: NexusApiClient, config: Config): void {
  const wrap = (name: string, fn: () => Promise<string>) =>
    fn().then(success, (e) => error(`${name}: ${errMsg(e)}`));

  server.registerTool(
    "validate_user",
    {
      title: "Validate API Key / Current User",
      description: "Validate NEXUS_API_KEY and show the account (name, premium/supporter) plus remaining API rate limit.",
      inputSchema: {},
      annotations: READ,
    },
    () =>
      wrap("validate_user", async () => {
        const u = await api.v1("GET", "/users/validate");
        return `${u.name} (user_id ${u.user_id}) | premium: ${u.is_premium ? "yes" : "no"} | supporter: ${u.is_supporter ? "yes" : "no"}\n${api.rateLimitText()}`;
      }),
  );

  server.registerTool(
    "get_game",
    {
      title: "Get Game (v1)",
      description: "Game details by domain name: id, name, mod/file/download counts, categories (id → name). Use list_games to discover domain names.",
      inputSchema: { game, show_categories: z.boolean().optional().default(true) },
      annotations: READ,
    },
    ({ game: g, show_categories }) =>
      wrap("get_game", async () => {
        const d = await api.v1("GET", `/games/${encodeURIComponent(g)}`);
        const lines = [
          `${d.name} [${d.domain_name}] id:${d.id} | mods: ${fmtNum(d.mods)} | files: ${fmtNum(d.file_count)} | downloads: ${fmtNum(d.downloads)}`,
        ];
        if (show_categories && Array.isArray(d.categories)) {
          lines.push("categories: " + d.categories.map((c: any) => `${c.category_id}=${c.name}`).join(", "));
        }
        return truncate(lines.join("\n"));
      }),
  );

  server.registerTool(
    "get_mod",
    {
      title: "Get Mod (v1)",
      description: "Full mod info: name, version, author, status, downloads, endorsements, dates, summary, your endorsement status.",
      inputSchema: { game, mod_id: modId },
      annotations: READ,
    },
    ({ game: g, mod_id }) => wrap("get_mod", async () => formatV1Mod(await api.v1("GET", `/games/${g}/mods/${mod_id}`))),
  );

  server.registerTool(
    "get_mod_files",
    {
      title: "List Mod Files (v1)",
      description: "List a mod's files (file_id, name, version, category, size, upload date). Optional category filter.",
      inputSchema: {
        game,
        mod_id: modId,
        category: z
          .enum(["main", "update", "optional", "old_version", "miscellaneous"])
          .optional()
          .describe("Only files in this category"),
      },
      annotations: READ,
    },
    ({ game: g, mod_id, category }) =>
      wrap("get_mod_files", async () => {
        const q = category ? `?category=${category}` : "";
        const d = await api.v1("GET", `/games/${g}/mods/${mod_id}/files${q}`);
        const files: any[] = d.files ?? [];
        const lines = files.map(formatV1File);
        const updates: any[] = d.file_updates ?? [];
        if (updates.length) {
          lines.push(`\nfile updates (old → new): ${updates.slice(-10).map((u) => `${u.old_file_id}→${u.new_file_id}`).join(", ")}`);
        }
        return truncate(`${files.length} files:\n${lines.join("\n")}`);
      }),
  );

  server.registerTool(
    "get_mod_file",
    {
      title: "Get Mod File (v1)",
      description: "Details for one mod file.",
      inputSchema: { game, mod_id: modId, file_id: fileId },
      annotations: READ,
    },
    ({ game: g, mod_id, file_id }) =>
      wrap("get_mod_file", async () => {
        const f = await api.v1("GET", `/games/${g}/mods/${mod_id}/files/${file_id}`);
        let out = formatV1File(f);
        if (f.changelog_html) out += `\nchangelog: ${oneLine(stripHtml(f.changelog_html), 800)}`;
        if (f.external_virus_scan_url) out += `\nvirus scan: ${f.external_virus_scan_url}`;
        return out;
      }),
  );

  server.registerTool(
    "get_changelogs",
    {
      title: "Get Mod Changelogs (v1)",
      description: "All version changelogs of a mod (version → entries). Newest versions last.",
      inputSchema: { game, mod_id: modId, last: z.number().int().min(1).max(200).optional().default(20).describe("Only the last N versions") },
      annotations: READ,
    },
    ({ game: g, mod_id, last }) =>
      wrap("get_changelogs", async () => {
        const d: Record<string, string[]> = await api.v1("GET", `/games/${g}/mods/${mod_id}/changelogs`);
        const entries = Object.entries(d).slice(-last);
        if (!entries.length) return "No changelogs.";
        return truncate(entries.map(([v, items]) => `${v}:\n${(items ?? []).map((i) => `  - ${oneLine(stripHtml(i), 300)}`).join("\n")}`).join("\n"));
      }),
  );

  server.registerTool(
    "list_mods",
    {
      title: "List Latest / Updated / Trending Mods (v1)",
      description: "10 mods per list: latest_added, latest_updated or trending for a game.",
      inputSchema: { game, list: z.enum(["latest_added", "latest_updated", "trending"]) },
      annotations: READ,
    },
    ({ game: g, list }) =>
      wrap("list_mods", async () => {
        const mods: any[] = await api.v1("GET", `/games/${g}/mods/${list}`);
        return mods.map(formatV1ModShort).join("\n") || "No mods.";
      }),
  );

  server.registerTool(
    "get_updated_mods",
    {
      title: "Mods Updated In Period (v1)",
      description: "IDs of mods updated in the last day/week/month (with timestamps). Use to check tracked mods for updates.",
      inputSchema: { game, period: z.enum(["1d", "1w", "1m"]).default("1w"), limit: z.number().int().min(1).max(1000).optional().default(100) },
      annotations: READ,
    },
    ({ game: g, period, limit }) =>
      wrap("get_updated_mods", async () => {
        const rows: any[] = await api.v1("GET", `/games/${g}/mods/updated?period=${period}`);
        const shown = rows.slice(0, limit).map((r) => `${r.mod_id} (${fmtDate(r.latest_mod_activity ?? r.latest_file_update)})`);
        return `${rows.length} mods updated in ${period}${rows.length > limit ? ` (showing ${limit})` : ""}:\n${shown.join(", ")}`;
      }),
  );

  server.registerTool(
    "md5_lookup",
    {
      title: "Find File by MD5 (v1)",
      description: "Identify a mod file from its MD5 hash (returns mod + file). For a batch of hashes use graphql_query with fileHashes.",
      inputSchema: { game, md5: z.string().regex(/^[a-fA-F0-9]{32}$/).describe("MD5 hex digest") },
      annotations: READ,
    },
    ({ game: g, md5 }) =>
      wrap("md5_lookup", async () => {
        const rows: any[] = await api.v1("GET", `/games/${g}/mods/md5_search/${md5.toLowerCase()}`);
        if (!rows.length) return "No match.";
        return rows.map((r) => `${formatV1ModShort(r.mod ?? {})}\n  ${formatV1File(r.file_details ?? {})}`).join("\n");
      }),
  );

  const nxmParams = {
    key: z.string().optional().describe("Non-premium only: `key` from an nxm:// link (Mod Manager Download button on the site)"),
    expires: z.number().int().optional().describe("Non-premium only: `expires` from the same nxm:// link"),
  };
  const linkPath = (g: string, m: number, f: number, key?: string, expires?: number) =>
    `/games/${g}/mods/${m}/files/${f}/download_link` + (key && expires ? `?key=${encodeURIComponent(key)}&expires=${expires}` : "");
  const explainDownload = (e: unknown): string => {
    const msg = errMsg(e);
    return /HTTP 403/.test(msg)
      ? `${msg}\nNon-premium accounts can't generate links directly: open the mod's Files tab, click "Mod Manager Download", copy the nxm:// link and pass its key + expires params.`
      : msg;
  };

  server.registerTool(
    "get_download_link",
    {
      title: "Get Download Link (v1)",
      description:
        "CDN download URLs for a file. Premium: works directly. Non-premium: pass key + expires from an nxm:// link (nxm://<game>/mods/<mod>/files/<file>?key=...&expires=...).",
      inputSchema: { game, mod_id: modId, file_id: fileId, ...nxmParams },
      annotations: READ,
    },
    async ({ game: g, mod_id, file_id, key, expires }) => {
      try {
        const links: any[] = await api.v1("GET", linkPath(g, mod_id, file_id, key, expires));
        return success(links.map((l) => `${l.name} (${l.short_name}): ${l.URI}`).join("\n") || "No links returned.");
      } catch (e) {
        return error(`get_download_link: ${explainDownload(e)}`);
      }
    },
  );

  server.registerTool(
    "download_file",
    {
      title: "Download Mod File (v1)",
      description:
        "Download a mod file to a local directory (dest_dir, else NEXUS_DOWNLOAD_DIR). Premium: direct. Non-premium: pass key + expires from an nxm:// link.",
      inputSchema: {
        game,
        mod_id: modId,
        file_id: fileId,
        dest_dir: z.string().optional().describe("Absolute target directory (created if missing)"),
        ...nxmParams,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ game: g, mod_id, file_id, dest_dir, key, expires }) => {
      const dir = dest_dir || config.downloadDir;
      if (!dir) return error("download_file: pass dest_dir or set NEXUS_DOWNLOAD_DIR in .env");
      try {
        const links: any[] = await api.v1("GET", linkPath(g, mod_id, file_id, key, expires));
        if (!links.length) return error("download_file: no download links returned");
        const metadata = await api.v1("GET", `/games/${g}/mods/${mod_id}/files/${file_id}`);
        mkdirSync(dir, { recursive: true });
        return success(await safeDownload({downloadDir:dir, allowDownloads:config.allowDownloads}, links[0].URI, metadata));
      } catch (e) {
        return error(`download_file: ${explainDownload(e)}`);
      }
    },
  );

  server.registerTool(
    "get_tracked_mods",
    {
      title: "List Tracked Mods (v1)",
      description: "Mods you track (game domain + mod id). Optional game filter.",
      inputSchema: { game: game.optional() },
      annotations: READ,
    },
    ({ game: g }) =>
      wrap("get_tracked_mods", async () => {
        const rows: any[] = await api.v1("GET", "/user/tracked_mods");
        const filtered = g ? rows.filter((r) => r.domain_name === g) : rows;
        return `${filtered.length} tracked:\n${filtered.map((r) => `${r.domain_name}/${r.mod_id}`).join(", ")}`;
      }),
  );

  server.registerTool(
    "track_mod",
    {
      title: "Track / Untrack Mod (v1)",
      description: "Start or stop tracking a mod.",
      inputSchema: { game, mod_id: modId, action: z.enum(["track", "untrack"]).default("track") },
      annotations: WRITE_IDEMPOTENT,
    },
    ({ game: g, mod_id, action }) =>
      wrap("track_mod", async () => {
        const body = { domain_name: g, mod_id };
        try {
          const r = await api.v1(action === "track" ? "POST" : "DELETE", "/user/tracked_mods", body);
          return `${action === "track" ? "Tracking" : "Untracked"} ${g}/${mod_id}${r?.message ? ` — ${r.message}` : ""}`;
        } catch (e) {
          // 422 = already tracked (see official node-nexus-api client).
          if (action === "track" && /HTTP 422/.test(errMsg(e))) return `Already tracking ${g}/${mod_id}`;
          throw e;
        }
      }),
  );

  server.registerTool(
    "endorse_mod",
    {
      title: "Endorse / Abstain Mod (v1)",
      description: "Endorse a mod or abstain from endorsing. The current mod version is looked up automatically if not given.",
      inputSchema: {
        game,
        mod_id: modId,
        action: z.enum(["endorse", "abstain"]).default("endorse"),
        version: z.string().optional().describe("Mod version you endorse (defaults to the mod's current version)"),
      },
      annotations: WRITE_IDEMPOTENT,
    },
    ({ game: g, mod_id, action, version }) =>
      wrap("endorse_mod", async () => {
        const v = version ?? (await api.v1("GET", `/games/${g}/mods/${mod_id}`)).version;
        const r = await api.v1("POST", `/games/${g}/mods/${mod_id}/${action}`, { Version: v });
        return `${action} ${g}/${mod_id} (v${v}): ${r?.status ?? r?.message ?? "ok"}`;
      }),
  );

  server.registerTool(
    "get_endorsements",
    {
      title: "List My Endorsements (v1)",
      description: "Mods you endorsed or abstained from.",
      inputSchema: { game: game.optional() },
      annotations: READ,
    },
    ({ game: g }) =>
      wrap("get_endorsements", async () => {
        const rows: any[] = await api.v1("GET", "/user/endorsements");
        const filtered = g ? rows.filter((r) => r.domain_name === g) : rows;
        return `${filtered.length} endorsements:\n${filtered.map((r) => `${r.domain_name}/${r.mod_id} ${r.status} (${fmtDate(r.date)})`).join("\n")}`;
      }),
  );
}
