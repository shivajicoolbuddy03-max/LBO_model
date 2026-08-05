import { getApiKey } from "./apiKey.js";

export const API_MODEL = "claude-sonnet-4-6";

function stripFences(t) { return t.replace(/```json\s*|```\s*/g, "").trim(); }

export function extractJson(text) {
  const t = stripFences(text);
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < t.length; j++) {
      const ch = t[j];
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
        if (depth === 0) { try { return JSON.parse(t.slice(i, j + 1)); } catch (e) { break; } }
      }
    }
  }
  return null;
}

async function callOnce(system, userContent, useWebSearch, maxTokens) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("No Anthropic API key is set. Add one from the key icon at the top of the page, or switch to Manual mode to build the model without one.");
  const body = { model: API_MODEL, max_tokens: maxTokens || 1000, messages: [{ role: "user", content: userContent }] };
  if (system) body.system = system;
  if (useWebSearch) body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) {
    if (res.status === 401) throw new Error("The Anthropic API key was rejected. Check it in the key settings and try again.");
    throw new Error(data.error.message || "API error");
  }
  const blocks = (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "");
  for (let i = blocks.length - 1; i >= 0; i--) {
    const parsed = extractJson(blocks[i]);
    if (parsed) return parsed;
  }
  const joined = extractJson(blocks.join("\n"));
  if (joined) return joined;
  if (data.stop_reason === "max_tokens") throw new Error("The reply hit the token limit before the JSON closed. Try a more specific name.");
  throw new Error("No valid JSON object found in the model response.");
}

export async function callClaude(system, userContent, opts) {
  const useWebSearch = opts && opts.useWebSearch;
  const maxTokens = (opts && opts.maxTokens) || 1000;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const msg = attempt === 0 ? userContent
        : userContent + "\n\nYour previous reply was not valid JSON. Return ONLY the JSON object, no prose, no fences.";
      return await callOnce(system, msg, useWebSearch, maxTokens);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
