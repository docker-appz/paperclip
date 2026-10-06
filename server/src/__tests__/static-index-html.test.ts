import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readBrandedStaticIndexHtml } from "../static-index-html.js";

describe("static SPA fallback HTML", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores retired snippet settings in managed and self-hosted static HTML", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cloud-html-"));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, "index.html"), "<html><body>App</body></html>");
    vi.stubEnv("PAPERCLIP_CLOUD_UI_SNIPPET", '<script src="https://example.com/chat.js"></script>');
    vi.stubEnv("PAPERCLIP_CLOUD_UI_SNIPPET_B64", Buffer.from('<script src="https://example.com/legacy.js"></script>').toString("base64"));
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", undefined);
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", undefined);
    expect(readBrandedStaticIndexHtml(dir)).not.toContain("chat.js");
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", "{}");
    expect(readBrandedStaticIndexHtml(dir)).not.toContain("chat.js");
    vi.stubEnv("PAPERCLIP_CLOUD_UI_SNIPPET", undefined);
    expect(readBrandedStaticIndexHtml(dir)).not.toContain("legacy.js");
  });

  it("serves the current index.html instead of reusing stale asset hashes", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-static-index-"));
    tempDirs.push(tempDir);
    const indexPath = path.join(tempDir, "index.html");
    const app = express();
    app.get(/.*/, (_req, res) => {
      res
        .status(200)
        .set("Content-Type", "text/html")
        .set("Cache-Control", "no-cache")
        .end(readBrandedStaticIndexHtml(tempDir));
    });

    fs.writeFileSync(
      indexPath,
      '<html><body><script type="module" src="/assets/index-old.js"></script></body></html>',
      "utf8",
    );
    await expect(request(app).get("/PAP/issues/PAP-9939")).resolves.toMatchObject({
      text: expect.stringContaining("/assets/index-old.js"),
    });

    fs.writeFileSync(
      indexPath,
      '<html><body><script type="module" src="/assets/index-new.js"></script></body></html>',
      "utf8",
    );
    const res = await request(app).get("/PAP/issues/PAP-9939");
    expect(res.text).toContain("/assets/index-new.js");
    expect(res.text).not.toContain("/assets/index-old.js");
  });

  it("resolves base path correctly from env, headers, and request URLs", async () => {
    const { resolveBasePath } = await import("../static-index-html.js");
    expect(resolveBasePath()).toBe("");
    expect(resolveBasePath({ headers: { "x-forwarded-prefix": "/paperclip" } })).toBe("/paperclip");
    expect(resolveBasePath({ originalUrl: "/paperclip/api/tools/oauth/callback" })).toBe("/paperclip");
    expect(resolveBasePath({ headers: { referer: "https://akira.tail0ddb51.ts.net/paperclip/FEV/apps/connect" } })).toBe("/paperclip");

    vi.stubEnv("PAPERCLIP_BASE_PATH", "/paperclip");
    expect(resolveBasePath()).toBe("/paperclip");
    expect(resolveBasePath({ originalUrl: "/api/tools/oauth/callback" })).toBe("/paperclip");

    vi.stubEnv("PAPERCLIP_BASE_PATH", undefined);
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", "https://akira.tail0ddb51.ts.net/paperclip");
    expect(resolveBasePath()).toBe("/paperclip");
  });
});
