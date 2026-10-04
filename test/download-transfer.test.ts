import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { safeDownload, validateCdnUrl } from "../src/clients/safe-download.js";
import { isWithinDir } from "../src/utils/helpers.js";

const root = path.resolve(".test-tmp"); mkdirSync(root, {recursive:true});
const dir = mkdtempSync(path.join(root,"transfer-"));
after(() => { assert.ok(isWithinDir(root,dir)); rmSync(dir,{recursive:true,force:true}); });
const config = {downloadDir:dir,allowDownloads:true,cdnHosts:["nexus-cdn.com"],maxDownloadBytes:1024,downloadTimeoutMs:1000};
const uri = "https://supporter-files.nexus-cdn.com/object-id";
const metadata = {file_name:"archive.zip",size_in_bytes:3,md5:createHash("md5").update("abc").digest("hex")};

test("transfers use CDN archive filenames and validate existing bytes without downloading again", async () => {
  let cancelled = false;
  const http = async () => new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode("abc"));c.close();},cancel(){cancelled=true;}}),{headers:{"content-length":"3","content-disposition":'attachment; filename="Mod archive.zip"'}});
  assert.match(await safeDownload(config,uri,{},"named",http),/Downloaded and verified/);
  const target = path.join(dir,"named","Mod archive.zip");
  assert.equal(readFileSync(target,"utf8"),"abc");
  assert.match(await safeDownload(config,uri,{},"named",http),/Verified existing/);
  assert.equal(cancelled,true);
  writeFileSync(target,"x");
  await assert.rejects(safeDownload(config,uri,{},"named",http),/size verification/);
});
test("checksum, byte-count and redirect failures leave no owned partial or final archive", async () => {
  for (const [index,body] of ["ab","xyz","abcd"].entries()) {
    await assert.rejects(safeDownload(config,uri,metadata,`invalid-${index}`,async()=>new Response(body)));
    assert.equal(existsSync(path.join(dir,`invalid-${index}`,"archive.zip.part")),false);
    assert.equal(existsSync(path.join(dir,`invalid-${index}`,"archive.zip")),false);
  }
  await assert.rejects(safeDownload(config,uri,metadata,"redirect",async()=>new Response(null,{status:302,headers:{location:"https://unrelated.example/archive.zip"}})),/allow-list/);
  assert.throws(()=>validateCdnUrl("https://nexus-cdn.com.unrelated.example/archive.zip",config.cdnHosts));
});
test("existing exact metadata avoids network; stale partial files are retained", async () => {
  const http = async () => new Response("abc",{headers:{"content-length":"3"}});
  await safeDownload(config,uri,metadata,"existing",http);
  assert.match(await safeDownload(config,uri,metadata,"existing",async()=>{throw new Error("unnecessary request");}),/Verified existing/);
  mkdirSync(path.join(dir,"stale"));
  const partial = path.join(dir,"stale","archive.zip.part"); writeFileSync(partial,"old");
  await assert.rejects(safeDownload(config,uri,metadata,"stale",http),/EEXIST/);
  assert.equal(readFileSync(partial,"utf8"),"old");
});
