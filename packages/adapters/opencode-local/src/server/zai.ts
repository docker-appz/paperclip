export const DEFAULT_ZAI_MODELS = [
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.3-flashx",
  "glm-5.2",
  "glm-5.1",
  "glm-5",
  "glm-5-turbo",
  "glm-4.7",
  "glm-4.6",
  "glm-4.5",
  "glm-4.5-air",
] as const;

export const DEFAULT_ZAI_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

interface CachedModels {
  models: string[];
  expiresAt: number;
}

const zaiModelsCache = new Map<string, CachedModels>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function fetchZaiModels(
  baseUrl = DEFAULT_ZAI_BASE_URL,
  apiKey?: string,
  timeoutMs = 5000,
): Promise<string[]> {
  const trimmedKey = apiKey?.trim();
  if (!trimmedKey) {
    return [...DEFAULT_ZAI_MODELS];
  }

  const endpoint = `${baseUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${trimmedKey}`,
      },
    });

    if (!res.ok) {
      return [...DEFAULT_ZAI_MODELS];
    }

    const json = (await res.json()) as unknown;
    const items: Array<{ id?: string }> = Array.isArray(json)
      ? json.flatMap((entry) => (Array.isArray(entry?.data) ? entry.data : []))
      : Array.isArray((json as { data?: unknown })?.data)
        ? ((json as { data: Array<{ id?: string }> }).data)
        : [];

    const modelIds = items
      .map((item) => (typeof item?.id === "string" ? item.id.trim() : ""))
      .filter((id): id is string => id.length > 0);

    if (modelIds.length > 0) {
      return Array.from(new Set(modelIds));
    }
  } catch {
    // Network error or timeout: fall through to fallback models
  } finally {
    clearTimeout(timer);
  }

  return [...DEFAULT_ZAI_MODELS];
}

export async function fetchZaiModelsCached(
  baseUrl = DEFAULT_ZAI_BASE_URL,
  apiKey?: string,
  timeoutMs = 5000,
): Promise<string[]> {
  const cacheKey = `${baseUrl.trim()}::${apiKey?.trim() ?? ""}`;
  const now = Date.now();
  const cached = zaiModelsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.models;
  }

  const models = await fetchZaiModels(baseUrl, apiKey, timeoutMs);
  zaiModelsCache.set(cacheKey, {
    models,
    expiresAt: now + CACHE_TTL_MS,
  });
  return models;
}
