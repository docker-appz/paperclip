import fs from "node:fs";
import path from "node:path";
import { applyUiBranding } from "./ui-branding.js";

export function resolveBasePath(reqOrPath?: any): string {
  if (typeof reqOrPath === "object" && reqOrPath !== null) {
    const prefix = reqOrPath.headers?.["x-forwarded-prefix"];
    if (typeof prefix === "string" && prefix.trim()) {
      return prefix.trim().replace(/\/+$/, "");
    }
    const originalUrl = reqOrPath.originalUrl || reqOrPath.url || "";
    if (originalUrl === "/paperclip" || originalUrl.startsWith("/paperclip/") || originalUrl.startsWith("/paperclip?")) {
      return "/paperclip";
    }
    const referer = reqOrPath.headers?.["referer"];
    if (typeof referer === "string") {
      try {
        const u = new URL(referer);
        if (u.pathname === "/paperclip" || u.pathname.startsWith("/paperclip/")) {
          return "/paperclip";
        }
      } catch {}
    }
  } else if (typeof reqOrPath === "string") {
    if (reqOrPath === "/paperclip" || reqOrPath.startsWith("/paperclip/") || reqOrPath.startsWith("/paperclip?")) {
      return "/paperclip";
    }
  }

  if (process.env.PAPERCLIP_BASE_PATH) {
    return process.env.PAPERCLIP_BASE_PATH.replace(/\/+$/, "");
  }
  if (process.env.PAPERCLIP_PUBLIC_URL) {
    try {
      const u = new URL(process.env.PAPERCLIP_PUBLIC_URL);
      if (u.pathname && u.pathname !== "/") {
        return u.pathname.replace(/\/+$/, "");
      }
    } catch {}
  }
  return "/paperclip";
}

export function readBrandedStaticIndexHtml(uiDist: string, reqOrPath?: any): string {
  let html = applyUiBranding(fs.readFileSync(path.join(uiDist, "index.html"), "utf-8"));
  const basePath = resolveBasePath(reqOrPath);

  if (basePath) {
    const baseHref = `${basePath}/`;
    // Inject <base href="..."> so that all relative URLs (including module imports) resolve under the subpath
    if (!html.includes("<base ")) {
      html = html.replace(/<head>/i, `<head>\n    <base href="${baseHref}">`);
    }
    if (!html.includes("__PAPERCLIP_BASE_PATH__")) {
      html = html.replace(/<head>/i, `<head>\n    <script>window.__PAPERCLIP_BASE_PATH__ = "${basePath}"; window.__PAPERCLIP_API_BASE__ = "${basePath}/api";</script>`);
    }

    // Rewrite any remaining /assets/ or ./assets/ references to explicitly use basePath
    html = html
      .replace(/(href|src)="(\.\/|\/)?assets\//g, `$1="${basePath}/assets/`)
      .replace(/(href|src)="(\.\/|\/)?favicon/g, `$1="${basePath}/favicon`)
      .replace(/href="(\.\/|\/)?site\.webmanifest"/g, `href="${basePath}/site.webmanifest"`)
      .replace(/href="(\.\/|\/)?apple-touch-icon\.png"/g, `href="${basePath}/apple-touch-icon.png"`);
  }
  return html;
}
