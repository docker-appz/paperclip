import { describe, expect, it } from "vitest";
import { DEFAULT_ZAI_MODELS, fetchZaiModels } from "./zai.js";

describe("fetchZaiModels", () => {
  it("returns default fallback models when no API key is provided", async () => {
    const models = await fetchZaiModels("https://api.z.ai/api/coding/paas/v4");
    expect(models).toEqual([...DEFAULT_ZAI_MODELS]);
  });

  it("handles mock array-wrapped list response as returned by n8n / z.ai endpoint", async () => {
    const mockData = [
      {
        object: "list",
        data: [
          { id: "glm-4.5", object: "model", created: 1753632000, owned_by: "z-ai" },
          { id: "glm-4.5-air", object: "model", created: 1753632000, owned_by: "z-ai" },
          { id: "glm-4.6", object: "model", created: 1759276800, owned_by: "z-ai" },
          { id: "glm-4.7", object: "model", created: 1766332800, owned_by: "z-ai" },
          { id: "glm-5", object: "model", created: 1770739200, owned_by: "z-ai" },
          { id: "glm-5.3", object: "model", created: 1786636800, owned_by: "z-ai" },
        ],
      },
    ];

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => mockData,
      })) as unknown as typeof fetch;

      const models = await fetchZaiModels("https://api.z.ai/api/coding/paas/v4", "test-key");
      expect(models).toEqual([
        "glm-4.5",
        "glm-4.5-air",
        "glm-4.6",
        "glm-4.7",
        "glm-5",
        "glm-5.3",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles standard OpenAI format { data: [...] }", async () => {
    const mockData = {
      object: "list",
      data: [
        { id: "glm-5", object: "model" },
        { id: "glm-5.3", object: "model" },
      ],
    };

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => mockData,
      })) as unknown as typeof fetch;

      const models = await fetchZaiModels("https://api.z.ai/api/coding/paas/v4", "test-key");
      expect(models).toEqual(["glm-5", "glm-5.3"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
