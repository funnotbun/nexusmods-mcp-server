import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Executed ONLY by the owner when launching. No credentials are read during build/tests.
export const credentialScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NexusCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Credential {
    public UInt32 Flags, Type;
    public IntPtr TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist, AttributeCount;
    public IntPtr Attributes, TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr credential);
}
'@
$ptr = [IntPtr]::Zero
try {
  if (-not [NexusCredential]::CredRead('ModOrganizer2_APIKEY', 1, 0, [ref]$ptr)) { exit 2 }
  $entry = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][NexusCredential+Credential])
  $bytes = New-Object byte[] $entry.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($entry.CredentialBlob, $bytes, 0, $bytes.Length)
  if ($bytes.Length -gt 1 -and $bytes[1] -eq 0) { $key = [Text.Encoding]::Unicode.GetString($bytes) }
  else { $key = [Text.Encoding]::UTF8.GetString($bytes) }
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  [Console]::Write($key.TrimEnd([char]0))
} finally { if ($ptr -ne [IntPtr]::Zero) { [NexusCredential]::CredFree($ptr) } }
`;

export function obtainApiKey(env = process.env, platform = process.platform, execute = execFileSync) {
  if (env.NEXUS_API_KEY) return env.NEXUS_API_KEY;
  if (platform !== "win32") throw new Error("Set NEXUS_API_KEY; Credential Manager is Windows-only");
  try {
    const key = execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", credentialScript], {
      encoding:"utf8", stdio:["ignore","pipe","pipe"], windowsHide:true, timeout:15_000,
    }).trim();
    if (!key || /[\r\n\x00]/.test(key)) throw new Error("Invalid credential");
    return key;
  } catch { throw new Error("Could not read ModOrganizer2_APIKEY. Set NEXUS_API_KEY in the launch environment."); }
}

export function redactor(key) {
  const variants = new Set([key,encodeURIComponent(key),JSON.stringify(key).slice(1,-1)]);
  return text => {
    for (const variant of variants) if (variant) text = text.split(variant).join("[REDACTED]");
    return text;
  };
}

export function launch() {
  if (!process.env.NEXUS_DOWNLOAD_DIR || !path.isAbsolute(process.env.NEXUS_DOWNLOAD_DIR)) throw new Error("Set NEXUS_DOWNLOAD_DIR to an existing absolute local directory");
  const key = obtainApiKey();
  const redact = redactor(key);
  const root = path.dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, [path.join(root,"build","index.js")], {
    cwd:root, windowsHide:true, stdio:["inherit","pipe","pipe"],
    env:{...process.env,NEXUS_API_KEY:key},
  });
  // Line buffering also redacts keys split across child output chunks; stdout remains MCP stdio.
  for (const [source,destination] of [[child.stdout,process.stdout],[child.stderr,process.stderr]]) {
    createInterface({input:source,crlfDelay:Infinity}).on("line", line => destination.write(redact(line) + "\n"));
  }
  child.on("error", () => { process.stderr.write("Could not start the built Nexus MCP server\n"); process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
  for (const signal of ["SIGINT","SIGTERM"]) process.on(signal, () => child.kill(signal));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { launch(); } catch (error) { process.stderr.write(String(error.message) + "\n"); process.exitCode = 1; }
}
