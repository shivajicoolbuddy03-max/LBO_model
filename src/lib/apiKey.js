/* ------------------------------------------------------------------ *
 * Shared Anthropic API key store.
 * Both LBO Model and M&A Merger Model call the Anthropic API straight
 * from the device, so they share one key under one storage slot: set
 * it once in either tool and both pick it up.
 * ------------------------------------------------------------------ */
export const API_KEY_STORAGE = "lbo_anthropic_api_key";

let currentApiKey = "";

export function loadApiKey() {
  try { currentApiKey = localStorage.getItem(API_KEY_STORAGE) || ""; } catch (e) { currentApiKey = ""; }
  return currentApiKey;
}

export function saveApiKey(key) {
  currentApiKey = key || "";
  try {
    if (currentApiKey) localStorage.setItem(API_KEY_STORAGE, currentApiKey);
    else localStorage.removeItem(API_KEY_STORAGE);
  } catch (e) { /* localStorage unavailable, key still held in memory for this session */ }
}

export function getApiKey() {
  return currentApiKey;
}
