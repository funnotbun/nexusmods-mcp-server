import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { Config } from "../config.js";
import type { NexusApiClient } from "../clients/nexus-api.js";
import type { WebClient } from "../clients/web-client.js";
import { NeedsHumanError } from "../clients/download-browser.js";
import { safeDownload, validateCdnUrl, type DownloadOptions } from "../clients/safe-download.js";
import { downloadDirectory } from "../utils/helpers.js";
import { validateFileRequest, type FileRequest } from "../utils/nxm.js";
import { errMsg } from "../utils/types.js";
import { jsonResult } from "../utils/structured.js";

/** One queue shared by single and batch browser downloads, including concurrent MCP calls. */
export class DownloadQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private finished: number | undefined;
  constructor(private now = Date.now, private delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms)), private gapMs = 3000) {}
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      if (this.finished !== undefined) await this.delay(Math.max(0, this.gapMs - (this.now() - this.finished)));
      try { return await task(); } finally { this.finished = this.now(); }
    });
    this.tail = next.catch(() => {});
    return next;
  }
}
export const downloadsQueue = new DownloadQueue(Date.now, undefined, Number(process.env.NEXUS_DOWNLOAD_DELAY_MS || 3000));

export function downloadLinkPath(request: FileRequest, key?: string, expires?: number): string {
  validateFileRequest(request);
  return `/games/${request.game}/mods/${request.mod_id}/files/${request.file_id}/download_link` +
    (key && expires ? `?key=${encodeURIComponent(key)}&expires=${expires}` : "");
}

export async function downloadFromLinks(config: Config & DownloadOptions, links: any[], metadata: any, subdir?: string): Promise<string> {
  const link = links.find(l => { try { validateCdnUrl(l.URI, config.cdnHosts || ["nexusmods.com","nexus-cdn.com"]); return true; } catch { return false; } });
  if (!link) throw new Error("No HTTPS download URI on the configured CDN allow-list");
  return safeDownload(config, link.URI, metadata, subdir);
}

export class ModDownloader {
  constructor(private api: NexusApiClient, private web: WebClient, private config: Config & Required<Pick<DownloadOptions, "allowDownloads" | "cdnHosts">>) {}
  async download(request: FileRequest): Promise<string> {
    validateFileRequest(request);
    if (!this.config.allowDownloads) throw new Error("Downloads are disabled");
    await downloadDirectory(this.config.downloadDir, request.dest_subdir);
    // No API lookups: the browser session already carries everything needed. The file name comes
    // from the CDN response and the transfer is verified against its Content-Length.
    const capture = await this.web.captureDownload(request);
    if (capture.kind === "cdn") return safeDownload(this.config, capture.uri, {}, request.dest_subdir);
    const links = await this.api.v1("GET", downloadLinkPath(request, capture.grant.key, capture.grant.expires));
    return downloadFromLinks(this.config, links, {}, request.dest_subdir);
  }
}

const fileShape = {
  game: z.string().regex(/^[a-z0-9]+$/), mod_id: z.number().int().positive(), file_id: z.number().int().positive(),
  dest_subdir: z.string().optional().describe("Safe relative subdirectory of NEXUS_DOWNLOAD_DIR"),
};

export function registerDownloadTools(server: McpServer, api: NexusApiClient, web: WebClient, base: Config): void {
  const config = { ...base, allowDownloads: process.env.NEXUS_ALLOW_DOWNLOADS !== "0", cdnHosts: (process.env.NEXUS_CDN_HOSTS || "nexusmods.com,nexus-cdn.com").split(",").map(host => host.trim()), downloadBatchLimit: Number(process.env.NEXUS_DOWNLOAD_BATCH_LIMIT || 25), downloadDelayMs: Number(process.env.NEXUS_DOWNLOAD_DELAY_MS || 3000) };
  if (!config.allowDownloads) return;
  const downloader = new ModDownloader(api, web, config);
  const run = (request: FileRequest) => downloadsQueue.run(async () => {
    try { return { ...request, status: "verified", detail: await downloader.download(request) }; }
    catch (e) { return { ...request, status: e instanceof NeedsHumanError ? "needs_human" : "error", detail: errMsg(e) }; }
  });
  const annotations = {readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true};
  server.registerTool("download_mod_file", {
    title:"Download Mod File", description:"Visible browser download with a verified streamed transfer. Human login/challenges may be required. Downloads run one at a time.",
    inputSchema:fileShape, annotations,
  }, async request => {
    const result = await run(request);
    return { ...jsonResult(result), ...(result.status === "error" ? {isError:true} : {}) };
  });
  server.registerTool("download_mod_files", {
    title:"Download Mod Files", description:`At most ${config.downloadBatchLimit} verified downloads, serially with ${config.downloadDelayMs} ms between files. Stops on needs_human or error; retry the remaining list after resolving it.`,
    inputSchema:{files:z.array(z.object(fileShape)).min(1).max(config.downloadBatchLimit)}, annotations,
  }, async ({files}) => {
    const results = [];
    for (const file of files) { const result = await run(file); results.push(result); if (result.status !== "verified") break; }
    return jsonResult({results,remaining:files.slice(results.length)});
  });
}
