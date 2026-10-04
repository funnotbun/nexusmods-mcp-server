import path from "node:path";
import type { BrowserContext, Page } from "patchright";
import type { CookieEntry } from "../utils/types.js";
import { mkdirSync } from "node:fs";
import os from "node:os";
import { validateNxm, type FileRequest, type NxmGrant } from "../utils/nxm.js";
import { validateCdnUrl } from "./safe-download.js";

export interface BrowserDownloadOptions { humanTimeoutMs: number; cdnHosts: string[]; }

const NEXUS_COOKIE_DOMAIN = /(^|\.)nexusmods\.com$/;

const BROWSER_CHANNELS = new Set(["chromium", "chrome", "msedge"]);
function browserChannel(): "chromium" | "chrome" | "msedge" {
  const wanted = process.env.NEXUS_BROWSER_CHANNEL ?? "";
  return (BROWSER_CHANNELS.has(wanted) ? wanted : "chromium") as "chromium" | "chrome" | "msedge";
}

/** Opt-in progress log on stderr; stdout is reserved for MCP. */
const debug = (...parts: unknown[]) => { if (process.env.NEXUS_DEBUG) console.error("[download]", ...parts); };

export class NeedsHumanError extends Error {
  readonly code = "needs_human";
  constructor() { super("needs human: finish login or the site challenge in the dedicated Chromium window, then retry"); }
}

export function challengeInPage(): boolean {
  return /just a moment|verify.*human|captcha|attention required/i.test(document.title) ||
    !!document.querySelector('form#challenge-form, #challenge-running, .cf-turnstile, [data-sitekey], iframe[src*="challenges.cloudflare.com"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [role="dialog"][aria-label*="consent" i], #onetrust-banner-sdk');
}

/** Self-contained browser function. Only advertising overlays are eligible; a bot
 *  marker anywhere in the page or an open shadow root freezes ALL DOM manipulation. */
export function prepareDownloadPage(): { needsHuman: boolean; removed: number } {
  const bot = /challenges\.cloudflare\.com|cf[-_]turnstile|cf[-_]chl|challenge-platform|challenge-form|challenge-running|just a moment|verify.{0,20}human|hcaptcha|recaptcha|captcha/i;
  const nodes: Element[] = [];
  const walk = (root: Document | ShadowRoot) => {
    for (const el of Array.from(root.querySelectorAll("*"))) { nodes.push(el); if (el.shadowRoot) walk(el.shadowRoot); }
  };
  walk(document);
  const protectedNode = (el: Element) => bot.test(Array.from(el.attributes).map(a => a.name + "=" + a.value).join(" ")) ||
    (el.matches("iframe, form, [role='dialog']") && bot.test(el.textContent || ""));
  if (bot.test(document.title) || bot.test(document.body?.innerText || document.body?.textContent || "") || nodes.some(protectedNode)) return {needsHuman:true,removed:0};
  let removed = 0;
  for (const el of nodes) {
    // Explicit per-candidate check, including descendants and ancestors: no bot
    // iframe or its wrapper can ever be removed with an advertising container.
    if (protectedNode(el) || Array.from(el.querySelectorAll("*")).some(protectedNode)) continue;
    let parent = el.parentElement, protectedParent = false;
    while (parent) { if (protectedNode(parent)) { protectedParent = true; break; } parent = parent.parentElement; }
    if (protectedParent) continue;
    const adFrame = el.tagName === "IFRAME" && /(?:doubleclick\.net|googlesyndication\.com|adnxs\.com)/i.test(el.getAttribute("src") || "");
    if (adFrame || el.matches(".ad-overlay, [data-ad-overlay], #advertising-overlay")) { el.remove(); removed++; }
  }
  return {needsHuman:false,removed};
}

/** Runs with prepareDownloadPage in one browser evaluation, including shadow DOM controls. */
export function clickDownloadControl(): string {
  const controls: HTMLElement[] = [];
  const walk = (root: Document | ShadowRoot) => {
    for (const el of Array.from(root.querySelectorAll("*"))) {
      if (el.matches("button, a, [role='button']")) controls.push(el as HTMLElement);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  const label = (el: HTMLElement) => {
    if (el.id === "slowDownloadButton") return "slow download";
    const names = [el.getAttribute("aria-label"), el.textContent,
      ...Array.from(el.querySelectorAll("span")).map(span => span.textContent)];
    return names.map(name => (name || "").replace(/\s+/g, " ").trim().toLowerCase())
      .find(name => /^(slow download|manual download|mod manager download)$/.test(name));
  };
  const clicked: WeakMap<HTMLElement, number> = (window as any).__nexusMcpClicks ??= new WeakMap();
  for (const wanted of ["slow download", "manual download", "mod manager download"]) {
    const matches = controls.filter(el => label(el) === wanted && !(el as HTMLButtonElement).disabled && el.getAttribute("aria-disabled") !== "true");
    // Prefer the visible desktop/mobile variant, but ordinary hidden controls are allowed.
    const target = matches.find(el => el.getClientRects().length > 0) ?? matches[0];
    if (!target) continue;
    const now = Date.now(), last = clicked.get(target);
    if (last !== undefined && now - last < 1500) return "waiting for " + wanted;
    clicked.set(target, now);
    target.scrollIntoView({block:"center"});
    target.click();
    return "clicked " + wanted;
  }
  return "waiting for download control";
}

/** Visible, isolated Chromium only. No user-agent overrides, stealth configuration,
 *  captcha interaction, external browser profiles or automatic challenge retries. */
export class DownloadBrowser {
  private context: BrowserContext | null = null;
  private initPromise: Promise<void> | null = null;
  private downloadPage: Page | null = null;
  private cookies: CookieEntry[] = [];
  private clearOnLaunch = false;
  constructor(private config: BrowserDownloadOptions) {}

  setCookies(cookies: CookieEntry[]): void {
    this.cookies = cookies.filter(c => NEXUS_COOKIE_DOMAIN.test(c.domain));
    this.context?.addCookies(this.cookies).catch(() => {});
  }
  async clearSiteCookies(): Promise<void> {
    this.cookies = [];
    this.clearOnLaunch = true;
    if (this.context) {
      await this.context.clearCookies({domain:NEXUS_COOKIE_DOMAIN});
      this.clearOnLaunch = false;
    }
  }
  private async init(): Promise<void> {
    const { chromium } = await import("patchright");
    const profileRoot = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "nexusmods-mcp") : path.join(os.homedir(), ".nexusmods-mcp");
    mkdirSync(profileRoot, {recursive:true});
    // A second process must fail on the profile lock, not silently use a different session.
    this.context = await chromium.launchPersistentContext(path.join(profileRoot, "chromium-profile"), {
      // NEXUS_BROWSER_CHANNEL=msedge|chrome reuses an installed browser binary (still in the isolated profile above).
      headless: false, channel: browserChannel(), viewport: null, args: ["--lang=en-US"],
      downloadsPath: path.join(profileRoot, "browser-downloads"), acceptDownloads: false,
    });
    // Prevent the protocol from being handled by browser routing where supported.
    // captureNxm also watches Chromium's navigation event and captures page-level launches.
    await this.context.route("nxm://**", route => route.abort());
    if (this.clearOnLaunch) { await this.context.clearCookies({domain:NEXUS_COOKIE_DOMAIN}); this.clearOnLaunch = false; }
    if (this.cookies.length) await this.context.addCookies(this.cookies);
  }
  private async ensureInit(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.init().catch(error => { this.initPromise = null; throw error; });
    await this.initPromise;
  }
  private async newPage(): Promise<Page> {
    await this.ensureInit();
    const page = await this.context!.newPage();
    await page.addInitScript("globalThis.__name = globalThis.__name || ((f) => f);");
    return page;
  }
  async captureDownload(request: FileRequest): Promise<BrowserCapture> {
    if (this.downloadPage && !this.downloadPage.isClosed()) await this.downloadPage.close();
    this.downloadPage = await this.newPage();
    return captureBrowserDownload(this.downloadPage, request, this.config);
  }
  async close(): Promise<void> {
    await this.initPromise?.catch(() => {});
    const ctx = this.context; this.context = null; this.initPromise = null; this.downloadPage = null;
    await ctx?.close();
  }
}

export type BrowserCapture = { kind: "cdn"; uri: string } | { kind: "nxm"; grant: NxmGrant };

/** Mirror Wabbajack's browser-download interception: ordinary visible clicks produce
 *  a CDN request; cancel the browser transfer, then stream that URL anonymously with
 *  safeDownload. Intercepting before the CDN request prevents browser cookies from
 *  leaking to it. NXM navigation is an alternate result, not a synthetic site request. */
export async function captureBrowserDownload(page: Page, request: FileRequest, config: BrowserDownloadOptions): Promise<BrowserCapture> {
  const deadline = Date.now() + config.humanTimeoutMs;
  let result: BrowserCapture | undefined, invalid: Error | undefined, armed = false;
  let wake = () => {};
  const captureNxm = (url: string) => {
    if (!url.startsWith("nxm:")) return;
    try { const grant = validateNxm(url, request); result = {kind:"nxm",grant}; }
    catch { invalid = new Error("NXM navigation failed validation"); }
    wake();
  };
  const captureCdn = (url: string) => {
    try { result = {kind:"cdn",uri:validateCdnUrl(url,config.cdnHosts).href}; }
    catch { invalid = new Error("Browser download is outside the HTTPS CDN allow-list"); }
    wake();
  };
  const context = page.context();
  const cdp = await context.newCDPSession(page);
  const requested = ({url}: {url:string}) => {
    if (url.startsWith("nxm:")) { captureNxm(url); void cdp.send("Page.stopLoading").catch(() => {}); }
  };
  const paused = async (event: {requestId:string;request:{url:string}}) => {
    captureNxm(event.request.url);
    await cdp.send("Fetch.failRequest", {requestId:event.requestId,errorReason:"Aborted"}).catch(() => {});
  };
  const downloaded = async (download: any) => {
    await download.cancel().catch(() => {});
    captureCdn(download.url());
  };
  const webHosts = new Set(["www.nexusmods.com","forums.nexusmods.com","users.nexusmods.com"]);
  const routeHandler = async (route: any) => {
    const req = route.request(), url = req.url();
    if (url.startsWith("nxm:")) { captureNxm(url); await route.abort(); return; }
    const parsed = new URL(url);
    // Verification traffic (including iframe NAVIGATIONS) is never intercepted,
    // aborted or modified. An iframe navigation is not a file download.
    const verification = /challenges\.cloudflare\.com|cf[-_]turnstile|cf[-_]chl|challenge-platform|hcaptcha|recaptcha|captcha/i.test(url);
    if (verification) { await route.fallback(); return; }
    const mainNavigation = req.isNavigationRequest() && !req.frame().parentFrame();
    // Cancel the archive/CDN navigation BEFORE network I/O. Subsequent redirects are
    // followed only by safeDownload with per-hop URL validation and no session headers.
    if (armed && (mainNavigation && !webHosts.has(parsed.hostname) ||
        /\.(?:zip|7z|rar|tar|gz|bz2|xz|fomod)(?:$|\?)/i.test(url))) {
      captureCdn(url); await route.abort(); return;
    }
    await route.fallback();
  };
  cdp.on("Page.frameRequestedNavigation",requested);
  cdp.on("Fetch.requestPaused",paused);
  page.on("download",downloaded);
  await cdp.send("Page.enable");
  await cdp.send("Fetch.enable", {patterns:[{urlPattern:"nxm://*",requestStage:"Request"}]});
  // Each capture has its own page/binding; timed-out pages stay open for the human.
  await page.exposeBinding("__captureNxm", (_source, url:string) => captureNxm(url)).catch(error => {
    if (!String(error).includes("already")) throw error;
  });
  await page.addInitScript(() => {
    const capture = (url:unknown): boolean => {
      if (typeof url !== "string" || !url.startsWith("nxm:")) return false;
      void (window as any).__captureNxm(url); return true;
    };
    const original = window.open;
    window.open = function(url, ...args) { if (capture(String(url))) return null; return original.call(window, url, ...args); };
    document.addEventListener("click", event => {
      const anchor = event.composedPath().find(e => e instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined;
      if (anchor && capture(anchor.href)) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
  });
  await context.route("**/*",routeHandler);
  try {
    armed = true;
    await page.goto(`https://www.nexusmods.com/${request.game}/mods/${request.mod_id}?tab=files&file_id=${request.file_id}`, {
      waitUntil:"commit",timeout:Math.min(30_000,config.humanTimeoutMs),
    }).catch(e => { if (e.name !== "TimeoutError") throw e; });
    await page.bringToFront();
    let lastState = "";
    while (Date.now() < deadline) {
      if (invalid) throw invalid;
      if (result) return result;
      if (new URL(page.url()).hostname === "www.nexusmods.com") {
        // Init scripts and locator.evaluate use different worlds in Patchright. Serialize both
        // functions into the same evaluation so the check and click share a task and no globals.
        const state = await page.evaluate<string>(`(() => {
          globalThis.__name = globalThis.__name || ((f) => f);
          if ((${challengeInPage.toString()})() || (${prepareDownloadPage.toString()})().needsHuman) return "needs human";
          return (${clickDownloadControl.toString()})();
        })()`).catch(error => {
          if (/Execution context was destroyed|Cannot find context/i.test(String(error))) return "navigating";
          throw error;
        });
        if (state !== lastState) { debug(state); lastState = state; }
      }
      if (invalid) throw invalid;
      if (result) return result;
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); wake = () => {}; resolve(); };
        const timer = setTimeout(finish, Math.min(100, Math.max(1, deadline - Date.now())));
        wake = finish;
      });
    }
    throw new NeedsHumanError();
  } finally {
    armed = false;
    page.off("download",downloaded);
    cdp.off("Page.frameRequestedNavigation",requested); cdp.off("Fetch.requestPaused",paused);
    await cdp.send("Fetch.disable").catch(() => {}); await cdp.detach().catch(() => {});
    await context.unroute("**/*",routeHandler).catch(() => {});
  }
}
