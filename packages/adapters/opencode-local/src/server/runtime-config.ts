import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asBoolean } from "@paperclipai/adapter-utils/server-utils";
import { fetchZaiModelsCached, DEFAULT_ZAI_BASE_URL } from "./zai.js";

type PreparedOpenCodeRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  cleanup: () => Promise<void>;
};

export type OpenCodeRuntimeMcpServer = {
  name: string;
  url: string;
  token: string;
};

function slugifyMcpServerName(value: string, fallback: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || fallback
  );
}

// Runtime MCP gateway URLs are minted against the server's configured public
// base URL. Locally executed OpenCode runs share the server's network
// namespace, where that public origin (for example a tailscale hostname) can
// be unreachable while the server's own loopback listener always is. When the
// exported listen port matches the gateway URL's port, rebase the origin onto
// the loopback listener. An explicit PAPERCLIP_OPENCODE_MCP_API_BASE override
// always wins; without a match the URL stays untouched so remote execution
// targets keep using the public origin.
function resolveRuntimeMcpUrl(
  rawUrl: string,
  readEnv: (name: string) => string | undefined,
): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const rebase = (origin: string): string => {
    try {
      return new URL(`${url.pathname}${url.search}${url.hash}`, origin).toString();
    } catch {
      return rawUrl;
    }
  };
  const overrideBase = (readEnv("PAPERCLIP_OPENCODE_MCP_API_BASE") ?? "").trim();
  if (overrideBase) return rebase(overrideBase);
  const listenHost = (readEnv("PAPERCLIP_LISTEN_HOST") ?? "").trim();
  const listenPort = (readEnv("PAPERCLIP_LISTEN_PORT") ?? "").trim();
  if (!listenHost || !listenPort) return rawUrl;
  if (url.port !== listenPort) return rawUrl;
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") {
    return rawUrl;
  }
  const host = listenHost === "0.0.0.0" ? "127.0.0.1" : listenHost === "::" ? "[::1]" : listenHost;
  return rebase(`http://${host}:${listenPort}`);
}

function buildRuntimeMcpSection(
  servers: OpenCodeRuntimeMcpServer[],
  readEnv: (name: string) => string | undefined,
  existingKeys: Set<string>,
  notes: string[],
): Record<string, Record<string, unknown>> | null {
  if (servers.length === 0) return null;
  const section: Record<string, Record<string, unknown>> = {};
  const usedKeys = new Set(existingKeys);
  for (const [index, server] of servers.entries()) {
    const url = resolveRuntimeMcpUrl(server.url.trim(), readEnv);
    const token = server.token.trim();
    if (!url || !token) continue;
    const base = slugifyMcpServerName(server.name, `paperclip-mcp-${index + 1}`);
    let key = base;
    let suffix = 2;
    while (usedKeys.has(key)) {
      key = `${base}-${suffix}`;
      suffix += 1;
    }
    usedKeys.add(key);
    section[key] = {
      type: "remote",
      url,
      headers: { Authorization: `Bearer ${token}` },
      enabled: true,
    };
  }
  const names = Object.keys(section);
  if (names.length === 0) return null;
  notes.push(`Mounted ${names.length} Paperclip runtime MCP server(s) into the OpenCode config: ${names.join(", ")}.`);
  return section;
}

function resolveXdgConfigHome(env: Record<string, string>): string {
  return (
    (typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()) ||
    (typeof process.env.XDG_CONFIG_HOME === "string" && process.env.XDG_CONFIG_HOME.trim()) ||
    path.join(os.homedir(), ".config")
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Recursively replace {env:VAR} placeholders with the resolved value. Used to bake
// gateway provider secrets (e.g. the LLM-gateway virtual key) into opencode.json
// SERVER-SIDE, where the value is reliably present. OpenCode's own {env:...}
// resolution happens inside the (possibly sandboxed) run process, whose env
// plumbing is not guaranteed to carry the key to OpenCode's spawned server -- so
// we resolve it here. Unresolvable placeholders are left intact for OpenCode to try.
function expandEnvPlaceholders<T>(value: T, resolve: (name: string) => string | undefined): T {
  if (typeof value === "string") {
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
      const resolved = resolve(name);
      return resolved !== undefined && resolved.length > 0 ? resolved : match;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => expandEnvPlaceholders(entry, resolve)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = expandEnvPlaceholders(entry, resolve);
    }
    return out as unknown as T;
  }
  return value;
}

function parseProviderConfig(
  raw: unknown,
  resolveEnv: (name: string) => string | undefined,
  notes: string[],
): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Surface the misconfiguration instead of silently dropping the provider
    // block; an unparseable value would otherwise be undiagnosable.
    notes.push("PAPERCLIP_OPENCODE_PROVIDERS contains invalid JSON; custom providers ignored.");
    return null;
  }
  if (!isPlainObject(parsed)) {
    notes.push(
      "PAPERCLIP_OPENCODE_PROVIDERS is set but is not a JSON object; custom providers ignored.",
    );
    return null;
  }
  // Only keep provider entries that are themselves objects; surface the ones
  // we drop so a malformed entry is just as diagnosable as malformed JSON.
  const providers: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (isPlainObject(value)) providers[key] = expandEnvPlaceholders(value, resolveEnv);
    else skipped.push(key);
  }
  if (skipped.length > 0) {
    notes.push(
      `PAPERCLIP_OPENCODE_PROVIDERS: skipped provider(s) with non-object values: ${skipped.join(", ")}.`,
    );
  }
  return Object.keys(providers).length > 0 ? providers : null;
}

function parseConfiguredModelRef(raw: unknown): { provider: string; model: string } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

async function readJsonObject(filepath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filepath, "utf8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function prepareOpenCodeRuntimeConfig(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
  runtimeMcpServers?: OpenCodeRuntimeMcpServer[];
  targetIsRemote?: boolean;
}): Promise<PreparedOpenCodeRuntimeConfig> {
  const skipPermissions = asBoolean(input.config.dangerouslySkipPermissions, true);
  if (!skipPermissions) {
    return {
      env: input.env,
      notes: [],
      cleanup: async () => {},
    };
  }

  // For remote execution targets the host XDG_CONFIG_HOME path is meaningless
  // (and actively harmful — it leaks a macOS-only path into the remote Linux
  // env). Callers that need to ship a runtime opencode config to the remote
  // box do that via prepareAdapterExecutionTargetRuntime in execute.ts; this
  // host-fs helper is local-only.
  if (input.targetIsRemote) {
    return {
      env: input.env,
      notes: [],
      cleanup: async () => {},
    };
  }

  const sourceConfigDir = path.join(resolveXdgConfigHome(input.env), "opencode");
  const runtimeConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-config-"));
  const runtimeConfigDir = path.join(runtimeConfigHome, "opencode");
  const runtimeConfigPath = path.join(runtimeConfigDir, "opencode.json");

  await fs.mkdir(runtimeConfigDir, { recursive: true });
  try {
    await fs.cp(sourceConfigDir, runtimeConfigDir, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      throw err;
    }
  }

  const existingConfig = await readJsonObject(runtimeConfigPath);
  const notes = [
    "Injected runtime OpenCode config with permission=allow for all tools and connections.",
  ];

  // Merge gateway/custom provider definitions supplied via PAPERCLIP_OPENCODE_PROVIDERS
  // (a JSON object in OpenCode's `provider` shape). OpenCode resolves a `--model
  // provider/model` only when that model exists in a provider's `models` map, and
  // OPENCODE_ALLOW_ALL_MODELS does NOT bypass its internal getModel(). So routing a
  // gateway model (e.g. an EU LLM gateway exposing OpenAI-compatible /v1) requires a
  // custom provider with an explicit models map. We accept it as config (not
  // hard-coded) so the gateway URL, key env, and model list stay declarative.
  const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  const gatewayProviders = parseProviderConfig(
    input.env.PAPERCLIP_OPENCODE_PROVIDERS ?? process.env.PAPERCLIP_OPENCODE_PROVIDERS,
    resolveEnv,
    notes,
  );
  const existingProvider = isPlainObject(existingConfig.provider) ? existingConfig.provider : {};
  let nextProvider = gatewayProviders
    ? { ...existingProvider, ...gatewayProviders }
    : existingProvider;
  if (gatewayProviders) {
    notes.push(
      `Injected ${Object.keys(gatewayProviders).length} custom OpenCode provider(s) from PAPERCLIP_OPENCODE_PROVIDERS: ${Object.keys(gatewayProviders).join(", ")}.`,
    );
  }

  // Register built-in Z.AI provider if targeted by model or configured via env
  const configuredModel = parseConfiguredModelRef(input.config.model);
  if (!nextProvider.zai && (configuredModel?.provider === "zai" || resolveEnv("ZAI_API_KEY"))) {
    const zaiBaseUrl = (resolveEnv("ZAI_BASE_URL") ?? DEFAULT_ZAI_BASE_URL).trim();
    const zaiApiKey = resolveEnv("ZAI_API_KEY");
    const fetchedModels = await fetchZaiModelsCached(zaiBaseUrl, zaiApiKey);
    const zaiModelsMap: Record<string, Record<string, unknown>> = {};
    for (const m of fetchedModels) {
      zaiModelsMap[m] = { name: m };
    }
    nextProvider = {
      ...nextProvider,
      zai: {
        npm: "@ai-sdk/openai-compatible",
        name: "Z.AI",
        options: {
          baseURL: zaiBaseUrl,
          apiKey: zaiApiKey || "{env:ZAI_API_KEY}",
        },
        models: zaiModelsMap,
      },
    };
    notes.push(
      `Configured built-in Z.AI provider (${zaiBaseUrl}) with ${fetchedModels.length} model(s) in runtime OpenCode config.`,
    );
  }

  // Register the configured model on its provider's models map. OpenCode resolves
  // `--model provider/model` only when the model id exists in that map, so ids the
  // models.dev catalog does not carry — OpenRouter routing variants such as
  // `openai/gpt-oss-120b:nitro`, or models newer than the bundled catalog — are
  // otherwise rejected with "Model not found" even though the provider serves them.
  // An empty entry deep-merges with catalog metadata, so this is a no-op for models
  // the catalog already knows, and we never clobber an explicit definition from the
  // user config or PAPERCLIP_OPENCODE_PROVIDERS.
  if (configuredModel) {
    const providerEntry = isPlainObject(nextProvider[configuredModel.provider])
      ? { ...(nextProvider[configuredModel.provider] as Record<string, unknown>) }
      : {};
    const providerModels = isPlainObject(providerEntry.models)
      ? { ...(providerEntry.models as Record<string, unknown>) }
      : {};
    if (!isPlainObject(providerModels[configuredModel.model])) {
      providerModels[configuredModel.model] = {};
      providerEntry.models = providerModels;
      nextProvider = { ...nextProvider, [configuredModel.provider]: providerEntry };
      notes.push(
        `Registered configured model ${configuredModel.provider}/${configuredModel.model} in the runtime OpenCode config.`,
      );
    }
  }

  const nextConfig: Record<string, unknown> = {
    ...existingConfig,
    permission: "allow",
  };
  if (Object.keys(nextProvider).length > 0) {
    nextConfig.provider = nextProvider;
  }

  // Pin OpenCode's auxiliary "small" model (used for session-title generation and
  // other helper tasks) via PAPERCLIP_OPENCODE_SMALL_MODEL. OpenCode otherwise
  // defaults the small model to a built-in provider default (e.g. a claude-* model
  // for the anthropic provider); when that provider is repointed at a gateway that
  // does not serve that exact model, the title-gen call fails and aborts the run.
  // Setting small_model to a gateway-served model keeps every call on supported models.
  const smallModel = (input.env.PAPERCLIP_OPENCODE_SMALL_MODEL ?? process.env.PAPERCLIP_OPENCODE_SMALL_MODEL)?.trim();
  if (smallModel) {
    nextConfig.small_model = smallModel;
    notes.push(`Pinned OpenCode small_model to ${smallModel}.`);
  } else if (configuredModel?.provider === "zai") {
    const small = `zai/${configuredModel.model || "glm-5"}`;
    nextConfig.small_model = small;
    notes.push(`Defaulted OpenCode small_model to ${small} for Z.AI.`);
  }

  // Mount Paperclip-governed runtime MCP gateways (tool connections such as a
  // shared Chrome DevTools browser) as remote OpenCode MCP servers. The bearer
  // tokens are run-scoped gateway tokens; the config file lives in a private
  // temp dir and is written with owner-only permissions.
  const resolveMcpEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  const existingMcp = isPlainObject(existingConfig.mcp) ? existingConfig.mcp : {};
  const runtimeMcp = buildRuntimeMcpSection(
    input.runtimeMcpServers ?? [],
    resolveMcpEnv,
    new Set(Object.keys(existingMcp)),
    notes,
  );
  if (runtimeMcp) {
    nextConfig.mcp = { ...existingMcp, ...runtimeMcp };
  }
  await fs.writeFile(runtimeConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  return {
    env: {
      ...input.env,
      XDG_CONFIG_HOME: runtimeConfigHome,
    },
    notes,
    cleanup: async () => {
      await fs.rm(runtimeConfigHome, { recursive: true, force: true });
    },
  };
}

/** Managed credentials must never leave host-only homes in a remote process. */
export function prepareManagedOpenCodeRemoteHomes(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
  runtimeRootDir: string | null | undefined;
  runId: string;
  configDir?: string;
}): void {
  if (!input.config.managedAiConnection) return;
  if (!input.runtimeRootDir) throw new Error("Managed OpenCode authentication requires an isolated remote runtime directory.");
  const home = path.posix.join(input.runtimeRootDir, "managed-auth", input.runId);
  Object.assign(input.env, {
    HOME: home,
    XDG_CONFIG_HOME: input.configDir ?? path.posix.join(home, "config"),
    XDG_DATA_HOME: path.posix.join(home, "data"),
    XDG_CACHE_HOME: path.posix.join(home, "cache"),
    XDG_STATE_HOME: path.posix.join(home, "state"),
  });
}
