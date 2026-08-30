/* ------------------------------------------------------------------ *
 * Shared multi-provider API key store.
 * All three tools (LBO Model, M&A Merger Model, SOTP Valuation
 * Builder) call an AI provider straight from the device, so they
 * share one set of keys — one per provider — and one "currently
 * selected provider" setting. Set a key once in any tool and every
 * tool picks it up.
 * ------------------------------------------------------------------ */
const LEGACY_KEY_STORAGE = "lbo_anthropic_api_key"; // pre-multi-provider single-key slot
const KEY_STORAGE_PREFIX = "lbo_api_key__";
const PROVIDER_STORAGE = "lbo_ai_provider";

const currentKeys = {}; // providerId -> key, in-memory cache
let currentProvider = "anthropic";

function keySlot(provider) { return KEY_STORAGE_PREFIX + provider; }

export function loadApiKey(provider) {
  try {
    let v = localStorage.getItem(keySlot(provider)) || "";
    if (!v && provider === "anthropic") {
      // migrate a key saved before multi-provider support existed
      const legacy = localStorage.getItem(LEGACY_KEY_STORAGE);
      if (legacy) { v = legacy; try { localStorage.setItem(keySlot("anthropic"), legacy); } catch (e) {} }
    }
    currentKeys[provider] = v;
    return v;
  } catch (e) {
    currentKeys[provider] = "";
    return "";
  }
}

export function saveApiKey(provider, key) {
  currentKeys[provider] = key || "";
  try {
    if (currentKeys[provider]) localStorage.setItem(keySlot(provider), currentKeys[provider]);
    else localStorage.removeItem(keySlot(provider));
  } catch (e) { /* localStorage unavailable, key still held in memory for this session */ }
}

export function getApiKey(provider) {
  return currentKeys[provider] || "";
}

export function loadSelectedProvider() {
  try {
    currentProvider = localStorage.getItem(PROVIDER_STORAGE) || "anthropic";
  } catch (e) {
    currentProvider = "anthropic";
  }
  return currentProvider;
}

export function saveSelectedProvider(provider) {
  currentProvider = provider;
  try { localStorage.setItem(PROVIDER_STORAGE, provider); } catch (e) {}
}

export function getSelectedProvider() {
  return currentProvider;
}
