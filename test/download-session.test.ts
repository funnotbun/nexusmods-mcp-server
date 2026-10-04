import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { WebClient } from "../src/clients/web-client.js";
import { DownloadBrowser } from "../src/clients/download-browser.js";
import type { Config } from "../src/config.js";
import type { CookieEntry } from "../src/utils/types.js";

const root = path.resolve(".test-tmp");
mkdirSync(root, { recursive: true });
const dir = mkdtempSync(path.join(root, "download-session-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const request = { game: "skyrimspecialedition", mod_id: 123, file_id: 456 };
const capture = { kind: "cdn" as const, uri: "https://files.nexus-cdn.com/archive.zip" };
const cookie = { name: "session", value: "test-session", domain: ".nexusmods.com", path: "/" };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function client() {
  const sessionDir = mkdtempSync(path.join(dir, "session-"));
  const web = new WebClient({ cookiesPath: path.join(sessionDir, "cookies.json") } as Config);
  const copied: CookieEntry[][] = [];
  let captures = 0;
  (web as any).browser = { setCookies() {}, markClearOnLaunch() {}, async clearSiteCookies() {}, async close() {} };
  (web as any).downloadBrowser = {
    async setCookies(cookies: CookieEntry[]) { copied.push(cookies); },
    async captureDownload() { captures++; return capture; },
    async clearSiteCookies() {}, async close() {},
  };
  return { web, copied, captures: () => captures };
}

test("an immediate download waits for the one background extraction and copies its session", async () => {
  const { web, copied, captures } = client();
  const extraction = deferred<{ cookies: CookieEntry[]; browser: string }>();
  let reads = 0;
  (web as any).extractCookies = () => { reads++; return extraction.promise; };
  web.init();
  web.init();
  const download = web.captureDownload(request);
  await tick();
  assert.equal(reads, 1);
  assert.equal(captures(), 0);
  assert.deepEqual(copied, []);
  extraction.resolve({ cookies: [cookie], browser: "firefox" });
  assert.deepEqual(await download, capture);
  assert.deepEqual(copied, [[cookie]]);
  assert.deepEqual(web.sessionSource(), { sessionSource: "browser", sessionBrowser: "firefox" });
});

test("empty or failed extraction still lets the download browser handle login", async t => {
  for (const fails of [false, true]) await t.test(fails ? "unreadable store" : "no session", async () => {
    const { web, copied, captures } = client();
    const extraction = deferred<{ cookies: CookieEntry[]; browser: string }>();
    (web as any).extractCookies = () => extraction.promise;
    web.init();
    const download = web.captureDownload(request);
    if (fails) extraction.reject(new Error("test cookie store unavailable"));
    else extraction.resolve({ cookies: [], browser: "none" });
    assert.deepEqual(await download, capture);
    assert.equal(captures(), 1);
    assert.deepEqual(copied, [[]]);
  });
});

test("a saved session skips extraction; a manually supplied session skips an unfinished extraction", async () => {
  const saved = client();
  let reads = 0;
  (saved.web as any).extractCookies = () => { reads++; throw new Error("must not extract"); };
  saved.web.setCookiesFromString("session=saved");
  saved.web.init();
  await saved.web.captureDownload(request);
  assert.equal(reads, 0);
  assert.equal(saved.copied[0][0].value, "saved");

  const manual = client();
  const extraction = deferred<{ cookies: CookieEntry[]; browser: string }>();
  (manual.web as any).extractCookies = () => extraction.promise;
  manual.web.init();
  manual.web.setCookiesFromString("session=manual");
  const download = manual.web.captureDownload(request);
  await tick();
  assert.equal(manual.captures(), 1);
  extraction.resolve({ cookies: [cookie], browser: "firefox" });
  await download;
  assert.equal(manual.copied[0][0].value, "manual");
});

test("logout during extraction keeps the download signed out", async () => {
  const { web, copied } = client();
  const extraction = deferred<{ cookies: CookieEntry[]; browser: string }>();
  (web as any).extractCookies = () => extraction.promise;
  web.init();
  const download = web.captureDownload(request);
  await web.logout();
  extraction.resolve({ cookies: [cookie], browser: "firefox" });
  await download;
  assert.equal(web.hasCookies(), false);
  assert.deepEqual(copied, [[]]);
});

test("a reused download browser finishes installing cookies before capture starts", async () => {
  const { web } = client();
  web.setCookiesFromString("session=manual");
  const installed = deferred<void>();
  let navigation = false;
  const browser = new DownloadBrowser({ humanTimeoutMs: 1000, cdnHosts: ["nexus-cdn.com"] });
  (browser as any).context = { async addCookies(cookies: CookieEntry[]) {
    assert.equal(cookies[0].value, "manual");
    await installed.promise;
  } };
  browser.captureDownload = async () => { navigation = true; return capture; };
  (web as any).downloadBrowser = browser;
  const download = web.captureDownload(request);
  await tick();
  assert.equal(navigation, false);
  installed.resolve();
  assert.deepEqual(await download, capture);
  assert.equal(navigation, true);
});
