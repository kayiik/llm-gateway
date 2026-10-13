// Fixtures of the Extensions shelf tests: a registry, what a daemon serves,
// two extensions, and an administrator state with three providers that the
// first extension serves.

export const registry = [
  { id: "github_copilot", label: "GitHub Copilot", protocol: "openai", availability: "available", auth_methods: ["oauth_device"], categories: ["coding", "oauth", "subscription"], default_provider_id: "copilot" },
  { id: "openai_codex", label: "OpenAI Codex", protocol: "openai", availability: "available", auth_methods: ["oauth_browser", "oauth_device"], categories: ["coding", "oauth", "subscription"], default_provider_id: "codex" },
  { id: "google_antigravity", label: "Google Antigravity", protocol: "openai", availability: "available", auth_methods: ["oauth_browser"], categories: ["experimental", "coding", "oauth"], default_provider_id: "google-antigravity" },
  { id: "edge_tts", label: "Edge TTS", protocol: "openai", availability: "available", auth_methods: ["none"], categories: ["audio", "no-auth"], default_provider_id: "edge_tts" },
  { id: "anthropic", label: "Anthropic", protocol: "anthropic", availability: "available", auth_methods: ["api_key", "setup_token"], categories: ["api-key", "direct"], default_provider_id: "anthropic" },
];

export const served = [
  { id: "github_copilot", name: "GitHub Copilot", surfaces: ["chat_completions", "responses"], has_oauth: true, credential: "oauth", oauth_methods: ["device"] },
  { id: "openai_codex", name: "OpenAI Codex", surfaces: ["chat_completions", "responses"], has_oauth: true, credential: "oauth", oauth_methods: ["browser", "device"] },
  { id: "google_antigravity", name: "Google Antigravity", surfaces: ["chat_completions"], has_oauth: true, credential: "oauth", oauth_methods: ["manual"] },
  { id: "edge_tts", name: "Edge TTS", surfaces: ["audio_speech"], credential: "none" },
  { id: "opencode_zen_anonymous", name: "OpenCode Zen", surfaces: ["chat_completions", "responses"], credential: "none" },
  { id: "anthropic_setup_token", name: "Anthropic", surfaces: ["messages"], credential: "token" },
];

export const workstation = {
  id: "workstation", name: "Workstation", url: "http://127.0.0.1:18888", secret_set: true,
  providers: [{ id: "copilot", type: "github_copilot" }, { id: "edge_tts", type: "edge_tts" }, { id: "claude-max", type: "anthropic_setup_token" }],
  status: { probed: true, reachable: true, latency_ms: 14, version: "0.0.4", served, error: "", error_code: "", checked_at: "2026-10-12T12:04:00Z", unauthenticated: false, outdated: false },
};

export const buildBox = {
  id: "build-box", name: "Build box", url: "http://extension:18888", secret_set: true, providers: [],
  status: { probed: true, reachable: false, latency_ms: 5000, version: "", served: [], error: "the extension did not answer within 5s", error_code: "no_answer", checked_at: "2026-10-12T12:04:00Z", unauthenticated: false, outdated: false },
};

const tile = (entry, instances) => ({
  ...entry, configured: instances.length > 0, configured_provider_ids: instances.map((instance) => instance.id), instances,
  instance_status_counts: Object.fromEntries(instances.map((instance) => [instance.status, 1])), status: instances.length ? "configured" : "not_configured",
});

export const data = {
  provider_registry: registry,
  provider_statuses: [
    tile(registry[0], [{ id: "copilot", status: "catalog_synced", connection_count: 2 }]),
    tile(registry[1], []),
    tile(registry[2], []),
    tile(registry[3], [{ id: "edge_tts", status: "configured", connection_count: 0 }]),
    tile(registry[4], []),
    { id: "claude-max", label: "claude-max", custom: true, protocol: "gateway", availability: "available", auth_methods: [], configured: true, configured_provider_ids: ["claude-max"], instances: [{ id: "claude-max", status: "needs_credentials" }], instance_status_counts: { needs_credentials: 1 }, status: "needs_credentials" },
  ],
  providers: [{ id: "copilot", type: "github_copilot", registry_id: "github_copilot" }, { id: "edge_tts", type: "edge_tts", registry_id: "edge_tts" }, { id: "claude-max", type: "anthropic_setup_token" }],
  companion_daemon_providers: ["claude-max", "copilot", "edge_tts"],
  provider_extensions: { "claude-max": "workstation", copilot: "workstation", edge_tts: "workstation" },
};
