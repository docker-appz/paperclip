import fs from "node:fs";
import path from "node:path";
import { applyUiBranding } from "./ui-branding.js";

export function readBrandedStaticIndexHtml(uiDist: string, reqPath?: string): string {
  let html = applyUiBranding(fs.readFileSync(path.join(uiDist, "index.html"), "utf-8"));
  const isSubpath = process.env.PAPERCLIP_BASE_PATH === "/paperclip" ||
    Boolean(process.env.PAPERCLIP_PUBLIC_URL && process.env.PAPERCLIP_PUBLIC_URL.includes("/paperclip")) ||
    Boolean(reqPath && (reqPath === "/paperclip" || reqPath.startsWith("/paperclip/") || reqPath.startsWith("/paperclip?")));

  if (isSubpath) {
    html = html
      .replace(/(href|src)="\/assets\//g, '$1="/paperclip/assets/')
      .replace(/(href|src)="\/favicon/g, '$1="/paperclip/favicon')
      .replace(/href="\/site\.webmanifest"/g, 'href="/paperclip/site.webmanifest"')
      .replace(/<head>/i, '<head>\n    <script>window.__PAPERCLIP_BASE_PATH__ = "/paperclip"; window.__PAPERCLIP_API_BASE__ = "/paperclip/api";</script>');
  }
  return html;
}
