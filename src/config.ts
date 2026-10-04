// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

// package.json sits one level above both src/ and build/.
export const PKG_VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

/** Sent as Application-Name on every Nexus API request (required by the API acceptable-use policy). */
export const APP_NAME = "nexusmods-mcp-server";

export interface Config {
  apiKey: string;
  downloadDir: string; // optional default target dir for download_file
  uploadDir: string; // optional — if set, confines upload_file_version reads to this directory
  authDir: string;
  cookiesPath: string;
  readOnly: boolean;
  allowDownloads: boolean;
}

export function loadConfig(): Config {
  const authDir = path.resolve(__dirname, "..", ".auth");
  return {
    apiKey: process.env.NEXUS_API_KEY || "",
    readOnly: process.env.NEXUS_READ_ONLY === "1",
    allowDownloads: process.env.NEXUS_ALLOW_DOWNLOADS !== "0",
    downloadDir: process.env.NEXUS_DOWNLOAD_DIR || "",
    uploadDir: process.env.NEXUS_UPLOAD_DIR || "",
    authDir,
    cookiesPath: path.resolve(authDir, "cookies.json"),
  };
}
