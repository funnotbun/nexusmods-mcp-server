export interface FileRequest { game: string; mod_id: number; file_id: number; dest_subdir?: string; }
export interface NxmGrant { key: string; expires: number; userId: string; }

export function validateFileRequest(request: FileRequest): void {
  if (!/^[a-z0-9]+$/.test(request.game) || !Number.isSafeInteger(request.mod_id) || request.mod_id <= 0 ||
      !Number.isSafeInteger(request.file_id) || request.file_id <= 0) throw new Error("Invalid game/mod/file IDs");
}
export function validateNxm(input: string, request: FileRequest, now = Date.now()): NxmGrant {
  validateFileRequest(request);
  const u = new URL(input);
  if (u.protocol !== "nxm:" || u.hostname !== request.game || u.username || u.password || u.port || u.hash ||
      u.pathname !== `/mods/${request.mod_id}/files/${request.file_id}`) throw new Error("NXM link does not match the requested file");
  for (const name of ["key", "expires", "user_id"]) if (u.searchParams.getAll(name).length !== 1) throw new Error("Missing or duplicate NXM grant parameter");
  const key = u.searchParams.get("key")!, expiry = u.searchParams.get("expires")!, userId = u.searchParams.get("user_id")!;
  const expires = Number(expiry);
  if (!key.trim() || /[\x00-\x1f]/.test(key) || !/^\d+$/.test(expiry) || !Number.isSafeInteger(expires) || expires <= now / 1000 || !/^[1-9]\d*$/.test(userId)) {
    throw new Error("Invalid or expired NXM grant");
  }
  return { key, expires, userId };
}
