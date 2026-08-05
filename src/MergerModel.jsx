import React, { useEffect, useState } from "react";
import {
  Wand2, PencilLine, KeyRound, X, CheckCircle2, Loader2, Play, RotateCcw,
  FileSpreadsheet, TrendingUp, TrendingDown,
} from "lucide-react";
import {
  INK, PANEL, PANEL2, LINE, AMBER, AMBER_DIM, TEAL, GREEN, RED, GOLD, TEXT, MUTED, FAINT, mono, serif, ghostBtn,
} from "./lib/theme.js";
import { loadApiKey, saveApiKey, getApiKey } from "./lib/apiKey.js";
import { callClaude } from "./lib/anthropicClient.js";
import { defaultMergerState, computeDeal } from "./lib/mergerCalc.js";
import { StyleBook, WSheet, writeXlsx } from "./lib/xlsxWriter.js";

/* ------------------------------------------------------------------ *
 * FORMATTERS
 * ------------------------------------------------------------------ */
const fUSD = (v, d = 1) => { const n = Number(v) || 0; const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); return (n < 0 ? "($" : "$") + s + (n < 0 ? ")" : ""); };
const fNum = (v, d = 1) => { const n = Number(v) || 0; const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); return (n < 0 ? "(" : "") + s + (n < 0 ? ")" : ""); };
const fPct1 = (v) => ((v || 0) * 100).toFixed(1) + "%";
const fPctSigned = (v) => ((v || 0) >= 0 ? "+" : "") + ((v || 0) * 100).toFixed(1) + "%";
const fEPS = (v) => "$" + (Number(v) || 0).toFixed(2);

/* ------------------------------------------------------------------ *
 * FIELD DEFINITIONS
 * ------------------------------------------------------------------ */
const assumptionDefs = [
  { k: "offerPrice", label: "Offer Price / Share ($)" },
  { k: "pctCash", label: "% Cash", pct: true },
  { k: "pctDebt", label: "% Debt", pct: true },
  { k: "pctStock", label: "% Stock", pct: true },
  { k: "foregoneCashRate", label: "Foregone Cash Interest Rate", pct: true },
  { k: "debtInterestRate", label: "Debt Interest Rate", pct: true },
  { k: "revSynergyPct", label: "Revenue Synergy %", pct: true },
  { k: "revSynergyCOGSPct", label: "Revenue Synergy COGS %", pct: true },
  { k: "opexSynergyPct", label: "Cost Synergies % of OpEx", pct: true },
  { k: "ppeWriteUpPct", label: "PP&E Write-Up %", pct: true },
  { k: "deprPeriod", label: "Depreciation Period (yrs)" },
  { k: "pctAllocIntangibles", label: "% Allocated to Intangibles", pct: true },
  { k: "amortPeriod", label: "Amortization Period (yrs)" },
  { k: "dtlWriteDown", label: "Write-Down of Existing DTL ($mm)" },
];
const profileDefs = [
  { k: "sharePrice", label: "Share Price ($)" },
  { k: "dilutedSharesMktCap", label: "Diluted Shares — Mkt Cap (000s)" },
  { k: "dilutedSharesEPS", label: "Diluted Shares — EPS Calc (000s)" },
  { k: "taxRate", label: "Tax Rate", pct: true },
];
const sellerOnlyDefs = [
  { k: "bookValueEquity", label: "Book Value of Equity ($mm)" },
  { k: "existingGoodwill", label: "Existing Goodwill ($mm)" },
  { k: "netPPE", label: "Net PP&E ($mm)" },
];
const isFieldDefs = [
  { k: "revenue", label: "Revenue" },
  { k: "cogs", label: "Cost of Goods Sold" },
  { k: "opex", label: "Operating Expenses" },
  { k: "deprPPE", label: "Depreciation of PP&E" },
  { k: "amortIntangibles", label: "Amortization of Intangibles" },
  { k: "sbc", label: "Stock-Based Compensation" },
  { k: "interest", label: "Interest Income / (Expense)" },
];

/* ------------------------------------------------------------------ *
 * SENSITIVITY MATRIX (deterministic, no AI)
 * ------------------------------------------------------------------ */
function buildSensitivity(s) {
  const priceFactors = [1.4667, 1.4, 1.3333, 1.2667, 1.2, 1.1333, 1.0667, 1.0, 0.9333, 0.8667];
  const priceLevels = priceFactors.map((f) => Math.round(s.offerPrice * f * 100) / 100);
  const synergyLevels = [0, 0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.14, 0.16];
  function buildMatrix(varyKey) {
    return priceLevels.map((price) => synergyLevels.map((syn) => {
      const s2 = Object.assign({}, s, { [varyKey]: syn });
      return computeDeal(s2, price).years[1].accretionPct;
    }));
  }
  return { priceLevels, synergyLevels, opexMatrix: buildMatrix("opexSynergyPct"), revMatrix: buildMatrix("revSynergyPct") };
}

/* ------------------------------------------------------------------ *
 * AI RESEARCH — mirrors LBOModel's SOURCE_RULE discipline: primary
 * regulator filings only, never a data aggregator or news article.
 * ------------------------------------------------------------------ */
const SOURCE_RULE = `SOURCE_RULE — primary regulator by jurisdiction (use ONLY these; aggregators, screeners, broker notes, and news articles are banned as sources for any figure):
- United States → SEC EDGAR (10-K / 10-Q)
- Canada → SEDAR+
- India → BSE / NSE (Ind AS annual report / filings)
- United Kingdom → LSE RNS
- Japan → EDINET
- Hong Kong → HKEXnews
- Australia → ASX
- Singapore → SGXNet
- South Korea → DART
- Brazil → CVM / B3
- South Africa → JSE SENS
- Any other jurisdiction → that market's primary securities regulator's official filing system (never a data aggregator)`;

const COMPANY_SCHEMA = `{"jurisdiction":"","source":{"regulator":"","filingName":"","filingDate":""},"sharePrice":0,"dilutedSharesMktCap":0,"dilutedSharesEPS":0,"taxRate":0,"bookValueEquity":0,"existingGoodwill":0,"netPPE":0,"fy1":{"label":"","revenue":0,"cogs":0,"opex":0,"deprPPE":0,"amortIntangibles":0,"sbc":0,"interest":0},"fy2":{"label":"","revenue":0,"cogs":0,"opex":0,"deprPPE":0,"amortIntangibles":0,"sbc":0,"interest":0}}`;

function buildPrompt(companyName) {
  return `Use web search to find recent, publicly disclosed financial data for exactly one company: ${companyName}.

${SOURCE_RULE}

Identify this company's home-market jurisdiction, search that jurisdiction's primary regulator filing system specifically (e.g. site-restricted searches like "site:sec.gov ${companyName} 10-K", "site:hkexnews.hk", "site:nseindia.com" / "site:bseindia.com", "site:disclosure.edinet-fsa.go.jp", etc. as appropriate), and pull every figure from that primary filing. Do not use figures from finance data aggregators, stock screeners, broker/analyst notes, or news articles — those may only be used to locate the underlying filing, never as the source of a number. Use at most 3 web searches. If you cannot verify a figure against a primary filing after that, still provide your best estimate but say so honestly in filingName (e.g. "estimate — primary filing not located").

Return ONLY valid JSON — no markdown code fences, no commentary before, during, or after. Do not narrate your search process; search first, then emit the JSON object as your entire final answer, matching exactly this schema:
${COMPANY_SCHEMA}

Rules:
- Dollar figures in millions, share counts in thousands, rates as decimals (0.21 for 21%).
- jurisdiction = the country/market whose regulator governs this company's filings (e.g. "United States", "India", "Hong Kong").
- source.regulator = which SOURCE_RULE regulator the figures came from. source.filingName = the specific filing, kept short (e.g. "FY2025 Form 10-K"). source.filingDate = filing/period end date.
- "opex" = operating expenses excluding D&A and stock comp if broken out separately; otherwise best available operating expense line.
- fy1 = most recent full fiscal year actuals per the primary filing (label it, e.g. "FY2025A"). fy2 = next fiscal year (consensus estimate if available, else your best projection; label e.g. "FY2026E").
- bookValueEquity = total stockholders'/shareholders' equity. existingGoodwill and netPPE from the most recent balance sheet in the primary filing.
- Never leave a field at 0 unless the true value is genuinely zero.
- Keep all text fields brief — the JSON must fully close within the response.`;
}

async function fetchOneCompany(companyName) {
  try { return await callClaude("", buildPrompt(companyName), { useWebSearch: true, maxTokens: 3072 }); }
  catch (e) { return await callClaude("", buildPrompt(companyName), { useWebSearch: true, maxTokens: 4096 }); }
}

/* ------------------------------------------------------------------ *
 * SMALL UI ATOMS
 * ------------------------------------------------------------------ */
function Eyebrow({ children, color }) {
  return <div style={{ ...mono, fontSize: 10, letterSpacing: 1.6, color: color || MUTED, textTransform: "uppercase" }}>{children}</div>;
}
function Panel({ children, style }) {
  return <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 10, padding: 18, ...(style || {}) }}>{children}</div>;
}
function StatTile({ label, value, sub, color }) {
  return (
    <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 10, padding: 16 }}>
      <Eyebrow>{label}</Eyebrow>
      <div style={{ ...mono, fontSize: 22, fontWeight: 700, color: color || TEXT, marginTop: 8 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: FAINT, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
function KV({ k, v, indent, total }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12,
      padding: total ? "10px 0 7px" : "7px 0",
      borderTop: total ? `1px solid ${LINE}` : "none",
      borderBottom: total ? "none" : `1px dashed ${LINE}`,
      marginTop: total ? 4 : 0,
    }}>
      <span style={{ fontSize: total ? 13.5 : 12.5, color: total ? TEXT : (indent ? MUTED : TEXT), paddingLeft: indent ? 14 : 0, fontWeight: total ? 600 : 400 }}>{k}</span>
      <span style={{ ...mono, fontSize: total ? 14.5 : 12.5, fontWeight: total ? 700 : 500, color: total ? AMBER : TEXT, whiteSpace: "nowrap" }}>{v}</span>
    </div>
  );
}

function NumField({ label, value, onChange, pct, bare, step }) {
  const toDisplay = (v) => (pct ? Math.round((v || 0) * 100000) / 1000 : v);
  const fromDisplay = (v) => (pct ? v / 100 : v);
  const [draft, setDraft] = useState(String(toDisplay(value)));
  const [focused, setFocused] = useState(false);
  if (!focused && String(toDisplay(value)) !== draft) setDraft(String(toDisplay(value)));
  const box = (
    <div style={{ display: "flex", alignItems: "center", background: INK, border: `1px solid ${LINE}`, borderRadius: bare ? 6 : 7 }}>
      <input
        type="number"
        step={step || (pct ? 0.1 : "any")}
        value={draft}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); const nn = parseFloat(draft); if (isFinite(nn)) onChange(fromDisplay(nn)); else setDraft(String(toDisplay(value))); }}
        onChange={(e) => { setDraft(e.target.value); const nn = parseFloat(e.target.value); if (isFinite(nn)) onChange(fromDisplay(nn)); }}
        style={{ flex: 1, minWidth: 0, width: "100%", background: "transparent", border: "none", outline: "none", color: TEXT, ...mono, fontSize: bare ? 12 : 12.5, padding: bare ? "6px 7px" : "8px 9px", textAlign: "right" }}
      />
      {pct && <span style={{ ...mono, fontSize: 10.5, color: FAINT, paddingRight: 8 }}>%</span>}
    </div>
  );
  if (bare) return box;
  return (
    <label style={{ display: "block" }}>
      <div style={{ fontSize: 11, color: MUTED, marginBottom: 5, lineHeight: 1.3 }}>{label}</div>
      {box}
    </label>
  );
}

function CompanyCard({ title, data, onProfile, onYear, sellerExtra }) {
  return (
    <div style={{ background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 10, padding: 18 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: MUTED, marginBottom: 14, paddingBottom: 9, borderBottom: `1px solid ${LINE}`, ...mono }}>{title}</div>
      <div className="mm-grid3">
        {profileDefs.map((def) => (
          <NumField key={def.k} label={def.label} pct={!!def.pct} value={data[def.k]} onChange={(v) => onProfile(def.k, v)} />
        ))}
        {sellerExtra && sellerOnlyDefs.map((def) => (
          <NumField key={def.k} label={def.label} value={data[def.k]} onChange={(v) => onProfile(def.k, v)} />
        ))}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, marginTop: 16 }}>
        <thead>
          <tr>
            <th></th>
            <th style={{ ...mono, fontSize: 10, textTransform: "uppercase", color: MUTED, textAlign: "right", padding: "6px 4px", borderBottom: `1px solid ${TEXT}` }}>{data.years[0].label}</th>
            <th style={{ ...mono, fontSize: 10, textTransform: "uppercase", color: MUTED, textAlign: "right", padding: "6px 4px", borderBottom: `1px solid ${TEXT}` }}>{data.years[1].label}</th>
          </tr>
        </thead>
        <tbody>
          {isFieldDefs.map((def) => (
            <tr key={def.k}>
              <td style={{ padding: "5px 4px", borderBottom: `1px solid ${LINE}`, color: MUTED, fontSize: 12 }}>{def.label}</td>
              {[0, 1].map((i) => (
                <td key={i} style={{ padding: "3px 2px", borderBottom: `1px solid ${LINE}` }}>
                  <NumField bare value={data.years[i][def.k]} onChange={(v) => onYear(i, def.k, v)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function rowBorder(kind) {
  if (kind === "subtotal") return { borderTop: `1px solid ${TEXT}`, borderBottom: `1px solid ${LINE}` };
  if (kind === "total") return { borderTop: `1px solid ${TEXT}`, borderBottom: `3px double ${TEXT}` };
  return { borderBottom: `1px solid ${LINE}` };
}
function FinTable({ entity, cols, rows }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 380 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.5, color: MUTED, padding: "6px 4px", borderBottom: `1px solid ${TEXT}` }}>{entity}</th>
            {cols.map((c) => <th key={c} style={{ textAlign: "right", fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.5, color: MUTED, padding: "6px 4px", borderBottom: `1px solid ${TEXT}`, ...mono }}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => r.spacer ? (
            <tr key={i}><td colSpan={cols.length + 1} style={{ border: "none", padding: "4px 0" }} /></tr>
          ) : (
            <tr key={i} style={rowBorder(r.kind)}>
              <td style={{ padding: "6px 4px", fontSize: r.kind === "indent" ? 12 : 12.5, color: r.kind === "subtotal" || r.kind === "total" ? AMBER : (r.kind === "indent" ? MUTED : TEXT), fontWeight: r.kind === "subtotal" || r.kind === "total" ? 700 : 400 }}>{r.label}</td>
              {r.values.map((v, j) => (
                <td key={j} style={{ padding: "6px 4px", textAlign: "right", ...mono, fontSize: 12.5, color: r.kind === "total" ? AMBER : (r.kind === "indent" ? MUTED : TEXT), fontWeight: r.kind === "subtotal" || r.kind === "total" ? 700 : 400, whiteSpace: "nowrap" }}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function buildStandaloneRows(yearsRaw, calcYears, standaloneKey, sharesCount) {
  const y0 = yearsRaw[0], y1 = yearsRaw[1];
  const c0 = calcYears[0][standaloneKey], c1 = calcYears[1][standaloneKey];
  return [
    { label: "Revenue", values: [fUSD(y0.revenue), fUSD(y1.revenue)] },
    { label: "Cost of Goods Sold", values: [fUSD(y0.cogs), fUSD(y1.cogs)] },
    { label: "Gross Profit", values: [fUSD(c0.gp), fUSD(c1.gp)], kind: "subtotal" },
    { label: "Operating Expenses", values: [fUSD(y0.opex), fUSD(y1.opex)], kind: "indent" },
    { label: "Depreciation of PP&E", values: [fUSD(y0.deprPPE), fUSD(y1.deprPPE)], kind: "indent" },
    { label: "Amortization of Intangibles", values: [fUSD(y0.amortIntangibles), fUSD(y1.amortIntangibles)], kind: "indent" },
    { label: "Stock-Based Compensation", values: [fUSD(y0.sbc), fUSD(y1.sbc)], kind: "indent" },
    { label: "Operating Income", values: [fUSD(c0.oi), fUSD(c1.oi)], kind: "subtotal" },
    { label: "Interest Income / (Expense)", values: [fUSD(y0.interest), fUSD(y1.interest)] },
    { label: "Pre-Tax Income", values: [fUSD(c0.pt), fUSD(c1.pt)], kind: "subtotal" },
    { label: "Income Tax Provision", values: [fUSD(c0.tax), fUSD(c1.tax)] },
    { label: "Net Income", values: [fUSD(c0.ni), fUSD(c1.ni)], kind: "total" },
    { spacer: true },
    { label: "Earnings Per Share (EPS)", values: [fEPS(c0.eps), fEPS(c1.eps)] },
    { label: "Diluted Shares Outstanding", values: [fNum(sharesCount), fNum(sharesCount)] },
  ];
}
function buildCombinedRows(res) {
  const c0 = res.years[0].combined, c1 = res.years[1].combined;
  return [
    { label: "Combined Revenue", values: [fUSD(c0.combinedRevenue), fUSD(c1.combinedRevenue)] },
    { label: "Revenue Synergies", values: [fUSD(c0.revSynergies), fUSD(c1.revSynergies)], kind: "indent" },
    { label: "Cost of Goods Sold", values: [fUSD(c0.combinedCOGS), fUSD(c1.combinedCOGS)] },
    { label: "Revenue Synergy COGS", values: [fUSD(c0.revSynergyCOGS), fUSD(c1.revSynergyCOGS)], kind: "indent" },
    { label: "Gross Profit", values: [fUSD(c0.grossProfit), fUSD(c1.grossProfit)], kind: "subtotal" },
    { label: "Operating Expenses", values: [fUSD(c0.combinedOpex), fUSD(c1.combinedOpex)], kind: "indent" },
    { label: "OpEx Synergies", values: [fUSD(c0.opexSynergies), fUSD(c1.opexSynergies)], kind: "indent" },
    { label: "Depreciation of PP&E", values: [fUSD(c0.combinedDeprPPE), fUSD(c1.combinedDeprPPE)], kind: "indent" },
    { label: "Depr. of PP&E Write-Up", values: [fUSD(c0.deprPPEWriteUp), fUSD(c1.deprPPEWriteUp)], kind: "indent" },
    { label: "Amortization of Intangibles", values: [fUSD(c0.combinedAmort), fUSD(c1.combinedAmort)], kind: "indent" },
    { label: "Amort. of New Intangibles", values: [fUSD(c0.amortNewIntangibles), fUSD(c1.amortNewIntangibles)], kind: "indent" },
    { label: "Stock-Based Compensation", values: [fUSD(c0.combinedSBC), fUSD(c1.combinedSBC)], kind: "indent" },
    { label: "Operating Income", values: [fUSD(c0.opInc), fUSD(c1.opInc)], kind: "subtotal" },
    { label: "Interest Income / (Expense)", values: [fUSD(c0.combinedInterest), fUSD(c1.combinedInterest)] },
    { label: "Foregone Interest on Cash", values: [fUSD(c0.foregoneInterest), fUSD(c1.foregoneInterest)], kind: "indent" },
    { label: "Interest Paid on New Debt", values: [fUSD(c0.newDebtInterest), fUSD(c1.newDebtInterest)], kind: "indent" },
    { label: "Pre-Tax Income", values: [fUSD(c0.preTax), fUSD(c1.preTax)], kind: "subtotal" },
    { label: "Income Tax Provision", values: [fUSD(c0.tax), fUSD(c1.tax)] },
    { label: "Net Income", values: [fUSD(c0.netIncome), fUSD(c1.netIncome)], kind: "total" },
    { spacer: true },
    { label: "Earnings Per Share (EPS)", values: [fEPS(c0.proFormaEPS), fEPS(c1.proFormaEPS)] },
    { label: "Diluted Shares Outstanding", values: [fNum(c0.combinedDilutedShares), fNum(c1.combinedDilutedShares)] },
  ];
}

function hexToRgb(hex) { const m = hex.replace("#", ""); return [parseInt(m.substr(0, 2), 16), parseInt(m.substr(2, 2), 16), parseInt(m.substr(4, 2), 16)]; }
function mixHex(hex1, hex2, t) { const a = hexToRgb(hex1), b = hexToRgb(hex2); return `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)},${Math.round(a[1] + (b[1] - a[1]) * t)},${Math.round(a[2] + (b[2] - a[2]) * t)})`; }
function Heatmap({ matrix, priceLevels, synergyLevels }) {
  let maxAbs = 0; matrix.forEach((row) => row.forEach((v) => { if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v); }));
  if (maxAbs === 0) maxAbs = 1;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", ...mono, fontSize: 11.5, width: "100%", minWidth: 640 }}>
        <thead>
          <tr>
            <th></th>
            {synergyLevels.map((c) => <th key={c} style={{ padding: "8px 6px", textAlign: "center", color: MUTED, fontWeight: 500, fontSize: 10.5 }}>{(c * 100).toFixed(0)}%</th>)}
          </tr>
        </thead>
        <tbody>
          {matrix.map((row, ri) => (
            <tr key={ri}>
              <td style={{ color: TEXT, fontWeight: 600, textAlign: "right", padding: "9px 12px 9px 6px" }}>{fUSD(priceLevels[ri], 0)}</td>
              {row.map((v, ci) => {
                const t = Math.min(Math.abs(v) / maxAbs, 1);
                const color = v >= 0 ? mixHex(PANEL, GREEN, 0.28 + t * 0.62) : mixHex(PANEL, RED, 0.28 + t * 0.62);
                const isBase = ri === 7 && synergyLevels[ci] === 0.10;
                return (
                  <td key={ci} style={{ padding: "9px 6px", textAlign: "center", color: "#fff", fontWeight: 500, background: color, border: isBase ? `2px solid ${AMBER}` : `1px solid ${INK}` }}>
                    {fPctSigned(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * API KEY PANEL — same storage slot as LBO Model, so one key serves
 * both tools.
 * ------------------------------------------------------------------ */
function ApiKeyPanel({ hasKey, onSave, onClose }) {
  const [draft, setDraft] = useState("");
  const [revealed, setRevealed] = useState(false);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 50, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "14vh 16px 16px" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 20, width: "100%", maxWidth: 420 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <KeyRound size={16} color={AMBER} />
            <span style={{ fontSize: 15, fontWeight: 700 }}>Anthropic API key</span>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: MUTED, cursor: "pointer", padding: 4 }}>
            <X size={16} />
          </button>
        </div>
        <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.5, margin: "8px 0 14px" }}>
          The AI financials lookup calls the Anthropic API straight from this device, so it needs your own key — the same one used by the LBO Model tool. Stored only in this app's local storage, never sent anywhere but api.anthropic.com. Get one at{" "}
          <span style={{ color: TEAL }}>console.anthropic.com</span>. No key at all is fine too — use Manual Financials mode instead.
        </div>
        {hasKey && !revealed ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ flex: 1, background: INK, border: `1px solid ${LINE}`, borderRadius: 7, padding: "10px 12px", fontSize: 13, color: GREEN, ...mono }}>
              <CheckCircle2 size={13} style={{ verticalAlign: -2, marginRight: 6 }} />Key saved on this device
            </div>
            <button onClick={() => setRevealed(true)} style={ghostBtn}>Change</button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="sk-ant-…"
              autoFocus
              style={{ background: INK, border: `1px solid ${LINE}`, borderRadius: 7, padding: "10px 12px", color: TEXT, fontSize: 13, outline: "none", ...mono }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              {hasKey && (
                <button onClick={() => { onSave(""); setDraft(""); setRevealed(false); }} style={ghostBtn}>Remove key</button>
              )}
              <button
                onClick={() => { if (draft.trim()) { onSave(draft.trim()); setDraft(""); setRevealed(false); onClose(); } }}
                disabled={!draft.trim()}
                style={{ background: draft.trim() ? AMBER : PANEL2, color: draft.trim() ? "#180D03" : MUTED, border: "none", borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 700, cursor: draft.trim() ? "pointer" : "default" }}>
                Save key
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * EXCEL EXPORT — same raw-OOXML writer LBO Model uses, no CDN
 * dependency.
 * ------------------------------------------------------------------ */
const XP = { title: "1F4E78", banner: "2E5395", white: "FFFFFF", input: "0000FA", bad: "9C0006", posFill: "6D7BC7", negFill: "9C3B3B" };
const USDFMT = '$#,##0.0;[Red]($#,##0.0)';
const PCTFMT = "0.0%";
const NUMFMT = "#,##0.0";
const EPSFMT = "$#,##0.00";

function buildMergerWorkbook(d) {
  const s = d.state, r = d.result, sens = d.sensitivity;
  const SB = StyleBook();
  const S = {
    title: SB.s({ font: { b: true, sz: 14, color: XP.white }, fill: XP.title, align: { v: "center" } }),
    subtitle: SB.s({ font: { sz: 9, color: XP.white }, fill: XP.title }),
    banner: SB.s({ font: { b: true, color: XP.white }, fill: XP.banner }),
    lbl: SB.s({ font: {} }),
    lblB: SB.s({ font: { b: true } }),
    inputUSD: SB.s({ font: { color: XP.input }, numFmt: USDFMT }),
    inputPct: SB.s({ font: { color: XP.input }, numFmt: PCTFMT }),
    inputInt: SB.s({ font: { color: XP.input }, numFmt: "0" }),
    formUSD: SB.s({ numFmt: USDFMT }),
    formPct: SB.s({ numFmt: PCTFMT }),
    formNum: SB.s({ numFmt: NUMFMT }),
    formEPS: SB.s({ numFmt: EPSFMT }),
    total: SB.s({ font: { b: true, color: XP.input }, border: { top: { style: "thin" } }, numFmt: USDFMT }),
  };
  const accStyle = (v) => SB.s({ font: { b: true, color: v >= 0 ? XP.input : XP.bad }, numFmt: PCTFMT });
  const hdrPctCenter = SB.s({ font: { b: true, color: XP.input }, numFmt: "0%", align: { h: "center" } });
  const priceLbl = SB.s({ font: { b: true, color: XP.input }, numFmt: USDFMT });
  const heatCell = (v) => SB.s({ font: { b: true, color: XP.white }, fill: v >= 0 ? XP.posFill : XP.negFill, numFmt: "0.0%", align: { h: "center" } });

  // ---------- Summary ----------
  const ws1 = WSheet("Summary", { cols: [34, 20, 20, 20] });
  ws1.txt(0, 1, `Merger Model — ${s.acquirerName} acquires ${s.targetName}`, S.title).band(0, 3, 1, S.title).merge(0, 1, 3, 1);
  ws1.txt(0, 2, "($ in Millions, Except Per Share Amounts; Share Counts in Thousands)", S.subtitle).band(0, 3, 2, S.subtitle).merge(0, 2, 3, 2);
  let row = 4;
  ws1.txt(0, row, "DEAL SUMMARY", S.banner).band(0, 3, row, S.banner).merge(0, row, 3, row); row++;
  [
    ["Offer Price / Share", s.offerPrice, S.formUSD],
    ["Premium to Target Share Price", s.offerPrice / s.seller.sharePrice - 1, S.formPct],
    ["Equity Purchase Price", r.equityPurchasePrice, S.formUSD],
    ["Total Goodwill Created", r.totalGoodwill, S.formUSD],
    [`${s.buyer.years[0].label} EPS Accretion / (Dilution)`, r.years[0].accretionPct, S.formPct],
    [`${s.buyer.years[1].label} EPS Accretion / (Dilution)`, r.years[1].accretionPct, S.formPct],
  ].forEach(([label, val, style]) => { ws1.txt(0, row, label, S.lbl); ws1.num(1, row, val, style); row++; });
  row += 1;
  ws1.txt(0, row, "SOURCING (primary regulator filings only)", S.banner).band(0, 3, row, S.banner).merge(0, row, 3, row); row++;
  [["Acquirer", s.acquirerName, s.buyer], ["Target", s.targetName, s.seller]].forEach(([role, name, side]) => {
    ws1.txt(0, row, `${role} — ${name}`, S.lbl);
    ws1.txt(1, row, side.jurisdiction || "", S.lbl);
    ws1.txt(2, row, (side.source && side.source.regulator) || "unverified", S.lbl);
    ws1.txt(3, row, [(side.source && side.source.filingName) || "", (side.source && side.source.filingDate) || ""].filter(Boolean).join(" · "), S.lbl);
    row++;
  });

  // ---------- Assumptions & Goodwill ----------
  const ws2 = WSheet("Assumptions & Goodwill", { cols: [34, 16, 6, 34, 16] });
  ws2.txt(0, 1, "Transaction Assumptions", S.banner).band(0, 4, 1, S.banner).merge(0, 1, 4, 1);
  const assump = [
    ["Per Share Purchase Price", s.offerPrice, S.inputUSD],
    ["% Cash", s.pctCash, S.inputPct], ["% Debt", s.pctDebt, S.inputPct], ["% Stock", s.pctStock, S.inputPct],
    ["Foregone Cash Interest Rate", s.foregoneCashRate, S.inputPct], ["Debt Interest Rate", s.debtInterestRate, S.inputPct],
    ["Revenue Synergy %", s.revSynergyPct, S.inputPct], ["Revenue Synergy COGS %", s.revSynergyCOGSPct, S.inputPct],
    ["Cost Synergies % OpEx", s.opexSynergyPct, S.inputPct], ["PP&E Write-Up %", s.ppeWriteUpPct, S.inputPct],
    ["Depreciation Period (yrs)", s.deprPeriod, S.inputInt], ["% Allocated to Intangibles", s.pctAllocIntangibles, S.inputPct],
    ["Amortization Period (yrs)", s.amortPeriod, S.inputInt], ["Write-Down of Existing DTL", s.dtlWriteDown, S.inputUSD],
  ];
  let r2 = 3;
  assump.forEach(([label, val, style]) => { ws2.txt(0, r2, label, S.lbl); ws2.num(1, r2, val, style); r2++; });
  ws2.txt(3, 3, "Sources of Funds", S.banner).band(3, 4, 3, S.banner).merge(3, 3, 4, 3);
  const sources = [
    ["Equity Purchase Price", r.equityPurchasePrice, S.formUSD], ["Cash Used", r.cashUsed, S.formUSD],
    ["Debt Issued", r.debtIssued, S.formUSD], ["New Shares Issued (000s)", r.newSharesIssued, S.formNum],
  ];
  let r3 = 4; sources.forEach(([label, val, style]) => { ws2.txt(3, r3, label, S.lbl); ws2.num(4, r3, val, style); r3++; });
  let r4 = r2 + 2;
  ws2.txt(0, r4, "Goodwill Calculation", S.banner).band(0, 1, r4, S.banner).merge(0, r4, 1, r4); r4++;
  [
    ["Equity Purchase Price", r.equityPurchasePrice, false],
    ["Less: Target Book Value", -s.seller.bookValueEquity, false],
    ["Plus: Write-Off of Existing Goodwill", s.seller.existingGoodwill, false],
    ["Total Allocable Purchase Premium", r.totalAllocablePremium, true],
    ["Less: Write-Up of PP&E", -r.ppeWriteUpAmount, false],
    ["Less: Write-Up of Intangibles", -r.intangiblesWriteUpAmount, false],
    ["Less: Write-Down of DTL", -s.dtlWriteDown, false],
    ["Plus: New Deferred Tax Liability", r.newDTL, false],
    ["Total Goodwill Created", r.totalGoodwill, true],
  ].forEach(([label, val, isTotal]) => { ws2.txt(0, r4, label, S.lbl); ws2.num(1, r4, val, isTotal ? S.total : S.formUSD); r4++; });

  // ---------- Income Statements ----------
  const ws3 = WSheet("Income Statements", { cols: [30, 15, 15, 4, 15, 15] });
  function isBlock(startRow, title, y0, y1) {
    ws3.txt(0, startRow, title, S.banner).band(0, 1, startRow, S.banner).merge(0, startRow, 1, startRow);
    let rr = startRow + 1;
    ws3.txt(1, rr, y0.label, S.lblB); ws3.txt(2, rr, y1.label, S.lblB); rr++;
    [
      ["Revenue", y0.revenue, y1.revenue, true], ["Cost of Goods Sold", y0.cogs, y1.cogs, true],
      ["Gross Profit", y0.revenue - y0.cogs, y1.revenue - y1.cogs, false],
      ["Operating Expenses", y0.opex, y1.opex, true], ["Depreciation of PP&E", y0.deprPPE, y1.deprPPE, true],
      ["Amortization of Intangibles", y0.amortIntangibles, y1.amortIntangibles, true], ["Stock-Based Compensation", y0.sbc, y1.sbc, true],
    ].forEach(([label, v0, v1, isInput]) => {
      ws3.txt(0, rr, label, S.lbl);
      ws3.num(1, rr, v0, isInput ? S.inputUSD : S.formUSD);
      ws3.num(2, rr, v1, isInput ? S.inputUSD : S.formUSD);
      rr++;
    });
    return rr;
  }
  let nextRow = isBlock(1, `${s.acquirerName} (Acquirer)`, s.buyer.years[0], s.buyer.years[1]);
  nextRow = isBlock(nextRow + 2, `${s.targetName} (Target)`, s.seller.years[0], s.seller.years[1]);
  const startC = nextRow + 2;
  ws3.txt(0, startC, "Pro Forma Combined", S.banner).band(0, 2, startC, S.banner).merge(0, startC, 2, startC);
  let rc = startC + 1;
  ws3.txt(1, rc, s.buyer.years[0].label, S.lblB); ws3.txt(2, rc, s.buyer.years[1].label, S.lblB); rc++;
  const c0 = r.years[0].combined, c1 = r.years[1].combined;
  [
    ["Combined Revenue", c0.combinedRevenue, c1.combinedRevenue], ["Revenue Synergies", c0.revSynergies, c1.revSynergies],
    ["Cost of Goods Sold", c0.combinedCOGS, c1.combinedCOGS], ["Revenue Synergy COGS", c0.revSynergyCOGS, c1.revSynergyCOGS],
    ["Gross Profit", c0.grossProfit, c1.grossProfit], ["Operating Expenses", c0.combinedOpex, c1.combinedOpex],
    ["OpEx Synergies", c0.opexSynergies, c1.opexSynergies], ["Depreciation of PP&E", c0.combinedDeprPPE, c1.combinedDeprPPE],
    ["Depr. of PP&E Write-Up", c0.deprPPEWriteUp, c1.deprPPEWriteUp], ["Amortization of Intangibles", c0.combinedAmort, c1.combinedAmort],
    ["Amort. of New Intangibles", c0.amortNewIntangibles, c1.amortNewIntangibles], ["Stock-Based Compensation", c0.combinedSBC, c1.combinedSBC],
    ["Operating Income", c0.opInc, c1.opInc], ["Interest Income / (Expense)", c0.combinedInterest, c1.combinedInterest],
    ["Foregone Interest on Cash", c0.foregoneInterest, c1.foregoneInterest], ["Interest Paid on New Debt", c0.newDebtInterest, c1.newDebtInterest],
    ["Pre-Tax Income", c0.preTax, c1.preTax], ["Income Tax Provision", c0.tax, c1.tax],
  ].forEach(([label, v0, v1]) => { ws3.txt(0, rc, label, S.lbl); ws3.num(1, rc, v0, S.formUSD); ws3.num(2, rc, v1, S.formUSD); rc++; });
  ws3.txt(0, rc, "Net Income", S.lblB); ws3.num(1, rc, c0.netIncome, S.total); ws3.num(2, rc, c1.netIncome, S.total); rc += 2;
  ws3.txt(0, rc, "Pro Forma EPS", S.lbl); ws3.num(1, rc, c0.proFormaEPS, S.formEPS); ws3.num(2, rc, c1.proFormaEPS, S.formEPS); rc++;
  ws3.txt(0, rc, "Accretion / (Dilution) %", S.lblB);
  ws3.num(1, rc, r.years[0].accretionPct, accStyle(r.years[0].accretionPct));
  ws3.num(2, rc, r.years[1].accretionPct, accStyle(r.years[1].accretionPct));

  // ---------- Sensitivity ----------
  const ws4 = WSheet("Sensitivity", { cols: [14, ...Array(9).fill(10)] });
  function sensBlock(startRow, title, matrix) {
    ws4.txt(0, startRow, title, S.banner).band(0, 9, startRow, S.banner).merge(0, startRow, 9, startRow);
    let rr = startRow + 1;
    ws4.txt(0, rr, "Price \\ Synergy%", S.lblB);
    sens.synergyLevels.forEach((syn, ci) => ws4.num(ci + 1, rr, syn, hdrPctCenter));
    rr++;
    matrix.forEach((mrow, ri) => {
      ws4.num(0, rr, sens.priceLevels[ri], priceLbl);
      mrow.forEach((v, ci) => ws4.num(ci + 1, rr, v, heatCell(v)));
      rr++;
    });
    return rr;
  }
  const sr = sensBlock(1, "EPS Accretion/Dilution vs. Purchase Price & OpEx Synergies", sens.opexMatrix);
  sensBlock(sr + 2, "EPS Accretion/Dilution vs. Purchase Price & Revenue Synergies", sens.revMatrix);

  return writeXlsx([ws1, ws2, ws3, ws4], SB);
}

/* ------------------------------------------------------------------ *
 * MAIN
 * ------------------------------------------------------------------ */
export default function MergerModel() {
  const [state, setState] = useState(defaultMergerState);
  const [fetchMode, setFetchMode] = useState("ai");
  const [fetching, setFetching] = useState(false);
  const [fetchStatus, setFetchStatus] = useState(null);
  const [dashboard, setDashboard] = useState(() => {
    const initial = defaultMergerState();
    return { state: initial, result: computeDeal(initial), sensitivity: buildSensitivity(initial) };
  });
  const [tab, setTab] = useState("buyer");
  const [hasKey, setHasKey] = useState(false);
  const [showKeyPanel, setShowKeyPanel] = useState(false);
  const [exportError, setExportError] = useState("");

  useEffect(() => { setHasKey(!!loadApiKey()); }, []);

  const setAssumption = (k, v) => setState((p) => ({ ...p, [k]: v }));
  const setProfile = (side, k, v) => setState((p) => ({ ...p, [side]: { ...p[side], [k]: v } }));
  const setYearField = (side, idx, k, v) => setState((p) => {
    const years = p[side].years.slice();
    years[idx] = { ...years[idx], [k]: v };
    return { ...p, [side]: { ...p[side], years } };
  });

  async function handleFetch() {
    const acquirer = state.acquirerName.trim(), target = state.targetName.trim();
    if (!acquirer || !target) return;
    if (!getApiKey()) {
      setFetchStatus({ err: true, text: "Add your Anthropic API key (key icon, top right) to run AI research, or switch to Manual Financials mode to build the model yourself with no key." });
      return;
    }
    setFetching(true);
    setFetchStatus({ err: false, text: `Searching for recent financials on ${acquirer} and ${target}… (running both lookups in parallel)` });
    try {
      const [acqData, tgtData] = await Promise.all([fetchOneCompany(acquirer), fetchOneCompany(target)]);
      setState((prev) => {
        const next = { ...prev, acquirerName: acquirer, targetName: target };
        next.buyer = {
          ...prev.buyer,
          sharePrice: acqData.sharePrice, dilutedSharesMktCap: acqData.dilutedSharesMktCap, dilutedSharesEPS: acqData.dilutedSharesEPS,
          taxRate: acqData.taxRate, jurisdiction: acqData.jurisdiction || "", source: acqData.source || {},
          years: [
            { label: (acqData.fy1 && acqData.fy1.label) || "FY1", ...acqData.fy1 },
            { label: (acqData.fy2 && acqData.fy2.label) || "FY2", ...acqData.fy2 },
          ],
        };
        next.seller = {
          ...prev.seller,
          sharePrice: tgtData.sharePrice, dilutedSharesMktCap: tgtData.dilutedSharesMktCap, dilutedSharesEPS: tgtData.dilutedSharesEPS,
          taxRate: tgtData.taxRate, bookValueEquity: tgtData.bookValueEquity, existingGoodwill: tgtData.existingGoodwill, netPPE: tgtData.netPPE,
          jurisdiction: tgtData.jurisdiction || "", source: tgtData.source || {},
          years: [
            { label: (tgtData.fy1 && tgtData.fy1.label) || "FY1", ...tgtData.fy1 },
            { label: (tgtData.fy2 && tgtData.fy2.label) || "FY2", ...tgtData.fy2 },
          ],
        };
        next.offerPrice = Math.round(next.seller.sharePrice * 1.2 * 100) / 100;
        return next;
      });
      const srcLine = (label, jurisdiction, source) =>
        `${label}: ${jurisdiction || "—"} · ${(source && source.regulator) || "source unverified"}${source && source.filingName ? " — " + source.filingName : ""}${source && source.filingDate ? " (" + source.filingDate + ")" : ""}`;
      setFetchStatus({
        err: false,
        text: `Pulled estimates for ${acquirer} and ${target}. Review the fields below, then Run Analysis.`,
        acquirerLine: srcLine("Acquirer", acqData.jurisdiction, acqData.source),
        targetLine: srcLine("Target", tgtData.jurisdiction, tgtData.source),
      });
    } catch (err) {
      setFetchStatus({ err: true, text: `Couldn't fetch financials automatically (${err.message}). Try again, or switch to Manual Financials mode.` });
    } finally {
      setFetching(false);
    }
  }

  function runAnalysis() {
    const snapshot = JSON.parse(JSON.stringify(state));
    const result = computeDeal(snapshot);
    const sensitivity = buildSensitivity(snapshot);
    setDashboard({ state: snapshot, result, sensitivity });
    setTab("buyer");
  }
  function resetExample() {
    const initial = defaultMergerState();
    setState(initial);
    setFetchStatus(null);
    setDashboard({ state: initial, result: computeDeal(initial), sensitivity: buildSensitivity(initial) });
  }
  function handleExport() {
    try {
      setExportError("");
      const bytes = buildMergerWorkbook(dashboard);
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `Merger-Model-${dashboard.state.acquirerName}-${dashboard.state.targetName}.xlsx`.replace(/[^a-z0-9\-.]/gi, "_");
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError("The workbook could not be built: " + ((e && e.message) || String(e)));
    }
  }

  const ds = dashboard.state, dr = dashboard.result;

  return (
    <div style={{ background: INK, minHeight: "100vh", color: TEXT, fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif" }}>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "36px 22px 90px" }}>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginBottom: 22 }}>
          <div>
            <Eyebrow color={AMBER}>M&amp;A merger desk</Eyebrow>
            <h1 className="mm-hero" style={{ ...serif, fontWeight: 700, margin: "8px 0 6px", lineHeight: 1.05, letterSpacing: -0.5 }}>
              Merger <span style={{ color: AMBER, fontStyle: "italic" }}>Model</span>
            </h1>
            <p style={{ color: MUTED, fontSize: 14.5, maxWidth: 580, margin: 0, lineHeight: 1.55 }}>
              Enter company names for an AI-assisted first pass, or key in historical financials directly — runs the same accretion / dilution math as the classic strategic-acquirer template, live, in your browser.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ border: `1px solid ${LINE}`, borderRadius: 20, padding: "6px 13px", ...mono, fontSize: 10, letterSpacing: 1, color: MUTED, whiteSpace: "nowrap" }}>
              {"● LIVE · ACCRETION / DILUTION"}
            </div>
            <button onClick={() => setShowKeyPanel(true)} style={ghostBtn}>
              <KeyRound size={13} /> {hasKey ? "Key set" : "Add key"}
            </button>
          </div>
        </div>

        {showKeyPanel && (
          <ApiKeyPanel hasKey={hasKey} onSave={(k) => { saveApiKey(k); setHasKey(!!k); }} onClose={() => setShowKeyPanel(false)} />
        )}

        <div className="mm-grid4" style={{ marginBottom: 28 }}>
          <StatTile label="Offer / Share" value={fUSD(ds.offerPrice, 2)} sub={`${fPctSigned(ds.offerPrice / ds.seller.sharePrice - 1)} premium to ${fUSD(ds.seller.sharePrice, 2)}`} />
          <StatTile label="Equity Purchase Price" value={fUSD(dr.equityPurchasePrice)} sub={`${fPct1(ds.pctCash)} cash · ${fPct1(ds.pctDebt)} debt · ${fPct1(ds.pctStock)} stock`} />
          <StatTile label="Goodwill Created" value={fUSD(dr.totalGoodwill)} sub={`of ${fUSD(dr.totalAllocablePremium)} allocable premium`} />
          <StatTile
            label={`${ds.buyer.years[1].label} EPS Impact`}
            value={fPctSigned(dr.years[1].accretionPct)}
            color={dr.years[1].accretionPct >= 0 ? GREEN : RED}
            sub={`${dr.years[1].accretionPct >= 0 ? "accretive" : "dilutive"}, vs. ${fPctSigned(dr.years[0].accretionPct)} in ${ds.buyer.years[0].label}`}
          />
        </div>

        <Panel style={{ marginBottom: 24 }}>
          <Eyebrow color={AMBER}>Step 1 · Deal setup</Eyebrow>
          <div style={{ fontSize: 12.5, color: MUTED, margin: "6px 0 18px" }}>Choose how to source financials, then confirm the acquirer and target.</div>
          <div className="mm-modegrid" style={{ marginBottom: 18 }}>
            {[
              { id: "ai", title: "Company Names", body: "AI looks up recent public financials for you to review", Icon: Wand2 },
              { id: "manual", title: "Manual Financials", body: "Enter historical figures yourself", Icon: PencilLine },
            ].map((opt) => {
              const on = fetchMode === opt.id;
              return (
                <button key={opt.id} onClick={() => setFetchMode(opt.id)} style={{ textAlign: "left", background: on ? AMBER_DIM : "transparent", border: `1px solid ${on ? AMBER : LINE}`, borderRadius: 8, padding: 13, cursor: "pointer" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, fontWeight: 700, color: on ? AMBER : TEXT, marginBottom: 3 }}>
                    <opt.Icon size={14} /> {opt.title}
                  </div>
                  <div style={{ fontSize: 11.5, color: MUTED }}>{opt.body}</div>
                </button>
              );
            })}
          </div>
          <div className="mm-namerow">
            <label>
              <div style={{ fontSize: 11.5, color: MUTED, marginBottom: 5 }}>Acquirer</div>
              <input value={state.acquirerName} onChange={(e) => setState((p) => ({ ...p, acquirerName: e.target.value }))}
                style={{ width: "100%", background: INK, border: `1px solid ${LINE}`, borderRadius: 7, padding: "9px 10px", color: TEXT, fontSize: 13, outline: "none" }} />
            </label>
            <label>
              <div style={{ fontSize: 11.5, color: MUTED, marginBottom: 5 }}>Target</div>
              <input value={state.targetName} onChange={(e) => setState((p) => ({ ...p, targetName: e.target.value }))}
                style={{ width: "100%", background: INK, border: `1px solid ${LINE}`, borderRadius: 7, padding: "9px 10px", color: TEXT, fontSize: 13, outline: "none" }} />
            </label>
            {fetchMode === "ai" && (
              <button onClick={handleFetch} disabled={fetching} style={{ display: "flex", alignItems: "center", gap: 8, background: GOLD, color: "#241a02", border: "none", borderRadius: 8, padding: "11px 18px", fontSize: 13, fontWeight: 700, cursor: fetching ? "wait" : "pointer", opacity: fetching ? 0.6 : 1, whiteSpace: "nowrap" }}>
                {fetching ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />} {fetching ? "Fetching…" : "Fetch with AI"}
              </button>
            )}
          </div>
          {fetchStatus && (
            <div style={{ fontSize: 12.5, color: fetchStatus.err ? RED : MUTED, margin: "14px 0 0", lineHeight: 1.6 }}>
              {fetchStatus.text}
              {fetchStatus.acquirerLine && <div style={{ marginTop: 6 }}>{fetchStatus.acquirerLine}</div>}
              {fetchStatus.targetLine && <div>{fetchStatus.targetLine}</div>}
              {(fetchStatus.acquirerLine || fetchStatus.targetLine) && <div style={{ marginTop: 4 }}>Figures not traced to a primary regulator filing are marked "source unverified" above — confirm those before relying on them.</div>}
            </div>
          )}
          <div style={{ fontSize: 11.5, color: MUTED, background: INK, border: `1px dashed ${LINE}`, padding: "10px 12px", borderRadius: 7, marginTop: 16, lineHeight: 1.5 }}>
            AI-sourced figures are a starting estimate pulled via live web search — always verify against the filing before relying on this for a real decision. Every field below stays editable.
          </div>
        </Panel>

        <Panel style={{ marginBottom: 24 }}>
          <Eyebrow color={AMBER}>Step 2 · Transaction assumptions</Eyebrow>
          <div style={{ fontSize: 12.5, color: MUTED, margin: "6px 0 16px" }}>Consideration mix, financing terms, and purchase-accounting assumptions.</div>
          <div className="mm-grid4">
            {assumptionDefs.map((def) => (
              <NumField key={def.k} label={def.label} pct={!!def.pct} value={state[def.k]} onChange={(v) => setAssumption(def.k, v)} />
            ))}
          </div>
        </Panel>

        <Panel style={{ marginBottom: 24 }}>
          <Eyebrow color={AMBER}>Step 3 · Company financials</Eyebrow>
          <div style={{ fontSize: 12.5, color: MUTED, margin: "6px 0 16px" }}>Market data plus two years of income statement history for each company.</div>
          <div className="mm-cols2">
            <CompanyCard title={`${state.acquirerName} (Acquirer)`} data={state.buyer} onProfile={(k, v) => setProfile("buyer", k, v)} onYear={(i, k, v) => setYearField("buyer", i, k, v)} />
            <CompanyCard title={`${state.targetName} (Target)`} data={state.seller} onProfile={(k, v) => setProfile("seller", k, v)} onYear={(i, k, v) => setYearField("seller", i, k, v)} sellerExtra />
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 22, flexWrap: "wrap" }}>
            <button onClick={runAnalysis} style={{ display: "flex", alignItems: "center", gap: 8, background: AMBER, color: "#180D03", border: "none", borderRadius: 8, padding: "12px 20px", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
              <Play size={15} /> Run Analysis
            </button>
            <button onClick={resetExample} style={ghostBtn}><RotateCcw size={14} /> Reset to example</button>
          </div>
        </Panel>

        <div className="mm-cols2" style={{ marginBottom: 24 }}>
          <Panel>
            <Eyebrow color={TEAL}>Goodwill calculation</Eyebrow>
            <div style={{ marginTop: 10 }}>
              <KV k="Equity Purchase Price" v={fUSD(dr.equityPurchasePrice)} />
              <KV k="Less: Target Book Value" v={`(${fUSD(ds.seller.bookValueEquity)})`} />
              <KV k="Plus: Write-Off of Existing Goodwill" v={fUSD(ds.seller.existingGoodwill)} />
              <KV k="Total Allocable Purchase Premium" v={fUSD(dr.totalAllocablePremium)} total />
              <KV k="Less: Write-Up of PP&amp;E" v={`(${fUSD(dr.ppeWriteUpAmount)})`} />
              <KV k="Less: Write-Up of Intangibles" v={`(${fUSD(dr.intangiblesWriteUpAmount)})`} />
              <KV k="Less: Write-Down of DTL" v={`(${fUSD(ds.dtlWriteDown)})`} />
              <KV k="Plus: New Deferred Tax Liability" v={fUSD(dr.newDTL)} />
              <KV k="Total Goodwill Created" v={fUSD(dr.totalGoodwill)} total />
            </div>
          </Panel>
          <Panel>
            <Eyebrow color={TEAL}>Sources of funds</Eyebrow>
            <div style={{ marginTop: 10 }}>
              <KV k="Equity Purchase Price" v={fUSD(dr.equityPurchasePrice)} />
              <KV k="— Cash Used" v={fUSD(dr.cashUsed)} indent />
              <KV k="— Debt Issued" v={fUSD(dr.debtIssued)} indent />
              <KV k="— New Shares Issued (000s)" v={fNum(dr.newSharesIssued)} indent />
              <KV k="Total Sources" v={fUSD(dr.equityPurchasePrice)} total />
            </div>
          </Panel>
        </div>

        <Panel style={{ marginBottom: 24 }}>
          <Eyebrow color={TEAL}>Pro forma income statement</Eyebrow>
          <div style={{ display: "flex", gap: 8, margin: "12px 0 14px", flexWrap: "wrap" }}>
            {[["buyer", ds.acquirerName], ["seller", ds.targetName], ["combined", "Combined"]].map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)} style={{ ...mono, fontSize: 11, padding: "6px 14px", borderRadius: 20, cursor: "pointer", background: tab === id ? AMBER : "transparent", color: tab === id ? "#180D03" : MUTED, border: `1px solid ${tab === id ? AMBER : LINE}` }}>
                {label}
              </button>
            ))}
          </div>
          {tab === "buyer" && <FinTable entity={ds.acquirerName} cols={[ds.buyer.years[0].label, ds.buyer.years[1].label]} rows={buildStandaloneRows(ds.buyer.years, dr.years, "buyer", ds.buyer.dilutedSharesEPS)} />}
          {tab === "seller" && <FinTable entity={ds.targetName} cols={[ds.seller.years[0].label, ds.seller.years[1].label]} rows={buildStandaloneRows(ds.seller.years, dr.years, "seller", ds.seller.dilutedSharesEPS)} />}
          {tab === "combined" && <FinTable entity="Pro Forma Combined" cols={[ds.buyer.years[0].label, ds.buyer.years[1].label]} rows={buildCombinedRows(dr)} />}
        </Panel>

        <Panel style={{ marginBottom: 24 }}>
          <Eyebrow color={TEAL}>EPS accretion / (dilution)</Eyebrow>
          <div style={{ fontSize: 12.5, color: MUTED, margin: "6px 0 16px" }}>Combined pro forma EPS versus the acquirer's standalone EPS, at the entered offer price.</div>
          <div className="mm-adgrid">
            {dr.years.map((y, i) => {
              const pos = y.accretionPct >= 0;
              return (
                <div key={i} style={{ background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 10, padding: 20 }}>
                  <div style={{ ...mono, fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.6 }}>{ds.buyer.years[i].label}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0 4px", ...serif, fontSize: 32, fontWeight: 700, color: pos ? GREEN : RED }}>
                    {pos ? <TrendingUp size={24} /> : <TrendingDown size={24} />} {fPctSigned(y.accretionPct)}
                  </div>
                  <div style={{ fontSize: 12.5, color: MUTED }}>{pos ? "Accretive" : "Dilutive"} by {fUSD(Math.abs(y.accretionDilution), 2)} per share vs. standalone.</div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16, paddingTop: 12, borderTop: `1px dashed ${LINE}`, fontSize: 12.5, color: MUTED, gap: 10, flexWrap: "wrap" }}>
                    <span>Standalone EPS <b style={{ ...mono, color: TEXT }}>{fEPS(y.buyer.eps)}</b></span>
                    <span>Pro Forma EPS <b style={{ ...mono, color: TEXT }}>{fEPS(y.combined.proFormaEPS)}</b></span>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel style={{ marginBottom: 24 }}>
          <Eyebrow color={TEAL}>Sensitivity analysis</Eyebrow>
          <div style={{ fontSize: 12.5, color: MUTED, margin: "6px 0 18px" }}>Year-2 EPS accretion / (dilution) across purchase price and synergy assumptions. Outlined cell marks the base case.</div>
          <div style={{ fontSize: 10.5, ...mono, textTransform: "uppercase", letterSpacing: 0.6, color: MUTED, marginBottom: 10 }}>Purchase Price vs. Operating Expense Synergies (% of Target OpEx)</div>
          <Heatmap matrix={dashboard.sensitivity.opexMatrix} priceLevels={dashboard.sensitivity.priceLevels} synergyLevels={dashboard.sensitivity.synergyLevels} />
          <div style={{ fontSize: 10.5, ...mono, textTransform: "uppercase", letterSpacing: 0.6, color: MUTED, margin: "32px 0 10px" }}>Purchase Price vs. Revenue Synergies (% of Target Revenue)</div>
          <Heatmap matrix={dashboard.sensitivity.revMatrix} priceLevels={dashboard.sensitivity.priceLevels} synergyLevels={dashboard.sensitivity.synergyLevels} />
        </Panel>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
          <button onClick={handleExport} style={{ display: "flex", alignItems: "center", gap: 8, background: AMBER, color: "#180D03", border: "none", borderRadius: 8, padding: "11px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
            <FileSpreadsheet size={15} /> Download styled Excel workbook
          </button>
        </div>
        {exportError && <div style={{ color: RED, fontSize: 12.5, marginTop: 10, textAlign: "right" }}>{exportError}</div>}

        <div style={{ textAlign: "center", paddingTop: 30, marginTop: 20, borderTop: `1px solid ${LINE}` }}>
          <div style={{ fontSize: 11.5, color: FAINT, lineHeight: 1.6, maxWidth: 660, margin: "0 auto 14px" }}>
            AI-sourced financials are estimates pulled via live web search; verify against primary filings before this informs a decision. Not investment advice.
          </div>
          <span style={{ ...serif, fontSize: 15 }}>Build it. Stress it. <span style={{ color: AMBER, fontStyle: "italic" }}>Then decide.</span></span>
        </div>
      </div>

      <style>{`
        .mm-hero { font-size: 40px; }
        .mm-grid4 { display:grid; grid-template-columns:repeat(4,1fr); gap:12px 16px; }
        .mm-grid3 { display:grid; grid-template-columns:repeat(3,1fr); gap:12px 16px; }
        .mm-cols2 { display:grid; grid-template-columns:1fr 1fr; gap:24px; }
        .mm-adgrid { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
        .mm-modegrid { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; }
        .mm-namerow { display:grid; grid-template-columns:1fr 1fr auto; gap:14px; align-items:end; }
        @media (max-width:900px) { .mm-grid4 { grid-template-columns:repeat(2,1fr); } }
        @media (max-width:760px) {
          .mm-cols2, .mm-adgrid, .mm-modegrid, .mm-namerow, .mm-grid3 { grid-template-columns:1fr; }
          .mm-hero { font-size: 30px; }
        }
        .spin { animation: mm-spin 1s linear infinite; }
        @keyframes mm-spin { to { transform: rotate(360deg); } }
        input::placeholder { color: ${FAINT}; }
        input[type=number]::-webkit-inner-spin-button { opacity: 0.25; }
        button:focus-visible, input:focus-visible { outline: 2px solid ${AMBER}; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
      `}</style>
    </div>
  );
}
