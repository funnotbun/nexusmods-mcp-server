import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";

export const ACCOUNT_WRITES = new Set([
  "track_mod", "endorse_mod", "upload_file_version", "add_changelog",
  "post_mod_comment", "edit_mod_comment", "post_collection_comment", "edit_collection_comment", "delete_collection_comment",
  "forum_reply", "pm_send", "pm_reply", "pm_leave", "post_mod_bug", "reply_mod_bug", "delete_mod_bug",
  "hide_mod_comment", "upload_mod_image", "delete_mod_image", "add_mod_video", "delete_mod_video", "edit_mod_page",
]);
const DOWNLOADS = new Set(["get_download_link", "download_file", "download_mod_file", "download_mod_files"]);

export function shouldRegisterTool(name: string, config: Config): boolean {
  return !(config.readOnly && ACCOUNT_WRITES.has(name)) &&
    !(DOWNLOADS.has(name) && !config.allowDownloads);
}

export function capabilityServer(server: McpServer, config: Config): McpServer {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === "registerTool") return (name: string, ...args: unknown[]) => {
        if (!shouldRegisterTool(name, config)) return;
        return (target.registerTool as Function).call(target, name, ...args);
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
