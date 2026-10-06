export const LEGACY_STORAGE_KEY = "aitext.state.v1";

// The AIText server may be reached through different LAN addresses.
export const isAiTextServerOrigin = (): boolean =>
  window.location.port === "8080" || ["192.168.2.10", "ai-server"].includes(window.location.hostname);
