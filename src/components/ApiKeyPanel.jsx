import React, { useState } from "react";
import { KeyRound, X, CheckCircle2 } from "lucide-react";
import { INK, PANEL, PANEL2, LINE, AMBER, TEAL, GREEN, TEXT, MUTED, FAINT, mono, ghostBtn } from "../lib/theme.js";
import { PROVIDERS, PROVIDER_LIST } from "../lib/aiClient.js";
import { loadApiKey, saveApiKey, getSelectedProvider, saveSelectedProvider } from "../lib/apiKey.js";

/* ------------------------------------------------------------------ *
 * Shared across all three tools (LBO Model, M&A Merger Model, SOTP
 * Valuation Builder): pick a provider, manage that provider's key.
 * Every key lives in this device's local storage only. `onChange`
 * fires after any save/remove/provider switch so the host tool can
 * refresh its own "key set?" indicator.
 * ------------------------------------------------------------------ */
export default function ApiKeyPanel({ onClose, onChange }) {
  const [provider, setProvider] = useState(getSelectedProvider());
  const [draft, setDraft] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [savedKeys, setSavedKeys] = useState(() => {
    const m = {};
    PROVIDER_LIST.forEach((p) => { m[p.id] = !!loadApiKey(p.id); });
    return m;
  });
  const info = PROVIDERS[provider];
  const hasKey = savedKeys[provider];

  function selectProvider(id) {
    setProvider(id);
    setDraft("");
    setRevealed(false);
    saveSelectedProvider(id);
    if (onChange) onChange();
  }
  function save() {
    if (!draft.trim()) return;
    saveApiKey(provider, draft.trim());
    setSavedKeys((m) => ({ ...m, [provider]: true }));
    setDraft("");
    setRevealed(false);
    if (onChange) onChange();
  }
  function remove() {
    saveApiKey(provider, "");
    setSavedKeys((m) => ({ ...m, [provider]: false }));
    setRevealed(false);
    if (onChange) onChange();
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(20,20,30,0.4)", zIndex: 50, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "14vh 16px 16px" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 20, width: "100%", maxWidth: 440 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <KeyRound size={16} color={AMBER} />
            <span style={{ fontSize: 15, fontWeight: 700 }}>AI provider &amp; API key</span>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: MUTED, cursor: "pointer", padding: 4 }}>
            <X size={16} />
          </button>
        </div>
        <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.5, margin: "8px 0 14px" }}>
          Pick which AI provider the tools call for research and live web search. Every key is stored only in this device's local storage, sent only to that provider's own API. No key at all is fine too — every tool has a Manual mode.
        </div>

        <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
          {PROVIDER_LIST.map((p) => {
            const on = p.id === provider;
            return (
              <button key={p.id} onClick={() => selectProvider(p.id)} style={{
                fontSize: 12, fontWeight: 700, padding: "7px 12px", borderRadius: 20, cursor: "pointer",
                background: on ? AMBER : "transparent", color: on ? "#fff" : MUTED, border: `1px solid ${on ? AMBER : LINE}`,
                display: "flex", alignItems: "center", gap: 6,
              }}>
                {p.short}
                {savedKeys[p.id] && <span style={{ width: 6, height: 6, borderRadius: "50%", background: on ? "#fff" : GREEN, display: "inline-block" }} />}
              </button>
            );
          })}
        </div>

        <div style={{ fontSize: 11.5, color: MUTED, lineHeight: 1.5, marginBottom: 12 }}>{info.note}</div>

        {hasKey && !revealed ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ flex: 1, background: INK, border: `1px solid ${LINE}`, borderRadius: 7, padding: "10px 12px", fontSize: 13, color: GREEN, ...mono }}>
              <CheckCircle2 size={13} style={{ verticalAlign: -2, marginRight: 6 }} />{info.label} key saved on this device
            </div>
            <button onClick={() => setRevealed(true)} style={ghostBtn}>Change</button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={info.keyPlaceholder}
              autoFocus
              style={{ background: INK, border: `1px solid ${LINE}`, borderRadius: 7, padding: "10px 12px", color: TEXT, fontSize: 13, outline: "none", ...mono }}
            />
            <div style={{ fontSize: 11, color: FAINT }}>Get one at <span style={{ color: TEAL }}>{info.getKeyUrl}</span></div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              {hasKey && <button onClick={remove} style={ghostBtn}>Remove key</button>}
              <button
                onClick={save}
                disabled={!draft.trim()}
                style={{ background: draft.trim() ? AMBER : PANEL2, color: draft.trim() ? "#fff" : MUTED, border: "none", borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 700, cursor: draft.trim() ? "pointer" : "default" }}>
                Save key
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
