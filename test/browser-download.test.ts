import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { JSDOM } from "jsdom";
import { loadConfig } from "../src/config.js";
import { prepareDownloadPage, clickDownloadControl, captureBrowserDownload, NeedsHumanError } from "../src/clients/download-browser.js";
import { DownloadQueue, ModDownloader, registerDownloadTools } from "../src/tools/downloads.js";
import { isWithinDir } from "../src/utils/helpers.js";
import { validateNxm } from "../src/utils/nxm.js";
import { WebClient } from "../src/clients/web-client.js";
const root=path.resolve(".test-tmp");mkdirSync(root,{recursive:true});
const dir=mkdtempSync(path.join(root,"browser-download-"));
after(()=>{assert.ok(isWithinDir(root,dir));rmSync(dir,{recursive:true,force:true});});
globalThis.fetch = async () => { throw new Error("Unexpected live HTTP"); };
const config={...loadConfig(),downloadDir:dir,allowDownloads:true,cdnHosts:["nexusmods.com","nexus-cdn.com"],humanTimeoutMs:300000};
const request={game:"skyrimspecialedition",mod_id:123,file_id:456};
const uri="https://files.nexus-cdn.com/archive.zip";
const metadata={file_name:"archive.zip",size_in_bytes:3};
const http=async()=>new Response("abc",{headers:{"content-length":"3"}});
test("NXM fallback grants must match the requested file and have a future expiry",()=>{
  const grant="nxm://skyrimspecialedition/mods/123/files/456?key=test-grant&expires=2000000000&user_id=42";
  assert.equal(validateNxm(grant,request).key,"test-grant");
  assert.throws(()=>validateNxm(grant.replace("files/456","files/999"),request));
  assert.throws(()=>validateNxm(grant.replace("2000000000","1"),request));
});
test("logout clears the download session too, including the next capture after logout",async()=>{
  const web = new WebClient({...config,authDir:dir,cookiesPath:path.join(dir,"logout-cookies.json")});
  let cleared=0,closed=0;
  (web as any).browser={async clearSiteCookies(){},async close(){}};
  (web as any).downloadBrowser={setCookies(){},async clearSiteCookies(){cleared++;},async close(){closed++;},async captureDownload(){return {kind:"cdn",uri};}};
  await web.logout();assert.equal(cleared,1);assert.equal(closed,1);
  await web.captureDownload(request);assert.equal(cleared,2);
  await web.close();
});
test("Turnstile iframe and its advertising wrapper are left untouched", () => {
  const doc=new JSDOM('<div class="ad-overlay"><iframe src="https://challenges.cloudflare.com/turnstile/v0/widget"></iframe></div><iframe src="https://ads.doubleclick.net/ad"></iframe>').window.document;
  const previous=(globalThis as any).document;(globalThis as any).document=doc;
  try {assert.deepEqual(prepareDownloadPage(),{needsHuman:true,removed:0});assert.equal(doc.querySelectorAll("iframe").length,2);assert.ok(doc.querySelector(".ad-overlay iframe"));}
  finally {(globalThis as any).document=previous;}
});
test("ordinary advertising overlays can be removed without touching page content", () => {
  const doc=new JSDOM('<main><button>Slow download</button></main><div class="ad-overlay"></div><iframe src="https://ads.doubleclick.net/ad"></iframe>').window.document;
  const previous=(globalThis as any).document;(globalThis as any).document=doc;
  try {assert.deepEqual(prepareDownloadPage(),{needsHuman:false,removed:2});assert.ok(doc.querySelector("button"));}
  finally {(globalThis as any).document=previous;}
});
test("queue serialises concurrent calls, waits after failure and honours custom delay", async () => {
  let now=0,active=0;const waits:number[]=[];
  const queue=new DownloadQueue(()=>now,async ms=>{waits.push(ms);now+=ms;},4000);
  const tasks=[0,1,2].map(i=>queue.run(async()=>{assert.equal(active++,0);await Promise.resolve();active--;if(i===1)throw new Error("mock failure");return i;}));
  const results=await Promise.allSettled(tasks);assert.equal(results[1].status,"rejected");assert.deepEqual(waits,[4000,4000]);
});
test("batch input cap is configurable", () => {
  const previous = process.env.NEXUS_DOWNLOAD_BATCH_LIMIT;
  process.env.NEXUS_DOWNLOAD_BATCH_LIMIT = "2";
  try {
  const tools:any={};registerDownloadTools({registerTool(name:string,opts:any){tools[name]=opts;}} as any,{} as any,{} as any,config);
  assert.equal(tools.download_mod_files.inputSchema.files.safeParse([request,request]).success,true);
  assert.equal(tools.download_mod_files.inputSchema.files.safeParse([request,request,request]).success,false);
  } finally { if (previous === undefined) delete process.env.NEXUS_DOWNLOAD_BATCH_LIMIT; else process.env.NEXUS_DOWNLOAD_BATCH_LIMIT = previous; }
});

function mockedPage(kind:"cdn"|"nxm"|"human") {
  const handlers:any={},cdpHandlers:any={};let route:any,clicks=0,aborted=0;
  const dom = new JSDOM(kind === "human" ? '<title>Just a moment</title><button>Slow download</button>' : '<mod-file-download></mod-file-download>', {runScripts:"outside-only"});
  if (kind !== "human") dom.window.document.querySelector("mod-file-download")!.attachShadow({mode:"open"}).innerHTML = '<button id="slowDownloadButton"><span>Slow download</span><span>2 MB/s</span></button>';
  const button = kind === "human" ? dom.window.document.querySelector("button")! : dom.window.document.querySelector("mod-file-download")!.shadowRoot!.querySelector("button")!;
  button.scrollIntoView = () => {};
  const grant="nxm://skyrimspecialedition/mods/123/files/456?key=fallback-key&expires=2000000000&user_id=42";
  const context={async route(_pattern:string,fn:any){route=fn;},async unroute(){},async newCDPSession(){return {on(name:string,fn:any){cdpHandlers[name]=fn;},off(){},async send(){},async detach(){}};}};
  button.onclick = () => {clicks++;if(kind==="nxm")cdpHandlers["Page.frameRequestedNavigation"]({url:grant});else if(kind==="cdn")void route({request(){return {url:()=>uri,isNavigationRequest:()=>true,frame:()=>({parentFrame:()=>null})};},async abort(){aborted++;}});};
  // Init scripts intentionally do not share evaluate's window, matching Patchright's worlds.
  const page:any={context:()=>context,on(name:string,fn:any){handlers[name]=fn;},off(){},async exposeBinding(){},async addInitScript(){},async goto(_url:string,opts:any){assert.equal(opts.waitUntil,"commit");},async bringToFront(){},url:()=>"https://www.nexusmods.com/x",async evaluate(source:string){return dom.window.eval(source);}};
  return {page,counts:()=>({clicks,aborted})};
}
test("browser clicks shadow controls without init-script globals or waiting for DOMContentLoaded, captures CDN/NXM", async () => {
  const cdn=mockedPage("cdn");assert.deepEqual(await captureBrowserDownload(cdn.page,request,{...config,humanTimeoutMs:2000}),{kind:"cdn",uri});assert.ok(cdn.counts().aborted>0);
  const nxm=mockedPage("nxm");const result=await captureBrowserDownload(nxm.page,request,{...config,humanTimeoutMs:2000});assert.equal(result.kind,"nxm");
});
test("download controls retry after mounting, prefer slow download, and respect the countdown", () => {
  const dom = new JSDOM('<button>Manual download</button><mod-file-download></mod-file-download>', {runScripts:"outside-only"});
  const shadow = dom.window.document.querySelector("mod-file-download")!.attachShadow({mode:"open"});
  shadow.innerHTML = '<button disabled><span>Slow download</span><span>2 MB/s</span></button>';
  const slow = shadow.querySelector("button")!;
  const manual = dom.window.document.querySelector("button")!;
  let slowClicks = 0, manualClicks = 0, now = 1000;
  slow.scrollIntoView = manual.scrollIntoView = () => {};
  slow.onclick = () => { slowClicks++; };
  manual.onclick = () => { manualClicks++; };
  dom.window.Date.now = () => now;
  const click = () => dom.window.eval(`globalThis.__name = f => f; (${clickDownloadControl.toString()})()`);
  assert.equal(click(), "clicked manual download");
  assert.equal(slowClicks, 0);
  slow.disabled = false;
  assert.equal(click(), "clicked slow download");
  assert.equal(click(), "waiting for slow download");
  now += 1500;
  assert.equal(click(), "clicked slow download");
  assert.equal(slowClicks, 2);
  assert.equal(manualClicks, 1);
});
test("human challenge returns needs_human by deadline without clicking", async () => {
  const mock=mockedPage("human");await assert.rejects(captureBrowserDownload(mock.page,request,{...config,humanTimeoutMs:20}),NeedsHumanError);assert.equal(mock.counts().clicks,0);
});
test("browser capture and NXM fallback both use verified anonymous transfers", async t => {
  t.mock.method(globalThis,"fetch",async()=>http());
  for(const flow of ["cdn","nxm"]){
    const calls:string[]=[];
    const api:any={async v1(_method:string,url:string){calls.push(url);if(url==="/users/validate")return {is_premium:flow==="premium",user_id:42};if(url.includes("download_link"))return [{URI:uri}];return metadata;}};
    const web:any={async captureDownload(){return flow!=="nxm"?{kind:"cdn",uri}:{kind:"nxm",grant:{key:"grant",expires:2000000000,userId:"42"}};}};
    const downloader=new ModDownloader(api,web,config);assert.match(await downloader.download({...request,dest_subdir:`flow-${flow}`}),/verified/i);
    assert.equal(calls.some(p=>p.includes("download_link")),flow!=="cdn");if(flow==="nxm")assert.ok(calls.some(p=>p.includes("key=grant&expires=")));
  }
});
