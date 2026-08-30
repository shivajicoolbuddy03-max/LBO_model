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
import { StyleBook, WSheet, writeXlsx, colName } from "./lib/xlsxWriter.js";

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
  { k: "offerPrice", label: "Offer Price / Share ($)", help: "Price per target share offered by the acquirer — drives the equity purchase price and the premium shown above." },
  { k: "pctCash", label: "% Cash", pct: true, help: "Portion of the purchase price funded with acquirer cash on hand; foregone interest on this cash is charged against pro forma income." },
  { k: "pctDebt", label: "% Debt", pct: true, help: "Portion of the purchase price funded with new acquirer debt, at the Debt Interest Rate below." },
  { k: "pctStock", label: "% Stock", pct: true, help: "Portion of the purchase price paid in acquirer shares; new shares issued dilute the combined share count." },
  { k: "foregoneCashRate", label: "Foregone Cash Interest Rate", pct: true, help: "Interest the acquirer stops earning on the cash it spends — deducted from pro forma pre-tax income." },
  { k: "debtInterestRate", label: "Debt Interest Rate", pct: true, help: "Coupon on the new acquisition debt; the interest expense on this tranche reduces pro forma income." },
  { k: "revSynergyPct", label: "Revenue Synergy %", pct: true, help: "Extra revenue expected from the combined company, as a % of the target's standalone revenue." },
  { k: "revSynergyCOGSPct", label: "Revenue Synergy COGS %", pct: true, help: "Share of the revenue synergy that carries its own cost of goods sold — the rest flows straight to gross profit." },
  { k: "opexSynergyPct", label: "Cost Synergies % of OpEx", pct: true, help: "Operating expense savings from the deal, as a % of the target's standalone opex." },
  { k: "ppeWriteUpPct", label: "PP&E Write-Up %", pct: true, help: "Step-up applied to the target's net PP&E at close, which increases post-deal depreciation." },
  { k: "deprPeriod", label: "Depreciation Period (yrs)", help: "Number of years the PP&E step-up is depreciated over." },
  { k: "pctAllocIntangibles", label: "% Allocated to Intangibles", pct: true, help: "Share of the allocable purchase premium assigned to newly created intangible assets rather than goodwill." },
  { k: "amortPeriod", label: "Amortization Period (yrs)", help: "Number of years the new intangibles are amortized over." },
  { k: "dtlWriteDown", label: "Write-Down of Existing DTL ($mm)", help: "Write-down of the target's pre-existing deferred tax liability, netted against goodwill." },
];
const profileDefs = [
  { k: "sharePrice", label: "Share Price ($)", help: "Current market price per share, used with diluted shares to size market cap and (for the target) the offer premium." },
  { k: "dilutedSharesMktCap", label: "Diluted Shares — Mkt Cap (000s)", help: "Fully diluted shares outstanding used to compute market/equity value, from the company's latest filing." },
  { k: "dilutedSharesEPS", label: "Diluted Shares — EPS Calc (000s)", help: "Weighted-average diluted shares used in the EPS calculation, which can differ slightly from the mkt-cap share count." },
  { k: "taxRate", label: "Tax Rate", pct: true, help: "Effective tax rate applied to this company's pre-tax income; the acquirer's rate is also used on the combined pro forma income statement." },
];
const sellerOnlyDefs = [
  { k: "bookValueEquity", label: "Book Value of Equity ($mm)", help: "Target's total stockholders'/shareholders' equity — subtracted from the purchase price to find the allocable premium." },
  { k: "existingGoodwill", label: "Existing Goodwill ($mm)", help: "Goodwill already on the target's balance sheet; it's written off and re-created as part of the new goodwill calculation." },
  { k: "netPPE", label: "Net PP&E ($mm)", help: "Target's net property, plant & equipment — the base the PP&E write-up percentage is applied to." },
];
const isFieldDefs = [
  { k: "revenue", label: "Revenue", help: "Total revenue for the period." },
  { k: "cogs", label: "Cost of Goods Sold", help: "Direct cost of producing goods/services sold, subtracted from revenue for gross profit." },
  { k: "opex", label: "Operating Expenses", help: "Operating expenses excluding depreciation, amortization and stock-based comp, which are broken out separately below." },
  { k: "deprPPE", label: "Depreciation of PP&E", help: "Depreciation on existing property, plant & equipment." },
  { k: "amortIntangibles", label: "Amortization of Intangibles", help: "Amortization of existing intangible assets, pre-deal." },
  { k: "sbc", label: "Stock-Based Compensation", help: "Non-cash stock-based compensation expense." },
  { k: "interest", label: "Interest Income / (Expense)", help: "Net interest income (positive) or expense (negative), before the deal's new financing." },
];

/* ------------------------------------------------------------------ *
 * SENSITIVITY MATRIX (deterministic, no AI)
 * ------------------------------------------------------------------ */
const PRICE_FACTORS = [1.4667, 1.4, 1.3333, 1.2667, 1.2, 1.1333, 1.0667, 1.0, 0.9333, 0.8667];
const SYNERGY_LEVELS = [0, 0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.14, 0.16];

function buildSensitivity(s) {
  const priceFactors = PRICE_FACTORS;
  const priceLevels = priceFactors.map((f) => Math.round(s.offerPrice * f * 100) / 100);
  const synergyLevels = SYNERGY_LEVELS;
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

function InfoDot({ onClick, open }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={open ? "Hide description" : "What is this?"}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, borderRadius: "50%",
        border: `1px solid ${open ? AMBER : FAINT}`, background: open ? AMBER : "transparent", color: open ? "#fff" : FAINT,
        fontSize: 9, fontWeight: 700, lineHeight: 1, cursor: "pointer", padding: 0, flexShrink: 0, fontFamily: "Georgia, 'Times New Roman', serif",
      }}
    >
      i
    </button>
  );
}

function NumField({ label, value, onChange, pct, bare, step, help }) {
  const toDisplay = (v) => (pct ? Math.round((v || 0) * 100000) / 1000 : v);
  const fromDisplay = (v) => (pct ? v / 100 : v);
  const [draft, setDraft] = useState(String(toDisplay(value)));
  const [focused, setFocused] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
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
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
        <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.3 }}>{label}</div>
        {help && <InfoDot open={showHelp} onClick={(e) => { e.preventDefault(); setShowHelp((v) => !v); }} />}
      </div>
      {box}
      {help && showHelp && <div style={{ fontSize: 10.5, color: MUTED, marginTop: 5, lineHeight: 1.45 }}>{help}</div>}
    </label>
  );
}

function CompanyCard({ title, data, onProfile, onYear, sellerExtra }) {
  const [openRow, setOpenRow] = useState(null);
  return (
    <div style={{ background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 10, padding: 18 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: MUTED, marginBottom: 14, paddingBottom: 9, borderBottom: `1px solid ${LINE}`, ...mono }}>{title}</div>
      <div className="mm-grid3">
        {profileDefs.map((def) => (
          <NumField key={def.k} label={def.label} help={def.help} pct={!!def.pct} value={data[def.k]} onChange={(v) => onProfile(def.k, v)} />
        ))}
        {sellerExtra && sellerOnlyDefs.map((def) => (
          <NumField key={def.k} label={def.label} help={def.help} value={data[def.k]} onChange={(v) => onProfile(def.k, v)} />
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
          {isFieldDefs.map((def) => {
            const open = openRow === def.k;
            return (
              <React.Fragment key={def.k}>
                <tr>
                  <td style={{ padding: "5px 4px", borderBottom: open ? "none" : `1px solid ${LINE}`, color: MUTED, fontSize: 12 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      {def.label}
                      {def.help && <InfoDot open={open} onClick={() => setOpenRow(open ? null : def.k)} />}
                    </span>
                  </td>
                  {[0, 1].map((i) => (
                    <td key={i} style={{ padding: "3px 2px", borderBottom: open ? "none" : `1px solid ${LINE}` }}>
                      <NumField bare value={data.years[i][def.k]} onChange={(v) => onYear(i, def.k, v)} />
                    </td>
                  ))}
                </tr>
                {open && (
                  <tr>
                    <td colSpan={3} style={{ padding: "0 4px 8px", borderBottom: `1px solid ${LINE}` }}>
                      <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.45 }}>{def.help}</div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
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

/* ------------------------------------------------------------------ *
 * EXCEL EXPORT — same raw-OOXML writer LBO Model uses, no CDN
 * dependency.
 * ------------------------------------------------------------------ */
const XP = { title: "1F4E78", banner: "2E5395", white: "FFFFFF", input: "0000FA", bad: "9C0006", posFill: "6D7BC7", negFill: "9C3B3B" };
const USDFMT = '$#,##0.0;[Red]($#,##0.0)';
const USD2FMT = '$#,##0.00;[Red]($#,##0.00)';
const PCTFMT = "0.0%";
const NUMFMT = "#,##0.0";
const EPSFMT = "$#,##0.00";

/* ------------------------------------------------------------------ *
 * WORKBOOK ROW MAPS — fixed row numbers so every formula below can
 * reference a known cell address. Mirrors LBOModel's AS/SU/DS pattern:
 * every derived figure is a real Excel formula, not a pasted value.
 * ------------------------------------------------------------------ */
const AS = {
  hdr: 1, offerPrice: 3, pctCash: 4, pctDebt: 5, pctStock: 6, foregoneCashRate: 7, debtInterestRate: 8,
  revSynPct: 9, revSynCogsPct: 10, opexSynPct: 11, ppeWriteUpPct: 12, deprPeriod: 13, pctAllocIntangibles: 14,
  amortPeriod: 15, dtlWriteDown: 16,
};
const SU = { hdr: 3, equityPP: 4, cashUsed: 5, debtIssued: 6, newShares: 7 };
const GW = {
  hdr: 18, equityPP: 19, lessBV: 20, plusGW: 21, totalPremium: 22,
  lessPPE: 23, lessIntang: 24, lessDTL: 25, plusDTL: 26, totalGoodwill: 27,
};
const ACQ = {
  hdr: 1, yrhdr: 2, sharePrice: 3, sharesMkt: 4, sharesEPS: 5, taxRate: 6, spacer1: 7,
  revenue: 8, cogs: 9, gp: 10, opex: 11, deprPPE: 12, amort: 13, sbc: 14, oi: 15, interest: 16,
  pretax: 17, tax: 18, ni: 19, spacer2: 20, eps: 21, shares: 22,
};
const TGT_START = ACQ.shares + 2;
const TGT = {
  hdr: TGT_START, yrhdr: TGT_START + 1, sharePrice: TGT_START + 2, sharesMkt: TGT_START + 3, sharesEPS: TGT_START + 4,
  taxRate: TGT_START + 5, bookValue: TGT_START + 6, existingGW: TGT_START + 7, netPPE: TGT_START + 8, spacer1: TGT_START + 9,
  revenue: TGT_START + 10, cogs: TGT_START + 11, gp: TGT_START + 12, opex: TGT_START + 13, deprPPE: TGT_START + 14,
  amort: TGT_START + 15, sbc: TGT_START + 16, oi: TGT_START + 17, interest: TGT_START + 18, pretax: TGT_START + 19,
  tax: TGT_START + 20, ni: TGT_START + 21, spacer2: TGT_START + 22, eps: TGT_START + 23, shares: TGT_START + 24,
};
const CMB_START = TGT.shares + 2;
const CMB = {
  hdr: CMB_START, yrhdr: CMB_START + 1, rev: CMB_START + 2, revSyn: CMB_START + 3, cogs: CMB_START + 4, revSynCogs: CMB_START + 5,
  gp: CMB_START + 6, opex: CMB_START + 7, opexSyn: CMB_START + 8, deprPPE: CMB_START + 9, deprWriteUp: CMB_START + 10,
  amort: CMB_START + 11, amortNew: CMB_START + 12, sbc: CMB_START + 13, oi: CMB_START + 14, interest: CMB_START + 15,
  foregone: CMB_START + 16, newDebtInt: CMB_START + 17, pretax: CMB_START + 18, tax: CMB_START + 19, ni: CMB_START + 20,
  spacer: CMB_START + 21, eps: CMB_START + 22, shares: CMB_START + 23, spacer2: CMB_START + 24, accretion: CMB_START + 25,
};

const AG_SHEET = "Assumptions & Goodwill";
const IS_SHEET = "Income Statements";
const AGref = (col, row) => `'${AG_SHEET}'!$${col}$${row}`;
const ISref = (col, row) => `'${IS_SHEET}'!$${col}$${row}`;

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
    inputUSD2: SB.s({ font: { color: XP.input }, numFmt: USD2FMT }),
    inputPct: SB.s({ font: { color: XP.input }, numFmt: PCTFMT }),
    inputInt: SB.s({ font: { color: XP.input }, numFmt: "0" }),
    inputNum: SB.s({ font: { color: XP.input }, numFmt: NUMFMT }),
    formUSD: SB.s({ numFmt: USDFMT }),
    formUSDsub: SB.s({ font: { b: true }, numFmt: USDFMT }),
    formPct: SB.s({ numFmt: PCTFMT }),
    formNum: SB.s({ numFmt: NUMFMT }),
    formEPS: SB.s({ numFmt: EPSFMT }),
    total: SB.s({ font: { b: true, color: XP.input }, border: { top: { style: "thin" } }, numFmt: USDFMT }),
  };
  const accStyle = (v) => SB.s({ font: { b: true, color: v >= 0 ? XP.input : XP.bad }, numFmt: PCTFMT });
  const hdrPctCenter = SB.s({ font: { b: true, color: XP.input }, numFmt: "0%", align: { h: "center" } });
  const priceLbl = SB.s({ font: { b: true, color: XP.input }, numFmt: USDFMT });
  const heatCell = (v) => SB.s({ font: { b: true, color: XP.white }, fill: v >= 0 ? XP.posFill : XP.negFill, numFmt: "0.0%", align: { h: "center" } });

  // twoCol writes the same formula shape into columns B (FY1) and C (FY2)
  function twoCol(ws, row, tmpl, valB, valC, style) {
    ws.fml(1, row, tmpl("B"), valB, style);
    ws.fml(2, row, tmpl("C"), valC, style);
  }
  function bothCol(ws, row, fml, val, style) {
    ws.fml(1, row, fml, val, style);
    ws.fml(2, row, fml, val, style);
  }

  // ================= SHEET: Income Statements =================
  // Built first (before Summary/Assumptions) so its row map is available
  // for cross-sheet formulas below — the sheet order in the output
  // array is set at the very end, independent of build order.
  const ws3 = WSheet(IS_SHEET, { cols: [34, 16, 16] });

  function profileRow(row, label, val, style) { ws3.txt(0, row, label, S.lbl); ws3.num(1, row, val, style); }
  function inputRow(row, label, v0, v1) { ws3.txt(0, row, label, S.lbl); ws3.num(1, row, v0, S.inputUSD); ws3.num(2, row, v1, S.inputUSD); }

  // Acquirer
  ws3.txt(0, ACQ.hdr, `${s.acquirerName} (Acquirer)`, S.banner).band(0, 2, ACQ.hdr, S.banner).merge(0, ACQ.hdr, 2, ACQ.hdr);
  ws3.txt(1, ACQ.yrhdr, s.buyer.years[0].label, S.lblB); ws3.txt(2, ACQ.yrhdr, s.buyer.years[1].label, S.lblB);
  profileRow(ACQ.sharePrice, "Share Price ($)", s.buyer.sharePrice, S.inputUSD2);
  profileRow(ACQ.sharesMkt, "Diluted Shares — Mkt Cap (000s)", s.buyer.dilutedSharesMktCap, S.inputNum);
  profileRow(ACQ.sharesEPS, "Diluted Shares — EPS Calc (000s)", s.buyer.dilutedSharesEPS, S.inputNum);
  profileRow(ACQ.taxRate, "Tax Rate", s.buyer.taxRate, S.inputPct);
  inputRow(ACQ.revenue, "Revenue", s.buyer.years[0].revenue, s.buyer.years[1].revenue);
  inputRow(ACQ.cogs, "Cost of Goods Sold", s.buyer.years[0].cogs, s.buyer.years[1].cogs);
  ws3.txt(0, ACQ.gp, "Gross Profit", S.lblB);
  twoCol(ws3, ACQ.gp, (c) => `=${c}${ACQ.revenue}-${c}${ACQ.cogs}`, r.years[0].buyer.gp, r.years[1].buyer.gp, S.formUSDsub);
  inputRow(ACQ.opex, "Operating Expenses", s.buyer.years[0].opex, s.buyer.years[1].opex);
  inputRow(ACQ.deprPPE, "Depreciation of PP&E", s.buyer.years[0].deprPPE, s.buyer.years[1].deprPPE);
  inputRow(ACQ.amort, "Amortization of Intangibles", s.buyer.years[0].amortIntangibles, s.buyer.years[1].amortIntangibles);
  inputRow(ACQ.sbc, "Stock-Based Compensation", s.buyer.years[0].sbc, s.buyer.years[1].sbc);
  ws3.txt(0, ACQ.oi, "Operating Income", S.lblB);
  twoCol(ws3, ACQ.oi, (c) => `=${c}${ACQ.gp}-${c}${ACQ.opex}-${c}${ACQ.deprPPE}-${c}${ACQ.amort}-${c}${ACQ.sbc}`, r.years[0].buyer.oi, r.years[1].buyer.oi, S.formUSDsub);
  inputRow(ACQ.interest, "Interest Income / (Expense)", s.buyer.years[0].interest, s.buyer.years[1].interest);
  ws3.txt(0, ACQ.pretax, "Pre-Tax Income", S.lblB);
  twoCol(ws3, ACQ.pretax, (c) => `=${c}${ACQ.oi}+${c}${ACQ.interest}`, r.years[0].buyer.pt, r.years[1].buyer.pt, S.formUSDsub);
  ws3.txt(0, ACQ.tax, "Income Tax Provision", S.lbl);
  twoCol(ws3, ACQ.tax, (c) => `=${c}${ACQ.pretax}*$B$${ACQ.taxRate}`, r.years[0].buyer.tax, r.years[1].buyer.tax, S.formUSD);
  ws3.txt(0, ACQ.ni, "Net Income", S.lblB);
  twoCol(ws3, ACQ.ni, (c) => `=${c}${ACQ.pretax}-${c}${ACQ.tax}`, r.years[0].buyer.ni, r.years[1].buyer.ni, S.total);
  ws3.txt(0, ACQ.eps, "Earnings Per Share (EPS)", S.lbl);
  twoCol(ws3, ACQ.eps, (c) => `=${c}${ACQ.ni}/$B$${ACQ.sharesEPS}`, r.years[0].buyer.eps, r.years[1].buyer.eps, S.formEPS);
  ws3.txt(0, ACQ.shares, "Diluted Shares Outstanding", S.lbl);
  bothCol(ws3, ACQ.shares, `=$B$${ACQ.sharesEPS}`, s.buyer.dilutedSharesEPS, S.formNum);

  // Target
  ws3.txt(0, TGT.hdr, `${s.targetName} (Target)`, S.banner).band(0, 2, TGT.hdr, S.banner).merge(0, TGT.hdr, 2, TGT.hdr);
  ws3.txt(1, TGT.yrhdr, s.seller.years[0].label, S.lblB); ws3.txt(2, TGT.yrhdr, s.seller.years[1].label, S.lblB);
  profileRow(TGT.sharePrice, "Share Price ($)", s.seller.sharePrice, S.inputUSD2);
  profileRow(TGT.sharesMkt, "Diluted Shares — Mkt Cap (000s)", s.seller.dilutedSharesMktCap, S.inputNum);
  profileRow(TGT.sharesEPS, "Diluted Shares — EPS Calc (000s)", s.seller.dilutedSharesEPS, S.inputNum);
  profileRow(TGT.taxRate, "Tax Rate", s.seller.taxRate, S.inputPct);
  profileRow(TGT.bookValue, "Book Value of Equity ($mm)", s.seller.bookValueEquity, S.inputUSD);
  profileRow(TGT.existingGW, "Existing Goodwill ($mm)", s.seller.existingGoodwill, S.inputUSD);
  profileRow(TGT.netPPE, "Net PP&E ($mm)", s.seller.netPPE, S.inputUSD);
  inputRow(TGT.revenue, "Revenue", s.seller.years[0].revenue, s.seller.years[1].revenue);
  inputRow(TGT.cogs, "Cost of Goods Sold", s.seller.years[0].cogs, s.seller.years[1].cogs);
  ws3.txt(0, TGT.gp, "Gross Profit", S.lblB);
  twoCol(ws3, TGT.gp, (c) => `=${c}${TGT.revenue}-${c}${TGT.cogs}`, r.years[0].seller.gp, r.years[1].seller.gp, S.formUSDsub);
  inputRow(TGT.opex, "Operating Expenses", s.seller.years[0].opex, s.seller.years[1].opex);
  inputRow(TGT.deprPPE, "Depreciation of PP&E", s.seller.years[0].deprPPE, s.seller.years[1].deprPPE);
  inputRow(TGT.amort, "Amortization of Intangibles", s.seller.years[0].amortIntangibles, s.seller.years[1].amortIntangibles);
  inputRow(TGT.sbc, "Stock-Based Compensation", s.seller.years[0].sbc, s.seller.years[1].sbc);
  ws3.txt(0, TGT.oi, "Operating Income", S.lblB);
  twoCol(ws3, TGT.oi, (c) => `=${c}${TGT.gp}-${c}${TGT.opex}-${c}${TGT.deprPPE}-${c}${TGT.amort}-${c}${TGT.sbc}`, r.years[0].seller.oi, r.years[1].seller.oi, S.formUSDsub);
  inputRow(TGT.interest, "Interest Income / (Expense)", s.seller.years[0].interest, s.seller.years[1].interest);
  ws3.txt(0, TGT.pretax, "Pre-Tax Income", S.lblB);
  twoCol(ws3, TGT.pretax, (c) => `=${c}${TGT.oi}+${c}${TGT.interest}`, r.years[0].seller.pt, r.years[1].seller.pt, S.formUSDsub);
  ws3.txt(0, TGT.tax, "Income Tax Provision", S.lbl);
  twoCol(ws3, TGT.tax, (c) => `=${c}${TGT.pretax}*$B$${TGT.taxRate}`, r.years[0].seller.tax, r.years[1].seller.tax, S.formUSD);
  ws3.txt(0, TGT.ni, "Net Income", S.lblB);
  twoCol(ws3, TGT.ni, (c) => `=${c}${TGT.pretax}-${c}${TGT.tax}`, r.years[0].seller.ni, r.years[1].seller.ni, S.total);
  ws3.txt(0, TGT.eps, "Earnings Per Share (EPS)", S.lbl);
  twoCol(ws3, TGT.eps, (c) => `=${c}${TGT.ni}/$B$${TGT.sharesEPS}`, r.years[0].seller.eps, r.years[1].seller.eps, S.formEPS);
  ws3.txt(0, TGT.shares, "Diluted Shares Outstanding", S.lbl);
  bothCol(ws3, TGT.shares, `=$B$${TGT.sharesEPS}`, s.seller.dilutedSharesEPS, S.formNum);

  // Pro Forma Combined — every line is a formula off the Acquirer/Target
  // blocks above and the Assumptions & Goodwill sheet.
  ws3.txt(0, CMB.hdr, "Pro Forma Combined", S.banner).band(0, 2, CMB.hdr, S.banner).merge(0, CMB.hdr, 2, CMB.hdr);
  ws3.txt(1, CMB.yrhdr, s.buyer.years[0].label, S.lblB); ws3.txt(2, CMB.yrhdr, s.buyer.years[1].label, S.lblB);
  const c0 = r.years[0].combined, c1 = r.years[1].combined;

  ws3.txt(0, CMB.rev, "Combined Revenue", S.lbl);
  twoCol(ws3, CMB.rev, (c) => `=${c}${ACQ.revenue}+${c}${TGT.revenue}`, c0.combinedRevenue, c1.combinedRevenue, S.formUSD);
  ws3.txt(0, CMB.revSyn, "Revenue Synergies", S.lbl);
  twoCol(ws3, CMB.revSyn, (c) => `=${AGref("B", AS.revSynPct)}*${c}${TGT.revenue}`, c0.revSynergies, c1.revSynergies, S.formUSD);
  ws3.txt(0, CMB.cogs, "Cost of Goods Sold", S.lbl);
  twoCol(ws3, CMB.cogs, (c) => `=${c}${ACQ.cogs}+${c}${TGT.cogs}`, c0.combinedCOGS, c1.combinedCOGS, S.formUSD);
  ws3.txt(0, CMB.revSynCogs, "Revenue Synergy COGS", S.lbl);
  twoCol(ws3, CMB.revSynCogs, (c) => `=${AGref("B", AS.revSynCogsPct)}*${c}${CMB.revSyn}`, c0.revSynergyCOGS, c1.revSynergyCOGS, S.formUSD);
  ws3.txt(0, CMB.gp, "Gross Profit", S.lblB);
  twoCol(ws3, CMB.gp, (c) => `=${c}${CMB.rev}+${c}${CMB.revSyn}-${c}${CMB.cogs}-${c}${CMB.revSynCogs}`, c0.grossProfit, c1.grossProfit, S.formUSDsub);
  ws3.txt(0, CMB.opex, "Operating Expenses", S.lbl);
  twoCol(ws3, CMB.opex, (c) => `=${c}${ACQ.opex}+${c}${TGT.opex}`, c0.combinedOpex, c1.combinedOpex, S.formUSD);
  ws3.txt(0, CMB.opexSyn, "OpEx Synergies", S.lbl);
  twoCol(ws3, CMB.opexSyn, (c) => `=${AGref("B", AS.opexSynPct)}*${c}${TGT.opex}`, c0.opexSynergies, c1.opexSynergies, S.formUSD);
  ws3.txt(0, CMB.deprPPE, "Depreciation of PP&E", S.lbl);
  twoCol(ws3, CMB.deprPPE, (c) => `=${c}${ACQ.deprPPE}+${c}${TGT.deprPPE}`, c0.combinedDeprPPE, c1.combinedDeprPPE, S.formUSD);
  ws3.txt(0, CMB.deprWriteUp, "Depr. of PP&E Write-Up", S.lbl);
  bothCol(ws3, CMB.deprWriteUp, `=-${AGref("B", GW.lessPPE)}/${AGref("B", AS.deprPeriod)}`, c0.deprPPEWriteUp, S.formUSD);
  ws3.txt(0, CMB.amort, "Amortization of Intangibles", S.lbl);
  twoCol(ws3, CMB.amort, (c) => `=${c}${ACQ.amort}+${c}${TGT.amort}`, c0.combinedAmort, c1.combinedAmort, S.formUSD);
  ws3.txt(0, CMB.amortNew, "Amort. of New Intangibles", S.lbl);
  bothCol(ws3, CMB.amortNew, `=-${AGref("B", GW.lessIntang)}/${AGref("B", AS.amortPeriod)}`, c0.amortNewIntangibles, S.formUSD);
  ws3.txt(0, CMB.sbc, "Stock-Based Compensation", S.lbl);
  twoCol(ws3, CMB.sbc, (c) => `=${c}${ACQ.sbc}+${c}${TGT.sbc}`, c0.combinedSBC, c1.combinedSBC, S.formUSD);
  ws3.txt(0, CMB.oi, "Operating Income", S.lblB);
  twoCol(ws3, CMB.oi, (c) => `=${c}${CMB.gp}-(${c}${CMB.opex}-${c}${CMB.opexSyn})-${c}${CMB.deprPPE}-${c}${CMB.deprWriteUp}-${c}${CMB.amort}-${c}${CMB.amortNew}-${c}${CMB.sbc}`, c0.opInc, c1.opInc, S.formUSDsub);
  ws3.txt(0, CMB.interest, "Interest Income / (Expense)", S.lbl);
  twoCol(ws3, CMB.interest, (c) => `=${c}${ACQ.interest}+${c}${TGT.interest}`, c0.combinedInterest, c1.combinedInterest, S.formUSD);
  ws3.txt(0, CMB.foregone, "Foregone Interest on Cash", S.lbl);
  bothCol(ws3, CMB.foregone, `=-${AGref("E", SU.cashUsed)}*${AGref("B", AS.foregoneCashRate)}`, c0.foregoneInterest, S.formUSD);
  ws3.txt(0, CMB.newDebtInt, "Interest Paid on New Debt", S.lbl);
  bothCol(ws3, CMB.newDebtInt, `=-${AGref("E", SU.debtIssued)}*${AGref("B", AS.debtInterestRate)}`, c0.newDebtInterest, S.formUSD);
  ws3.txt(0, CMB.pretax, "Pre-Tax Income", S.lblB);
  twoCol(ws3, CMB.pretax, (c) => `=${c}${CMB.oi}+${c}${CMB.interest}+${c}${CMB.foregone}+${c}${CMB.newDebtInt}`, c0.preTax, c1.preTax, S.formUSDsub);
  ws3.txt(0, CMB.tax, "Income Tax Provision", S.lbl);
  twoCol(ws3, CMB.tax, (c) => `=${c}${CMB.pretax}*$B$${ACQ.taxRate}`, c0.tax, c1.tax, S.formUSD);
  ws3.txt(0, CMB.ni, "Net Income", S.lblB);
  twoCol(ws3, CMB.ni, (c) => `=${c}${CMB.pretax}-${c}${CMB.tax}`, c0.netIncome, c1.netIncome, S.total);
  ws3.txt(0, CMB.eps, "Pro Forma EPS", S.lbl);
  twoCol(ws3, CMB.eps, (c) => `=${c}${CMB.ni}/${c}${CMB.shares}`, c0.proFormaEPS, c1.proFormaEPS, S.formEPS);
  ws3.txt(0, CMB.shares, "Diluted Shares Outstanding", S.lbl);
  bothCol(ws3, CMB.shares, `=$B$${ACQ.sharesEPS}+${AGref("E", SU.newShares)}`, c0.combinedDilutedShares, S.formNum);
  ws3.txt(0, CMB.accretion, "Accretion / (Dilution) %", S.lblB);
  ws3.fml(1, CMB.accretion, `=B${CMB.eps}/B${ACQ.eps}-1`, r.years[0].accretionPct, accStyle(r.years[0].accretionPct));
  ws3.fml(2, CMB.accretion, `=C${CMB.eps}/C${ACQ.eps}-1`, r.years[1].accretionPct, accStyle(r.years[1].accretionPct));

  // ================= SHEET: Assumptions & Goodwill =================
  const ws2 = WSheet(AG_SHEET, { cols: [34, 16, 6, 34, 16] });
  ws2.txt(0, AS.hdr, "Transaction Assumptions", S.banner).band(0, 4, AS.hdr, S.banner).merge(0, AS.hdr, 4, AS.hdr);
  [
    [AS.offerPrice, "Per Share Purchase Price", s.offerPrice, S.inputUSD2],
    [AS.pctCash, "% Cash", s.pctCash, S.inputPct], [AS.pctDebt, "% Debt", s.pctDebt, S.inputPct], [AS.pctStock, "% Stock", s.pctStock, S.inputPct],
    [AS.foregoneCashRate, "Foregone Cash Interest Rate", s.foregoneCashRate, S.inputPct],
    [AS.debtInterestRate, "Debt Interest Rate", s.debtInterestRate, S.inputPct],
    [AS.revSynPct, "Revenue Synergy %", s.revSynergyPct, S.inputPct], [AS.revSynCogsPct, "Revenue Synergy COGS %", s.revSynergyCOGSPct, S.inputPct],
    [AS.opexSynPct, "Cost Synergies % OpEx", s.opexSynergyPct, S.inputPct], [AS.ppeWriteUpPct, "PP&E Write-Up %", s.ppeWriteUpPct, S.inputPct],
    [AS.deprPeriod, "Depreciation Period (yrs)", s.deprPeriod, S.inputInt], [AS.pctAllocIntangibles, "% Allocated to Intangibles", s.pctAllocIntangibles, S.inputPct],
    [AS.amortPeriod, "Amortization Period (yrs)", s.amortPeriod, S.inputInt], [AS.dtlWriteDown, "Write-Down of Existing DTL", s.dtlWriteDown, S.inputUSD],
  ].forEach(([row, label, val, style]) => { ws2.txt(0, row, label, S.lbl); ws2.num(1, row, val, style); });

  ws2.txt(3, SU.hdr, "Sources of Funds", S.banner).band(3, 4, SU.hdr, S.banner).merge(3, SU.hdr, 4, SU.hdr);
  ws2.txt(3, SU.equityPP, "Equity Purchase Price", S.lbl);
  ws2.fml(4, SU.equityPP, `=B${AS.offerPrice}*${ISref("B", TGT.sharesMkt)}/1000`, r.equityPurchasePrice, S.formUSD);
  ws2.txt(3, SU.cashUsed, "Cash Used", S.lbl);
  ws2.fml(4, SU.cashUsed, `=E${SU.equityPP}*B${AS.pctCash}`, r.cashUsed, S.formUSD);
  ws2.txt(3, SU.debtIssued, "Debt Issued", S.lbl);
  ws2.fml(4, SU.debtIssued, `=E${SU.equityPP}*B${AS.pctDebt}`, r.debtIssued, S.formUSD);
  ws2.txt(3, SU.newShares, "New Shares Issued (000s)", S.lbl);
  ws2.fml(4, SU.newShares, `=E${SU.equityPP}*B${AS.pctStock}/${ISref("B", ACQ.sharePrice)}*1000`, r.newSharesIssued, S.formNum);

  ws2.txt(0, GW.hdr, "Goodwill Calculation", S.banner).band(0, 1, GW.hdr, S.banner).merge(0, GW.hdr, 1, GW.hdr);
  ws2.txt(0, GW.equityPP, "Equity Purchase Price", S.lbl);
  ws2.fml(1, GW.equityPP, `=E${SU.equityPP}`, r.equityPurchasePrice, S.formUSD);
  ws2.txt(0, GW.lessBV, "Less: Target Book Value", S.lbl);
  ws2.fml(1, GW.lessBV, `=-${ISref("B", TGT.bookValue)}`, -s.seller.bookValueEquity, S.formUSD);
  ws2.txt(0, GW.plusGW, "Plus: Write-Off of Existing Goodwill", S.lbl);
  ws2.fml(1, GW.plusGW, `=${ISref("B", TGT.existingGW)}`, s.seller.existingGoodwill, S.formUSD);
  ws2.txt(0, GW.totalPremium, "Total Allocable Purchase Premium", S.lbl);
  ws2.fml(1, GW.totalPremium, `=B${GW.equityPP}+B${GW.lessBV}+B${GW.plusGW}`, r.totalAllocablePremium, S.total);
  ws2.txt(0, GW.lessPPE, "Less: Write-Up of PP&E", S.lbl);
  ws2.fml(1, GW.lessPPE, `=-B${AS.ppeWriteUpPct}*${ISref("B", TGT.netPPE)}`, -r.ppeWriteUpAmount, S.formUSD);
  ws2.txt(0, GW.lessIntang, "Less: Write-Up of Intangibles", S.lbl);
  ws2.fml(1, GW.lessIntang, `=-B${AS.pctAllocIntangibles}*B${GW.totalPremium}`, -r.intangiblesWriteUpAmount, S.formUSD);
  ws2.txt(0, GW.lessDTL, "Less: Write-Down of DTL", S.lbl);
  ws2.fml(1, GW.lessDTL, `=-B${AS.dtlWriteDown}`, -s.dtlWriteDown, S.formUSD);
  ws2.txt(0, GW.plusDTL, "Plus: New Deferred Tax Liability", S.lbl);
  ws2.fml(1, GW.plusDTL, `=(-B${GW.lessPPE}-B${GW.lessIntang})*${ISref("B", ACQ.taxRate)}`, r.newDTL, S.formUSD);
  ws2.txt(0, GW.totalGoodwill, "Total Goodwill Created", S.lbl);
  ws2.fml(1, GW.totalGoodwill, `=B${GW.totalPremium}+B${GW.lessPPE}+B${GW.lessIntang}+B${GW.lessDTL}+B${GW.plusDTL}`, r.totalGoodwill, S.total);

  // ================= SHEET: Summary =================
  const ws1 = WSheet("Summary", { cols: [34, 20, 20, 20] });
  ws1.txt(0, 1, `Merger Model — ${s.acquirerName} acquires ${s.targetName}`, S.title).band(0, 3, 1, S.title).merge(0, 1, 3, 1);
  ws1.txt(0, 2, "($ in Millions, Except Per Share Amounts; Share Counts in Thousands)", S.subtitle).band(0, 3, 2, S.subtitle).merge(0, 2, 3, 2);
  let row = 4;
  ws1.txt(0, row, "DEAL SUMMARY", S.banner).band(0, 3, row, S.banner).merge(0, row, 3, row); row++;
  ws1.txt(0, row, "Offer Price / Share", S.lbl); ws1.fml(1, row, `=${AGref("B", AS.offerPrice)}`, s.offerPrice, S.formUSD); row++;
  ws1.txt(0, row, "Premium to Target Share Price", S.lbl);
  ws1.fml(1, row, `=${AGref("B", AS.offerPrice)}/${ISref("B", TGT.sharePrice)}-1`, s.offerPrice / s.seller.sharePrice - 1, S.formPct); row++;
  ws1.txt(0, row, "Equity Purchase Price", S.lbl); ws1.fml(1, row, `=${AGref("E", SU.equityPP)}`, r.equityPurchasePrice, S.formUSD); row++;
  ws1.txt(0, row, "Total Goodwill Created", S.lbl); ws1.fml(1, row, `=${AGref("B", GW.totalGoodwill)}`, r.totalGoodwill, S.formUSD); row++;
  ws1.txt(0, row, `${s.buyer.years[0].label} EPS Accretion / (Dilution)`, S.lbl); ws1.fml(1, row, `=${ISref("B", CMB.accretion)}`, r.years[0].accretionPct, S.formPct); row++;
  ws1.txt(0, row, `${s.buyer.years[1].label} EPS Accretion / (Dilution)`, S.lbl); ws1.fml(1, row, `=${ISref("C", CMB.accretion)}`, r.years[1].accretionPct, S.formPct); row++;
  row += 1;
  ws1.txt(0, row, "SOURCING (primary regulator filings only)", S.banner).band(0, 3, row, S.banner).merge(0, row, 3, row); row++;
  [["Acquirer", s.acquirerName, s.buyer], ["Target", s.targetName, s.seller]].forEach(([role, name, side]) => {
    ws1.txt(0, row, `${role} — ${name}`, S.lbl);
    ws1.txt(1, row, side.jurisdiction || "", S.lbl);
    ws1.txt(2, row, (side.source && side.source.regulator) || "unverified", S.lbl);
    ws1.txt(3, row, [(side.source && side.source.filingName) || "", (side.source && side.source.filingDate) || ""].filter(Boolean).join(" · "), S.lbl);
    row++;
  });

  // ================= SHEET: Sensitivity =================
  // Two 10×9 matrices plus a shared "calculation detail" helper block:
  // every accretion% cell is a real formula chained off the helper row
  // for its price and the matrix's own column header for its synergy %,
  // both of which in turn trace back to the Assumptions & Income
  // Statements sheets — so the whole grid recalculates live in Excel.
  const ws4 = WSheet("Sensitivity", { cols: [14, ...Array(9).fill(10)] });
  const OPEX_START = 1, OPEX_HDR = OPEX_START + 1, OPEX_R0 = OPEX_HDR + 1; // first price row of opex matrix
  const REV_START = OPEX_R0 + 10 + 1, REV_HDR = REV_START + 1, REV_R0 = REV_HDR + 1;
  const HELP_START = REV_R0 + 10 + 1, HELP_HDR = HELP_START + 1, HELP_R0 = HELP_HDR + 1;

  ws4.txt(0, OPEX_START, "EPS Accretion/Dilution vs. Purchase Price & OpEx Synergies", S.banner).band(0, 9, OPEX_START, S.banner).merge(0, OPEX_START, 9, OPEX_START);
  ws4.txt(0, OPEX_HDR, "Price \\ Synergy%", S.lblB);
  SYNERGY_LEVELS.forEach((syn, ci) => ws4.num(ci + 1, OPEX_HDR, syn, hdrPctCenter));

  ws4.txt(0, REV_START, "EPS Accretion/Dilution vs. Purchase Price & Revenue Synergies", S.banner).band(0, 9, REV_START, S.banner).merge(0, REV_START, 9, REV_START);
  ws4.txt(0, REV_HDR, "Price \\ Synergy%", S.lblB);
  SYNERGY_LEVELS.forEach((syn, ci) => ws4.num(ci + 1, REV_HDR, syn, hdrPctCenter));

  ws4.txt(0, HELP_START, "Calculation Detail (drives both matrices above)", S.banner).band(0, 10, HELP_START, S.banner).merge(0, HELP_START, 10, HELP_START);
  ["Price", "Equity Purchase Price", "Cash Used", "Debt Issued", "Total Alloc. Premium", "Intangibles Write-Up", "Amort. New Intangibles", "Foregone Interest", "Interest on New Debt", "New Shares Issued", "Combined Diluted Shares"]
    .forEach((label, ci) => ws4.txt(ci, HELP_HDR, label, S.lblB));

  const fixed = {
    gp: ISref("C", CMB.gp), opex: ISref("C", CMB.opex), tgtOpex: ISref("C", TGT.opex), tgtRev: ISref("C", TGT.revenue),
    rev: ISref("C", CMB.rev), cogs: ISref("C", CMB.cogs), deprPPE: ISref("C", CMB.deprPPE), deprWU: ISref("C", CMB.deprWriteUp),
    amort: ISref("C", CMB.amort), sbc: ISref("C", CMB.sbc), interest: ISref("C", CMB.interest), taxRate: ISref("B", ACQ.taxRate),
    eps: ISref("C", ACQ.eps), revSynCogsPct: AGref("B", AS.revSynCogsPct), opexSynPctBase: AGref("B", AS.opexSynPct),
  };

  for (let ri = 0; ri < 10; ri++) {
    const opexRow = OPEX_R0 + ri, revRow = REV_R0 + ri, helpRow = HELP_R0 + ri;
    const price = sens.priceLevels[ri];
    // computeDeal at this price (base synergies) supplies accurate cached
    // values for the helper cells — the formulas themselves are what Excel
    // actually recalculates; this is only the fallback shown before that.
    const pr = computeDeal(s, price);
    const eqpp = `B${helpRow}`, cash = `C${helpRow}`, debt = `D${helpRow}`, prem = `E${helpRow}`, intang = `F${helpRow}`,
      amortNew = `G${helpRow}`, forgn = `H${helpRow}`, newDebtI = `I${helpRow}`, newSh = `J${helpRow}`;

    // price header (opex matrix): live off the base offer price
    ws4.fml(0, opexRow, `=ROUND(${AGref("B", AS.offerPrice)}*${PRICE_FACTORS[ri]},2)`, price, priceLbl);
    // rev matrix + helper block just link back to that same cell
    ws4.fml(0, revRow, `=A${opexRow}`, price, priceLbl);
    ws4.fml(0, helpRow, `=A${opexRow}`, price, priceLbl);

    ws4.fml(1, helpRow, `=A${helpRow}*${ISref("B", TGT.sharesMkt)}/1000`, pr.equityPurchasePrice, S.formUSD);
    ws4.fml(2, helpRow, `=${eqpp}*${AGref("B", AS.pctCash)}`, pr.cashUsed, S.formUSD);
    ws4.fml(3, helpRow, `=${eqpp}*${AGref("B", AS.pctDebt)}`, pr.debtIssued, S.formUSD);
    ws4.fml(4, helpRow, `=${eqpp}-${ISref("B", TGT.bookValue)}+${ISref("B", TGT.existingGW)}`, pr.totalAllocablePremium, S.formUSD);
    ws4.fml(5, helpRow, `=${AGref("B", AS.pctAllocIntangibles)}*${prem}`, pr.intangiblesWriteUpAmount, S.formUSD);
    ws4.fml(6, helpRow, `=${intang}/${AGref("B", AS.amortPeriod)}`, pr.intangiblesWriteUpAmount / s.amortPeriod, S.formUSD);
    ws4.fml(7, helpRow, `=-${cash}*${AGref("B", AS.foregoneCashRate)}`, -pr.cashUsed * s.foregoneCashRate, S.formUSD);
    ws4.fml(8, helpRow, `=-${debt}*${AGref("B", AS.debtInterestRate)}`, -pr.debtIssued * s.debtInterestRate, S.formUSD);
    ws4.fml(9, helpRow, `=${eqpp}*${AGref("B", AS.pctStock)}/${ISref("B", ACQ.sharePrice)}*1000`, pr.newSharesIssued, S.formNum);
    ws4.fml(10, helpRow, `=${ISref("B", ACQ.sharesEPS)}+${newSh}`, s.buyer.dilutedSharesEPS + pr.newSharesIssued, S.formNum);
  }

  // matrix cells: opex-synergy matrix (col varies opexSynergyPct, gross profit fixed)
  for (let ri = 0; ri < 10; ri++) {
    const opexRow = OPEX_R0 + ri, helpRow = HELP_R0 + ri;
    const g = `G${helpRow}`, h = `H${helpRow}`, i = `I${helpRow}`, k = `K${helpRow}`;
    sens.opexMatrix[ri].forEach((v, ci) => {
      const col = colName(ci + 1);
      const synCell = `${col}$${OPEX_HDR}`;
      const preTax = `(${fixed.gp}-(${fixed.opex}-${synCell}*${fixed.tgtOpex})-${fixed.deprPPE}-${fixed.deprWU}-${fixed.amort}-${g}-${fixed.sbc}+${fixed.interest}+${h}+${i})`;
      const formula = `=${preTax}*(1-${fixed.taxRate})/${k}/${fixed.eps}-1`;
      ws4.fml(ci + 1, opexRow, formula, v, heatCell(v));
    });
  }
  // matrix cells: revenue-synergy matrix (col varies revSynergyPct, gross profit varies)
  for (let ri = 0; ri < 10; ri++) {
    const revRow = REV_R0 + ri, helpRow = HELP_R0 + ri;
    const g = `G${helpRow}`, h = `H${helpRow}`, i = `I${helpRow}`, k = `K${helpRow}`;
    sens.revMatrix[ri].forEach((v, ci) => {
      const col = colName(ci + 1);
      const synCell = `${col}$${REV_HDR}`;
      const revSyn = `${synCell}*${fixed.tgtRev}`;
      const gp = `(${fixed.rev}+${revSyn}-${fixed.cogs}-${fixed.revSynCogsPct}*(${revSyn}))`;
      const preTax = `(${gp}-(${fixed.opex}-${fixed.opexSynPctBase}*${fixed.tgtOpex})-${fixed.deprPPE}-${fixed.deprWU}-${fixed.amort}-${g}-${fixed.sbc}+${fixed.interest}+${h}+${i})`;
      const formula = `=${preTax}*(1-${fixed.taxRate})/${k}/${fixed.eps}-1`;
      ws4.fml(ci + 1, revRow, formula, v, heatCell(v));
    });
  }

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
              <button onClick={handleFetch} disabled={fetching} style={{ display: "flex", alignItems: "center", gap: 8, background: GOLD, color: "#fff", border: "none", borderRadius: 8, padding: "11px 18px", fontSize: 13, fontWeight: 700, cursor: fetching ? "wait" : "pointer", opacity: fetching ? 0.6 : 1, whiteSpace: "nowrap" }}>
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
              <NumField key={def.k} label={def.label} help={def.help} pct={!!def.pct} value={state[def.k]} onChange={(v) => setAssumption(def.k, v)} />
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
            <button onClick={runAnalysis} style={{ display: "flex", alignItems: "center", gap: 8, background: AMBER, color: "#fff", border: "none", borderRadius: 8, padding: "12px 20px", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
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
              <button key={id} onClick={() => setTab(id)} style={{ ...mono, fontSize: 11, padding: "6px 14px", borderRadius: 20, cursor: "pointer", background: tab === id ? AMBER : "transparent", color: tab === id ? "#fff" : MUTED, border: `1px solid ${tab === id ? AMBER : LINE}` }}>
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
          <button onClick={handleExport} style={{ display: "flex", alignItems: "center", gap: 8, background: AMBER, color: "#fff", border: "none", borderRadius: 8, padding: "11px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
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
