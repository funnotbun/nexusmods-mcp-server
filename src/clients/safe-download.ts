import { createReadStream } from "node:fs";
import { lstat, open, unlink, rename, link, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertRealPath, downloadDirectory, sanitizeFileName } from "../utils/helpers.js";

export interface DownloadOptions {
  downloadDir: string;
  allowDownloads?: boolean;
  cdnHosts?: string[];
  maxDownloadBytes?: number;
  downloadTimeoutMs?: number;
}

export interface FileMetadata { file_name?: string; size_in_bytes?: number; md5?: string; md5_hash?: string; }

export function validateCdnUrl(input: string, suffixes: string[]): URL {
  const u = new URL(input);
  const allowed = suffixes.some(s => /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(s) && (u.hostname === s || u.hostname.endsWith("." + s)));
  if (u.protocol !== "https:" || u.username || u.password || u.port || !allowed) throw new Error("Download URL is outside the HTTPS CDN allow-list");
  return u;
}

async function existingVerified(target: string, size: number | undefined, md5?: string): Promise<boolean> {
  let st;
  try { st = await lstat(target); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
  await assertRealPath(target);
  if (!st.isFile() || (size !== undefined && st.size !== size)) throw new Error("Existing file failed size verification; remove or rename it explicitly");
  if (md5) {
    const hash = createHash("md5");
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    if (hash.digest("hex") !== md5) throw new Error("Existing file failed MD5 verification");
  }
  return true;
}

export async function safeDownload(options: DownloadOptions, uri: string, metadata: FileMetadata, subdir = "", http: typeof fetch = fetch): Promise<string> {
  const config = {
    allowDownloads: process.env.NEXUS_ALLOW_DOWNLOADS !== "0",
    cdnHosts: (process.env.NEXUS_CDN_HOSTS || "nexusmods.com,nexus-cdn.com").split(",").map(host => host.trim()),
    maxDownloadBytes: Number(process.env.NEXUS_MAX_DOWNLOAD_BYTES || Number.MAX_SAFE_INTEGER),
    downloadTimeoutMs: Number(process.env.NEXUS_DOWNLOAD_TIMEOUT_MS || 3_600_000),
    ...options,
  };
  if (!config.allowDownloads) throw new Error("Downloads are disabled");
  const dir = await downloadDirectory(config.downloadDir, subdir);
  let url = validateCdnUrl(uri, config.cdnHosts);
  // Metadata from the (sometimes very slow) Nexus API is best effort: when it is missing the CDN's
  // own Content-Length is used for verification instead.
  const size = Number.isSafeInteger(metadata.size_in_bytes) && metadata.size_in_bytes! > 0 ? metadata.size_in_bytes : undefined;
  if (size !== undefined && size > config.maxDownloadBytes) throw new Error("File size exceeds NEXUS_MAX_DOWNLOAD_BYTES");
  const digest = metadata.md5 ?? metadata.md5_hash;
  if (digest !== undefined && !/^[a-fA-F0-9]{32}$/.test(digest)) throw new Error("Invalid metadata MD5");
  const md5 = digest?.toLowerCase();
  if (metadata.file_name && size !== undefined) {
    const target = path.join(dir, sanitizeFileName(metadata.file_name));
    if (await existingVerified(target, size, md5)) return `Verified existing file: ${target}`;
  }
  let file: FileHandle | undefined, partial = "";
  let published = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Download timed out")), config.downloadTimeoutMs);
  const signal = controller.signal;
  try {
    let response: Response | undefined;
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await http(url.href, { redirect: "manual", signal, headers: { "Accept-Encoding": "identity" } });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 5) throw new Error("Invalid or excessive CDN redirects");
      url = validateCdnUrl(new URL(location, url).href, config.cdnHosts);
    }
    if (!response?.ok || !response.body || response.status !== 200) {
      await response?.body?.cancel();
      throw new Error(`CDN HTTP ${response?.status}`);
    }
    const announced = response.headers.get("content-length");
    if (announced !== null && size !== undefined && Number(announced) !== size) {
      await response.body.cancel();
      throw new Error("CDN length disagrees with file metadata");
    }
    const expected = size ?? (announced !== null && Number.isSafeInteger(Number(announced)) ? Number(announced) : undefined);
    if (expected !== undefined && expected > config.maxDownloadBytes) { await response.body.cancel(); throw new Error("File size exceeds NEXUS_MAX_DOWNLOAD_BYTES"); }
    // Nexus's supporter CDN uses opaque object IDs in its URLs; the archive name is in the
    // response header. Use the same GET already needed for transfer, without a metadata/HEAD call.
    const disposition = response.headers.get("content-disposition") || "";
    const encodedName = /(?:^|;)\s*filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    const headerName = encodedName ? decodeURIComponent(encodedName.trim()) :
      /(?:^|;)\s*filename=(?:"([^"]+)"|([^;]+))/i.exec(disposition)?.slice(1).find(Boolean)?.trim();
    const name = sanitizeFileName(metadata.file_name || headerName || url.pathname.split("/").pop() || "");
    const target = path.join(dir, name);
    partial = target + ".part";
    try {
      if (await existingVerified(target, expected, md5)) {
        await response.body.cancel();
        return `Verified existing file: ${target}${expected === undefined ? " (size unverified)" : ""}`;
      }
      file = await open(partial, "wx", 0o600); // Never adopt, overwrite or delete someone else's partial.
    } catch (error) { await response.body.cancel(); throw error; }
    let bytes = 0;
    const hash = md5 ? createHash("md5") : undefined;
    const check = new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > config.maxDownloadBytes || (expected !== undefined && bytes > expected)) { done(new Error("Download byte limit exceeded")); return; }
      hash?.update(chunk); done(null, chunk);
    }});
    // Keep handle ownership here; FileHandle streams with autoClose=false can leave
    // pipeline waiting forever for close. Writable serialises complete writes.
    const output = new Writable({ write(chunk, _encoding, done) { file!.writeFile(chunk).then(() => done(), done); } });
    await pipeline(Readable.fromWeb(response.body as any), check, output, { signal });
    if ((expected !== undefined && bytes !== expected) || (md5 && hash!.digest("hex") !== md5)) throw new Error("Downloaded file failed size/MD5 verification");
    await file.sync();
    await file.close();
    await assertRealPath(dir);
    await assertRealPath(partial);
    if (await existingVerified(target, expected, md5)) throw new Error("Destination appeared during download");
    // Publish complete bytes after the final existence/path check. The shared queue
    // prevents this server racing itself. Unix supports atomic no-replace linking.
    if (process.platform === "win32") await rename(partial, target);
    else { await link(partial, target); await unlink(partial); }
    published = true;
    return `Downloaded and verified: ${target} (${bytes} bytes${md5 ? ", MD5 checked" : ""}${size === undefined ? ", size from CDN header" : ""})`;
  } finally {
    clearTimeout(timer);
    await file?.close().catch(() => {});
    if (file && !published) await unlink(partial).catch(() => {});
  }
}
