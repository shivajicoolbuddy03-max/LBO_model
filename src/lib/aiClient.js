import { getApiKey, getSelectedProvider } from "./apiKey.js";

/* ------------------------------------------------------------------ *
 * PROVIDER REGISTRY
 * Every tool in this app calls whichever provider is currently
 * selected, using its own key. "Web search" grounding means something
 * different to each provider's API — Anthropic and Google both expose
 * a hosted search tool usable straight from a browser call; OpenAI's
 * Responses API has one too, but OpenAI's API does not enable
 * cross-origin browser requests the way Anthropic's and Google's do
 * (there's no client-facing CORS allowance), so a direct fetch from
 * this page will typically fail with a network-level error regardless
 * of key validity — that's flagged explicitly in the panel and in the
 * error message rather than left to look like a bad key.
 * ------------------------------------------------------------------ */
export const PROVIDERS = {
  anthropic: {
    id: "anthropic", label: "Anthropic Claude", short: "Claude",
    keyPlaceholder: "sk-ant-…", getKeyUrl: "console.anthropic.com",
    note: "Calls api.anthropic.com directly from this device.",
  },
  openai: {
    id: "openai", label: "OpenAI ChatGPT", short: "ChatGPT",
    keyPlaceholder: "sk-…", getKeyUrl: "platform.openai.com/api-keys",
    note: "OpenAI's API generally blocks direct browser calls (no CORS allowance) — this may fail with a network error even with a valid key. Try Claude or Gemini if it does.",
  },
  gemini: {
    id: "gemini", label: "Google Gemini", short: "Gemini",
    keyPlaceholder: "AIza…", getKeyUrl: "aistudio.google.com/apikey",
    note: "Calls generativelanguage.googleapis.com directly from this device.",
  },
};
export const PROVIDER_LIST = Object.values(PROVIDERS);

/* ------------------------------------------------------------------ *
 * JSON EXTRACTION — balanced-brace scan (models sometimes wrap JSON in
 * prose or code fences) plus a light repair pass for the two most
 * common near-misses: thousands separators inside numbers, and a
 * trailing comma before a closing brace/bracket.
 * ------------------------------------------------------------------ */
function stripFences(t) { return t.replace(/```json\s*|```\s*/g, "").trim(); }
function repairJSONString(s) {
  s = s.replace(/(:\s*-?\d{1,3}(?:,\d{3})+(?:\.\d+)?)/g, (m) => m.replace(/,/g, ""));
  s = s.replace(/,\s*([}\]])/g, "$1");
  return s;
}
function extractBalanced(text, from) {
  const start = text.indexOf("{", from);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
export function extractJson(text) {
  const t = stripFences(text || "");
  for (let from = 0; from < t.length; from++) {
    if (t[from] !== "{") continue;
    const slice = extractBalanced(t, from);
    if (!slice) break; // unbalanced from here on — truncated reply
    try { return JSON.parse(slice); } catch (e) { /* fall through */ }
    try { return JSON.parse(repairJSONString(slice)); } catch (e) { /* try next opening brace */ }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * PER-PROVIDER TEXT FETCH — each returns the model's raw text output;
 * JSON extraction and retry logic live above this, shared across all
 * three providers.
 * ------------------------------------------------------------------ */
async function fetchAnthropicText({ apiKey, system, prompt, useWebSearch, maxTokens }) {
  const body = { model: "claude-sonnet-4-6", max_tokens: maxTokens || 1000, messages: [{ role: "user", content: prompt }] };
  if (system) body.system = system;
  if (useWebSearch) body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "x-api-key": apiKey,
      "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) {
    if (res.status === 401) throw new Error("The Anthropic API key was rejected. Check it in the key settings and try again.");
    throw new Error(data.error.message || "Anthropic API error");
  }
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("\n");
}

async function fetchOpenAIText({ apiKey, system, prompt, useWebSearch, maxTokens }) {
  const body = {
    model: "gpt-4.1",
    input: system ? [{ role: "system", content: system }, { role: "user", content: prompt }] : prompt,
    max_output_tokens: Math.max(maxTokens || 1000, 16),
  };
  if (useWebSearch) body.tools = [{ type: "web_search" }];
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) {
    if (res.status === 401) throw new Error("The OpenAI API key was rejected. Check it in the key settings and try again.");
    throw new Error(data.error.message || "OpenAI API error");
  }
  if (typeof data.output_text === "string" && data.output_text) return data.output_text;
  const texts = [];
  (data.output || []).forEach((item) => {
    (item.content || []).forEach((c) => { if (c.type === "output_text" && c.text) texts.push(c.text); });
  });
  return texts.join("\n");
}

async function fetchGeminiText({ apiKey, system, prompt, useWebSearch, maxTokens }) {
  const model = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens || 1000 } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (useWebSearch) body.tools = [{ google_search: {} }];
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (data.error) {
    if (res.status === 400 || res.status === 403) throw new Error("The Gemini API key was rejected. Check it in the key settings and try again.");
    throw new Error(data.error.message || "Gemini API error");
  }
  const cand = (data.candidates || [])[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  return parts.map((p) => p.text || "").join("\n");
}

async function fetchProviderText(provider, args) {
  const isNetworkError = (e) => e instanceof TypeError; // fetch() throws TypeError on CORS/connection failure
  try {
    if (provider === "anthropic") return await fetchAnthropicText(args);
    if (provider === "openai") return await fetchOpenAIText(args);
    if (provider === "gemini") return await fetchGeminiText(args);
    throw new Error(`Unknown AI provider "${provider}".`);
  } catch (e) {
    if (provider === "openai" && isNetworkError(e)) {
      throw new Error("OpenAI's API blocked this browser request (no CORS allowance on their end — this happens with any client-only app, not just this one). Switch to Claude or Gemini, or use Manual mode.");
    }
    throw e;
  }
}

/* ------------------------------------------------------------------ *
 * PUBLIC ENTRY POINT — resolves the current provider + its key,
 * fetches text, extracts JSON, and retries once with a stricter
 * instruction if the first reply wasn't parseable JSON.
 * ------------------------------------------------------------------ */
export async function callAI(system, userContent, opts) {
  const useWebSearch = opts && opts.useWebSearch;
  const maxTokens = (opts && opts.maxTokens) || 1000;
  const provider = (opts && opts.provider) || getSelectedProvider();
  const apiKey = getApiKey(provider);
  if (!apiKey) {
    const label = (PROVIDERS[provider] || {}).label || provider;
    throw new Error(`No ${label} API key is set. Add one from the key icon at the top of the page, or switch to Manual mode to build the model without one.`);
  }
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0 ? userContent
      : userContent + "\n\nYour previous reply was not valid JSON. Return ONLY the JSON object, no prose, no fences.";
    try {
      const text = await fetchProviderText(provider, { apiKey, system, prompt, useWebSearch, maxTokens });
      const parsed = extractJson(text);
      if (parsed) return parsed;
      lastErr = new Error("No valid JSON object found in the model's response.");
    } catch (e) {
      lastErr = e;
      if (/CORS|blocked this browser request|API key was rejected/.test(e.message || "")) break; // no point retrying these
    }
  }
  throw lastErr;
}
