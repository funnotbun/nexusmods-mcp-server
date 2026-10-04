// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

// Runs INSIDE the browser page via page.evaluate(): must be fully self-contained
// (no imports, no references to module scope). Fetches a site URL with the page's
// session and parses the HTML with the browser's own DOMParser.

export type ParseKind =
  | "modComments"
  | "modThreadId"
  | "forumPage"
  | "forumTopic"
  | "forumSession"
  | "invisionReplyForm"
  | "invisionComposeForm"
  | "pmList"
  | "modBugs"
  | "modBugReplies"
  | "bugReportForm"
  | "hideCommentPopup";

export interface ParseArgs {
  kind: ParseKind;
  url: string;
  /** Optional form POST (urlencoded), for widgets the site loads by POST. */
  form?: Record<string, string>;
}

export async function fetchAndParse({ kind, url, form }: ParseArgs): Promise<any> {
  // www.nexusmods.com answers these page/widget fetches only as XHR (as its own jQuery
  // front-end sends them); without the header it returns 403.
  const xhr = new URL(url).hostname === "www.nexusmods.com";
  const headers: Record<string, string> = xhr ? { "X-Requested-With": "XMLHttpRequest" } : {};
  if (form) headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
  const r = await fetch(url, {
    credentials: "include",
    redirect: "error",
    signal: AbortSignal.timeout(45_000),
    headers,
    method: form ? "POST" : "GET",
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const html = await r.text();
  if (!r.ok) return { error: `HTTP ${r.status}: ${html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300)}` };

  if (kind === "modThreadId") {
    // Mod page Posts tab: data-target="/Core/Libs/Common/Widgets/CommentContainer?...&thread_id=NNN..."
    const m = html.match(/CommentContainer\?[^"']*?thread_id=(\d+)/);
    return { threadId: m ? Number(m[1]) : null };
  }

  if (kind === "forumSession") {
    // Invision page settings block: `memberID: 123` (0 for guests) and `csrfKey: "..."`.
    const member = html.match(/memberID:\s*(\d+)/);
    const csrf = html.match(/csrfKey:\s*"(\w+)"/);
    return { memberId: member ? Number(member[1]) : 0, csrfKey: csrf ? csrf[1] : null };
  }

  const doc = new DOMParser().parseFromString(html, "text/html");

  // jQuery .serialize() semantics: named, enabled controls; checkboxes/radios only when
  // checked; no file/submit/button controls.
  const serialize = (f: Element): [string, string][] => {
    const out: [string, string][] = [];
    f.querySelectorAll("input,textarea,select").forEach((el) => {
      const i = el as HTMLInputElement;
      const name = i.getAttribute("name");
      // DOMParser runs with scripting off, so <noscript> content becomes real controls; in a
      // JS browser it is inert text and never submitted (Invision's `<name>_noscript` editor
      // twin: if sent, even empty, it overrides the rich editor field).
      if (!name || i.hasAttribute("disabled") || el.closest("noscript")) return;
      const type = (i.getAttribute("type") || "").toLowerCase();
      if (["file", "submit", "button", "reset", "image"].includes(type)) return;
      if ((type === "checkbox" || type === "radio") && !i.hasAttribute("checked")) return;
      if (el.tagName === "SELECT") {
        const opt = el.querySelector("option[selected]") || el.querySelector("option");
        out.push([name, opt?.getAttribute("value") ?? opt?.textContent ?? ""]);
      } else if (el.tagName === "TEXTAREA") out.push([name, el.textContent || ""]);
      else out.push([name, i.getAttribute("value") ?? (type === "checkbox" || type === "radio" ? "on" : "")]);
    });
    return out;
  };

  // Text with line breaks for <br> and block elements; blank lines collapsed.
  const textOf = (el: Element | null | undefined): string => {
    if (!el) return "";
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll("br").forEach((b) => b.replaceWith("\n"));
    clone.querySelectorAll("p,div,li,blockquote,pre,h1,h2,h3,h4,h5,tr").forEach((b) => b.append("\n"));
    clone.querySelectorAll("script,style").forEach((s) => s.remove());
    return (clone.textContent || "")
      .replace(/[ \t ]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  };
  const txt = (el: Element | null | undefined) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const maxPage = (sel: string): number => {
    let max = 1;
    doc.querySelectorAll(sel).forEach((a) => {
      const n = parseInt((a.textContent || "").trim(), 10);
      if (n > max) max = n;
    });
    return max;
  };

  // Member id from the avatar URL (avatars.nexusmods.com/<memberId>/...) or a /users/<id> link.
  const memberIdOf = (head: Element | null): number | null => {
    const src = head?.querySelector("img[src*='avatars.nexusmods.com/']")?.getAttribute("src") || "";
    const href = head?.querySelector(".comment-name a")?.getAttribute("href") || "";
    const m = src.match(/avatars\.nexusmods\.com\/(\d+)/) || href.match(/\/users\/(\d+)/);
    return m ? Number(m[1]) : null;
  };

  if (kind === "modComments") {
    const pick = (li: Element): any => ({
      id: li.id.replace("comment-", ""),
      author: txt(li.querySelector(":scope > .comment-head .comment-name a")) || "?",
      authorId: memberIdOf(li.querySelector(":scope > .comment-head")),
      isModAuthor: li.classList.contains("comment-author"),
      date: Number(li.querySelector(":scope > .comment-content time[data-date]")?.getAttribute("data-date")) || 0,
      sticky: li.classList.contains("comment-sticky"),
      locked: !!li.querySelector(":scope > .comment-content .locked:not([style*='none'])"),
      text: textOf(li.querySelector(":scope > .comment-content .comment-content-text")),
      replies: Array.from(li.querySelectorAll(":scope > ol.comment-kids > li.comment")).map((k) => ({
        id: k.id.replace("comment-", ""),
        author: txt(k.querySelector(":scope > .comment-head .comment-name a")) || "?",
        authorId: memberIdOf(k.querySelector(":scope > .comment-head")),
        isModAuthor: k.classList.contains("comment-author"),
        date: Number(k.querySelector(":scope > .comment-content time[data-date]")?.getAttribute("data-date")) || 0,
        text: textOf(k.querySelector(":scope > .comment-content .comment-content-text")),
      })),
    });
    const top = Array.from(doc.querySelectorAll("li.comment")).filter((li) => !li.parentElement?.classList.contains("comment-kids"));
    return {
      total: Number(doc.querySelector("#comment-count")?.getAttribute("data-comment-count")) || 0,
      page: Number((doc.querySelector("#current-page-number") as HTMLInputElement | null)?.value) || 1,
      pages: maxPage(".pagination li a"),
      csrfToken: doc.querySelector("[data-csrf-token]")?.getAttribute("data-csrf-token") || null,
      comments: top.map(pick),
    };
  }

  if (kind === "forumPage") {
    const forums = Array.from(doc.querySelectorAll("li.cForumRow[data-forumid]")).map((li) => {
      const a = li.querySelector(".ipsDataItem_title a");
      return {
        id: li.getAttribute("data-forumid"),
        title: txt(a),
        url: a?.getAttribute("href") || "",
        description: txt(li.querySelector(".ipsDataItem_meta")).slice(0, 200),
        posts: txt(li.querySelector(".ipsDataItem_stats_number")),
      };
    });
    const topics = Array.from(doc.querySelectorAll("li.ipsDataItem[data-rowid]")).map((li) => {
      const a = li.querySelector(".ipsDataItem_title a");
      return {
        id: li.getAttribute("data-rowid"),
        title: txt(a),
        url: a?.getAttribute("href") || "",
        author: txt(li.querySelector(".ipsDataItem_meta a.ipsType_break")),
        date: li.querySelector(".ipsDataItem_meta time")?.getAttribute("datetime") || "",
        replies: txt(li.querySelector("[data-stattype='forums_comments'] .ipsDataItem_stats_number")),
        views: txt(li.querySelector("[data-stattype='num_views'] .ipsDataItem_stats_number")),
      };
    });
    return {
      title: txt(doc.querySelector("h1.ipsType_pageTitle")) || doc.title,
      pages: Number(doc.querySelector("[data-pages]")?.getAttribute("data-pages")) || 1,
      forums,
      topics,
    };
  }

  if (kind === "forumTopic") {
    // Topic posts are article.cPost; messenger conversation posts are article.ipsComment.
    const posts = Array.from(doc.querySelectorAll("article.cPost, article.ipsComment")).map((art) => ({
      id: art.id.replace("elComment_", ""),
      author:
        txt(art.querySelector("aside .cAuthorPane_author a")) ||
        txt(art.querySelector(".cAuthorPane_author a")) ||
        txt(art.querySelector(".ipsComment_author a")) ||
        "?",
      date: art.querySelector("time[datetime]")?.getAttribute("datetime") || "",
      text: textOf(art.querySelector("[data-role='commentContent']")),
    }));
    return {
      // Messenger pages' h1 is the inbox header; the conversation title is in <title>.
      title: (url.includes("/messenger/") ? "" : txt(doc.querySelector("h1.ipsType_pageTitle"))) || doc.title.replace(/ - Nexus Mods Forums$/, ""),
      pages: Number(doc.querySelector("[data-pages]")?.getAttribute("data-pages")) || 1,
      participants: Array.from(doc.querySelectorAll("[data-participant]")).map((p) => txt(p).replace(/\s*Send new message$/, "")),
      posts,
    };
  }

  if (kind === "invisionReplyForm") {
    // Quick-reply form rendered for members only: commentform_<id>_submitted + csrfKey +
    // editor textarea `<prefix>_comment_<id>` (+ `_noscript` twin left empty, as with JS).
    const f = Array.from(doc.querySelectorAll("form")).find((x) => x.querySelector("input[name^='commentform_'][name$='_submitted']"));
    if (!f) return { error: "no reply form on this page (not logged in, topic locked, or no permission to reply)" };
    const fields = serialize(f);
    const editor = fields.map(([n]) => n).find((n) => /_comment_\d+$/.test(n)) || null;
    let lastSeenId = 0;
    doc.querySelectorAll("[data-commentid]").forEach((el) => {
      const n = Number(el.getAttribute("data-commentid"));
      if (n > lastSeenId) lastSeenId = n;
    });
    return { action: f.getAttribute("action") || url, fields, editor, lastSeenId };
  }

  if (kind === "invisionComposeForm") {
    const f = Array.from(doc.querySelectorAll("form")).find((x) => x.querySelector("[name='messenger_to']"));
    if (!f) return { error: "no compose form (not logged in to the forums, or messaging disabled for this account)" };
    return { action: f.getAttribute("action") || url, fields: serialize(f) };
  }

  if (kind === "pmList") {
    const convs = Array.from(doc.querySelectorAll("li.cMessage[data-messageid]")).map((li) => ({
      id: li.getAttribute("data-messageid"),
      title: txt(li.querySelector(".cMessageTitle")),
      unread: li.classList.contains("ipsDataItem_unread"),
      participants: txt(li.querySelector(".ipsDataItem_main > .ipsType_light")),
      snippet: txt(li.querySelector(".ipsDataItem_meta")),
      date: li.querySelector("time[datetime]")?.getAttribute("datetime") || "",
    }));
    return { pages: Number(doc.querySelector("[data-pages]")?.getAttribute("data-pages")) || 1, convs };
  }

  if (kind === "modBugs") {
    const bugs = Array.from(doc.querySelectorAll("tr.mod-issue-row[data-issue-id]")).map((tr) => ({
      id: tr.getAttribute("data-issue-id"),
      title: txt(tr.querySelector("a.issue-title")),
      status: txt(tr.querySelector("td.table-bug-status")),
      replies: txt(tr.querySelector("td.table-bug-replies")),
      version: txt(tr.querySelector("td.table-bug-version")),
      priority: txt(tr.querySelector("td.table-bug-priority")),
      lastPost: Number(tr.querySelector("td.table-bug-post time[data-date]")?.getAttribute("data-date")) || 0,
    }));
    return {
      enabled: !!doc.querySelector("#tab-modbugs"),
      canReport: !!doc.querySelector("#report-a-bug"),
      pages: maxPage(".pagination li a"),
      bugs,
    };
  }

  if (kind === "modBugReplies") {
    // ModBugReplyList: li#bug-issue-tile-<issue> (the report) then li#bug-reply-tile-<reply>.
    const posts = Array.from(doc.querySelectorAll("li.comment[id^='bug-']")).map((li) => {
      const body = li.querySelector(".comment-content")?.cloneNode(true) as Element | undefined;
      body?.querySelectorAll("time, .comment-reply, script").forEach((x) => x.remove());
      // Own posts carry inline "Edit post" controls inside the content block.
      body?.querySelectorAll("a, button, li").forEach((x) => {
        if ((x.textContent || "").trim() === "Edit post") x.remove();
      });
      return {
        id: li.id.replace(/^bug-(issue|reply)-tile-/, ""),
        isReport: li.id.startsWith("bug-issue-tile-"),
        author: txt(li.querySelector(".comment-name a")) || "?",
        authorId: memberIdOf(li.querySelector(".comment-head")),
        date: li.querySelector(".comment-content time[datetime]")?.getAttribute("datetime") || "",
        text: textOf(body),
      };
    });
    return {
      posts,
      replyToken: doc.querySelector(".add-bug-reply[data-csrf-token]")?.getAttribute("data-csrf-token") || null,
    };
  }

  if (kind === "bugReportForm") {
    // AddBugReportPopUp: form#add-report, token on a#submit-report.
    const f = doc.querySelector("form#add-report");
    return {
      token: doc.querySelector("#submit-report[data-csrf-token]")?.getAttribute("data-csrf-token") || null,
      message: f ? "" : txt(doc.body).slice(0, 300),
    };
  }

  if (kind === "hideCommentPopup") {
    // DeleteAndReportCommentPopUp: the button carries the exact request data.
    const b = doc.querySelector(".delete-and-report-comment");
    if (!b) return { error: `no hide option for this comment: ${txt(doc.body).slice(0, 200)}` };
    const d = (n: string) => b.getAttribute(`data-${n}`) || "";
    return { gameId: d("game-id"), objectId: d("object-id"), objectType: d("object-type"), commentId: d("comment-id"), status: d("status") };
  }

  return { error: `unknown parse kind ${kind}` };
}

export interface SubmitArgs {
  url: string;
  method?: string;
  /** urlencoded (default) or multipart form fields, in order. */
  fields?: [string, string][];
  multipart?: boolean;
  /** JSON body instead of form fields. */
  json?: unknown;
  /** One file for a multipart upload (base64 payload). */
  file?: { field: string; name: string; type: string; b64: string };
  headers?: Record<string, string>;
}

/** Runs INSIDE the page: send a form/JSON/multipart request with the page's session,
 *  exactly as the site's own scripts do. Returns status, final URL (after redirects) and body. */
export async function submitRequest(a: SubmitArgs): Promise<{ status: number; url: string; contentType: string; body: string }> {
  const headers: Record<string, string> = { ...(a.headers || {}) };
  let body: BodyInit | undefined;
  if (a.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(a.json);
  } else if (a.multipart || a.file) {
    const fd = new FormData();
    for (const [k, v] of a.fields || []) fd.append(k, v);
    if (a.file) {
      const bin = atob(a.file.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      fd.append(a.file.field, new Blob([bytes], { type: a.file.type }), a.file.name);
    }
    body = fd;
  } else if (a.fields) {
    headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    body = new URLSearchParams(a.fields).toString();
  }
  const u = new URL(a.url);
  if (u.protocol !== "https:" || u.username || u.password || u.port || !["www.nexusmods.com", "forums.nexusmods.com"].includes(u.hostname)) throw new Error("Unsafe form action");
  const r = await fetch(a.url, { redirect: "error", signal: AbortSignal.timeout(45_000), method: a.method || "POST", credentials: "include", headers, body });
  return { status: r.status, url: r.url, contentType: r.headers.get("content-type") || "", body: await r.text() };
}
