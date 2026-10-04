// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

import { APP_NAME, PKG_VERSION } from "../config.js";
import { assertQuery } from "../utils/graphql.js";
import { redact, registerSecret } from "../utils/secrets.js";

const V1_BASE = "https://api.nexusmods.com/v1";
const V2_GRAPHQL = "https://api.nexusmods.com/v2/graphql";
const V3_BASE = "https://api.nexusmods.com/v3";

export interface RateLimit {
  hourlyRemaining?: number;
  dailyRemaining?: number;
  hourlyLimit?: number;
  dailyLimit?: number;
}

export class NexusApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(redact(message));
  }
}

/** Native-HTTP client for the official Nexus Mods APIs: v1 REST, v2 GraphQL, v3 (uploads).
 *  Every request carries Application-Name / Application-Version (required by Nexus policy). */
export class NexusApiClient {
  readonly rateLimit: RateLimit = {};

  constructor(private apiKey: string, private readOnly = process.env.NEXUS_READ_ONLY === "1") { registerSecret(apiKey); }

  hasKey(): boolean {
    return !!this.apiKey;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Accept: "application/json",
      "Application-Name": APP_NAME,
      "Application-Version": PKG_VERSION,
      "User-Agent": `${APP_NAME}/${PKG_VERSION}`,
      ...(this.apiKey ? { apikey: this.apiKey } : {}),
      ...extra,
    };
  }

  private readRateLimit(res: Response): void {
    const num = (h: string) => {
      const v = res.headers.get(h);
      return v === null ? undefined : Number(v);
    };
    const hr = num("x-rl-hourly-remaining");
    const dr = num("x-rl-daily-remaining");
    if (hr !== undefined) this.rateLimit.hourlyRemaining = hr;
    if (dr !== undefined) this.rateLimit.dailyRemaining = dr;
    const hl = num("x-rl-hourly-limit");
    const dl = num("x-rl-daily-limit");
    if (hl !== undefined) this.rateLimit.hourlyLimit = hl;
    if (dl !== undefined) this.rateLimit.dailyLimit = dl;
  }

  rateLimitText(): string {
    const { hourlyRemaining: h, dailyRemaining: d } = this.rateLimit;
    if (h === undefined && d === undefined) return "";
    return `rate limit remaining: hourly ${h ?? "?"}, daily ${d ?? "?"}`;
  }

  private requireKey(): void {
    if (!this.apiKey) {
      throw new NexusApiError(
        "NEXUS_API_KEY is not set. Get a personal key at https://www.nexusmods.com/settings/api-keys and put it in .env (or run `npm run setup`).",
        401,
      );
    }
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    init = { ...init, redirect: "error", signal: AbortSignal.timeout(Number(process.env.NEXUS_API_TIMEOUT_MS) || 90_000) };
    let res = await fetch(url, init);
    this.readRateLimit(res);
    // Reads (GET, GraphQL queries) back off once on 429/503: Retry-After (≤ 30 s) else 2 s.
    // Writes are never retried.
    let isRead = (init.method ?? "GET") === "GET";
    if (url === V2_GRAPHQL) {
      try { assertQuery(JSON.parse(String(init.body)).query); isRead = true; }
      catch { isRead = false; }
    }
    if ((res.status === 429 || res.status === 503) && isRead) {
      const wait = Math.min(Number(res.headers.get("retry-after")) || 2, 30) * 1000;
      await res.body?.cancel().catch(() => undefined);
      await new Promise((r) => setTimeout(r, wait));
      res = await fetch(url, init);
      this.readRateLimit(res);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let detail = body.slice(0, 500);
      try {
        const j = JSON.parse(body);
        detail = j.message || j.detail || j.title || detail;
      } catch {
        // not JSON
      }
      const rl = this.rateLimitText();
      const hint =
        res.status === 429
          ? " Rate limit exceeded (hourly quota resets on the hour, daily quota at 00:00 GMT)."
          : res.status === 401
            ? " Check NEXUS_API_KEY."
            : "";
      throw new NexusApiError(
        `HTTP ${res.status} ${init.method || "GET"} ${url.replace(/\?.*$/, "")}: ${detail}${hint}${rl ? ` (${rl})` : ""}`,
        res.status,
      );
    }
    return res;
  }

  // ── v1 REST ────────────────────────────────────────────────────

  async v1<T = any>(method: "GET" | "POST" | "DELETE", pathAndQuery: string, body?: unknown): Promise<T> {
    if (this.readOnly && method !== "GET") throw new Error("NEXUS_READ_ONLY blocks account writes");
    this.requireKey();
    const res = await this.send(`${V1_BASE}${pathAndQuery}`, {
      method,
      headers: this.headers(body !== undefined ? { "Content-Type": "application/json" } : undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  // ── v2 GraphQL (read queries work without a key) ────────────────

  async graphql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
    if (this.readOnly) assertQuery(query);
    const res = await this.send(V2_GRAPHQL, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ query, variables: variables ?? {} }),
    });
    const json: any = await res.json();
    if (json.errors?.length && !json.data) {
      throw new NexusApiError(`GraphQL: ${json.errors.map((e: any) => e.message).join("; ")}`, 400);
    }
    if (json.errors?.length) {
      // Partial data: surface errors but keep data usable.
      console.error(`[nexus-api] GraphQL partial errors: ${json.errors.map((e: any) => e.message).join("; ")}`);
    }
    return json.data as T;
  }

  // ── v3 REST (uploads, mod files) ───────────────────────────────

  async v3<T = any>(method: "GET" | "POST" | "PATCH", pathAndQuery: string, body?: unknown): Promise<T> {
    if (this.readOnly && method !== "GET") throw new Error("NEXUS_READ_ONLY blocks account writes");
    this.requireKey();
    const res = await this.send(`${V3_BASE}${pathAndQuery}`, {
      method,
      headers: this.headers({ "Content-Type": "application/json" }),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Raw fetch for presigned storage URLs (no Nexus headers, no API key). */
  async storage(url: string, init: RequestInit): Promise<Response> {
    const res = await fetch(url, init);
    if (!res.ok) {
      throw new NexusApiError(`Storage HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`, res.status);
    }
    return res;
  }
}
