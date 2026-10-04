import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { CookieExtractor } from "../src/clients/cookie-extractor.js";
import { createServer } from "../src/server.js";
import { NexusApiClient } from "../src/clients/nexus-api.js";
import { WebClient } from "../src/clients/web-client.js";
import { isWithinDir } from "../src/utils/helpers.js";

const root = path.resolve(".test-tmp");mkdirSync(root,{recursive:true});
const dir = mkdtempSync(path.join(root,"options-"));
after(()=>{assert.ok(isWithinDir(root,dir));rmSync(dir,{recursive:true,force:true});});
const config = {...loadConfig(),authDir:dir,cookiesPath:path.join(dir,"cookies.json"),readOnly:false,allowDownloads:true};
test("default capabilities retain writes, cookie import and upload tools; opt-in gates are scoped",async t=>{
  t.mock.method(CookieExtractor.prototype,"extractCookies",async()=>({cookies:[],browser:"none"}));
  for (const readOnly of [false,true]) {
    const {server,webClient}=await createServer({...config,readOnly});
    const names=Object.keys((server as any)._registeredTools);
    for (const name of ["track_mod","endorse_mod","upload_file_version","pm_send","forum_reply"]) assert.equal(names.includes(name),!readOnly,name);
    for (const name of ["web_set_cookies","web_login","get_mod_files","download_file"]) assert.ok(names.includes(name),name);
    const instructions=(server as any).server._instructions;
    for (const topic of ["Upload a new version","Private messages","Bug reports","default browser"]) assert.ok(instructions.includes(topic),topic);
    await server.close();await webClient.close();
  }
});
test("read-only guards reject writes before transport while normal API writes still work",async t=>{
  let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;return new Response('{}',{headers:{"content-type":"application/json"}});});
  await new NexusApiClient("test-key",false).v1("POST","/write",{});assert.equal(calls,1);
  await assert.rejects(new NexusApiClient("test-key",true).v1("POST","/write",{}),/READ_ONLY/);assert.equal(calls,1);
  const web=new WebClient({...config,readOnly:true});
  await assert.rejects(web.sessionGraphql("Write","mutation { write }",{}),/Only read/);
  await web.close();
});
