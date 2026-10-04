// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

import { redact } from "./secrets.js";

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
}

export function success(text: string): ToolResult {
  return { content: [{ type: "text", text: redact(text) }] };
}

export function error(text: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${redact(text)}` }], isError: true };
}

export function errMsg(e: unknown): string {
  return redact(e);
}
