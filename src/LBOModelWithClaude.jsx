import React, { useState, useRef, useMemo, useEffect } from "react";
import {
  LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  Search, Building2, Banknote, Target, Activity, ShieldAlert, LogOut,
  Loader2, CheckCircle2, Circle, AlertCircle, AlertTriangle, Download, Play,
  Info, Sliders, Zap, RotateCcw, FileSpreadsheet, ArrowRight, Check,
  FileText, ExternalLink, BadgeCheck, KeyRound, PencilLine, X,
} from "lucide-react";

const API_MODEL = "claude-sonnet-4-6";

/* ------------------------------------------------------------------ *
 * API KEY STORE
 * The app calls the Anthropic API directly from the device, so it needs
 * the user's own key. Kept as a module-level value rather than React
 * state so every plain function below (callOnce, callClaude) can read
 * it without threading a prop through the whole agent pipeline. It is
 * persisted only to on-device localStorage, never sent anywhere but
 * api.anthropic.com.
 * ------------------------------------------------------------------ */
const API_KEY_STORAGE = "lbo_anthropic_api_key";
let currentApiKey = "";
function loadApiKey() {
  try { currentApiKey = localStorage.getItem(API_KEY_STORAGE) || ""; } catch (e) { currentApiKey = ""; }
  return currentApiKey;
}
function saveApiKey(key) {
  currentApiKey = key || "";
  try {
    if (currentApiKey) localStorage.setItem(API_KEY_STORAGE, currentApiKey);
    else localStorage.removeItem(API_KEY_STORAGE);
  } catch (e) { /* localStorage unavailable, key still held in memory for this session */ }
}

/* ------------------------------------------------------------------ *
 * UI DESIGN TOKENS
 * ------------------------------------------------------------------ */
const INK = "#0B0C0F";
const PANEL = "#14161B";
const PANEL2 = "#1B1E25";
const LINE = "#262A33";
const AMBER = "#E8823C";
const AMBER_DIM = "rgba(232,130,60,0.13)";
const TEAL = "#4CC9C0";
const GREEN = "#5BD98A";
const RED = "#F2645A";
const GOLD = "#E5B94E";
const TEXT = "#E9E6DF";
const MUTED = "#8A8F9A";
const FAINT = "#565C68";

const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontVariantNumeric: "tabular-nums" };
const serif = { fontFamily: "Georgia, 'Times New Roman', serif" };

const FIN_FEE_AMORT_YEARS = 7;

const PIPELINE = [
  { key: "research", code: "R", name: "Research", role: "Target financials, live", Icon: Search },
  { key: "a1", code: "01", name: "LBO Builder", role: "Transaction structure", Icon: Building2 },
  { key: "a2", code: "02", name: "Debt Optimizer", role: "Capital structure", Icon: Banknote },
  { key: "a3", code: "03", name: "Valuation Engine", role: "Exit assumptions", Icon: Target },
  { key: "a4", code: "04", name: "Cash Flow Forecaster", role: "Operating build", Icon: Activity },
  { key: "compute1", code: "\u2211", name: "Model Engine", role: "Debt schedule, returns", Icon: Zap, local: true },
  { key: "a5", code: "05", name: "Risk Analyzer", role: "Deal-specific risks", Icon: ShieldAlert },
  { key: "a6", code: "06", name: "Exit Strategist", role: "Route comparison", Icon: LogOut },
  { key: "compute2", code: "\u2211", name: "Model Engine", role: "Sensitivity, routes", Icon: Zap, local: true },
];

/* ------------------------------------------------------------------ *
 * FORMATTERS
 * ------------------------------------------------------------------ */
function currencySymbol(code) {
  const map = { USD: "$", INR: "\u20b9", EUR: "\u20ac", GBP: "\u00a3", JPY: "\u00a5", CNY: "\u00a5", AUD: "A$", CAD: "C$" };
  return map[code] || (code ? code + " " : "$");
}
function fmtM(sym, v, dp) {
  if (v === null || v === undefined || !isFinite(v)) return "\u2014";
  const d = dp === undefined ? 0 : dp;
  const neg = v < 0;
  return `${neg ? "(" : ""}${sym}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}${neg ? ")" : ""}`;
}
function fmtX(v) { return isFinite(v) ? v.toFixed(2) + "x" : "\u2014"; }
function fmtX1(v) { return isFinite(v) ? v.toFixed(1) + "x" : "\u2014"; }
function fmtPct(v, dp) { return isFinite(v) ? (v * 100).toFixed(dp === undefined ? 1 : dp) + "%" : "\u2014"; }

/* ------------------------------------------------------------------ *
 * INPUT COERCION
 * Agent output is free-form JSON. Nothing reaches the engine before it is
 * forced to a sane number, so a stray "12.5x" or a rate returned as 25
 * instead of 0.25 cannot silently corrupt the model.
 * ------------------------------------------------------------------ */
function num(v, fallback) {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
    if (isFinite(n)) return n;
  }
  return fallback;
}
function pct(v, fallback) {
  const n = num(v, null);
  if (n === null) return fallback;
  return Math.abs(n) > 1 ? n / 100 : n;
}
function mult(v, fallback) {
  const n = num(v, null);
  return n === null || n <= 0 ? fallback : n;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/* Jurisdiction map. The research agent is told to go to the primary
   regulatory filing for the market the target is listed in, never to a
   data vendor's derived figure. */
const FILING_SOURCES = [
  ["United States", "SEC EDGAR", "10-K, 10-Q, 8-K, DEF 14A"],
  ["Canada", "SEDAR+", "Annual Information Form, MD&A, audited financials"],
  ["India", "BSE India and NSE India", "Annual Report (Ind AS), quarterly results, investor presentations"],
  ["United Kingdom", "London Stock Exchange RNS and Companies House", "Annual Report and Accounts (IFRS)"],
  ["European Union", "the issuer's regulated-information page and the national OAM", "Universal Registration Document, annual financial report"],
  ["Japan", "EDINET and TDnet", "Yuka Shoken Hokokusho, Tanshin"],
  ["Hong Kong and China", "HKEXnews", "Annual Report, interim report, listing documents"],
  ["Australia", "ASX Announcements", "Annual Report, Appendix 4E, 4D"],
  ["Singapore", "SGXNet", "Annual Report, results announcements"],
  ["South Korea", "DART", "Business Report, audited financials"],
  ["Brazil", "CVM and B3", "Formulario de Referencia, ITR, DFP"],
  ["South Africa", "JSE SENS", "Integrated Annual Report"],
];
const SOURCE_RULE = `SOURCING RULE, NON-NEGOTIABLE. Every figure must come from the company's own primary disclosure: the audited annual report, the interim or quarterly filing, the results announcement, or the investor presentation, retrieved from the company's investor-relations site or the regulator of the exchange it is listed on. ${FILING_SOURCES.map((f) => `${f[0]}: ${f[1]} (${f[2]})`).join(". ")}. Never take a figure from a data aggregator, a screener, a broker note, an encyclopedia or a news article. If the primary filing cannot be found, return the field as 0 and say so in the source note rather than substituting an estimate.`;

function cleanStr(v, fallback, maxLen) {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return fallback || "";
  return s.slice(0, maxLen || 400);
}
function cleanUrl(v) {
  const s = cleanStr(v, "", 500);
  return /^https?:\/\//i.test(s) ? s : "";
}

function normResearch(r) {
  return {
    company_name: cleanStr(r.company_name, "Unknown", 120),
    ticker: cleanStr(r.ticker, "\u2014", 24),
    exchange: cleanStr(r.exchange, "\u2014", 60),
    sector: cleanStr(r.sector, "\u2014", 90),
    currency: cleanStr(r.currency, "USD", 3).toUpperCase().slice(0, 3),
    fiscal_year_end: cleanStr(r.fiscal_year_end, "\u2014", 40),
    ltm_revenue_mm: num(r.ltm_revenue_mm, 0),
    ltm_ebitda_mm: num(r.ltm_ebitda_mm, 0),
    net_debt_mm: num(r.net_debt_mm, 0),
    market_cap_mm: num(r.market_cap_mm, 0),
    current_ev_ebitda_x: num(r.current_ev_ebitda_x, 0),
    ebitda_basis: cleanStr(r.ebitda_basis, "Basis not stated by the research step.", 300),
    filing_type: cleanStr(r.filing_type, "\u2014", 90),
    filing_period: cleanStr(r.filing_period, "\u2014", 60),
    filing_url: cleanUrl(r.filing_url),
    source_note: cleanStr(r.source_note, "No source note returned.", 400),
    data_gaps: cleanStr(r.data_gaps, "", 400),
  };
}
function normA1(a) {
  return {
    entry_multiple_x: mult(a.entry_multiple_x, 10),
    txn_fee_pct: clamp(pct(a.txn_fee_pct, 0.02), 0, 0.1),
    financing_fee_pct: clamp(pct(a.financing_fee_pct, 0.025), 0, 0.1),
    mgmt_rollover_pct: clamp(pct(a.mgmt_rollover_pct, 0.05), 0, 0.5),
    rationale: cleanStr(a.rationale, "", 400),
    evidence: cleanStr(a.evidence, "No precedent cited.", 300),
  };
}
function normA2(a) {
  return {
    term_loan_leverage_x: clamp(num(a.term_loan_leverage_x, 3.5), 0, 9),
    term_loan_rate_pct: clamp(pct(a.term_loan_rate_pct, 0.085), 0, 0.3),
    term_loan_amort_pct: clamp(pct(a.term_loan_amort_pct, 0.01), 0, 0.25),
    senior_notes_leverage_x: clamp(num(a.senior_notes_leverage_x, 1.5), 0, 6),
    senior_notes_rate_pct: clamp(pct(a.senior_notes_rate_pct, 0.095), 0, 0.3),
    revolver_size_mm: Math.max(0, num(a.revolver_size_mm, 0)),
    revolver_rate_pct: clamp(pct(a.revolver_rate_pct, 0.08), 0, 0.3),
    cash_sweep_pct: clamp(pct(a.cash_sweep_pct, 0.75), 0, 1),
    cash_interest_rate_pct: clamp(pct(a.cash_interest_rate_pct, 0.02), 0, 0.15),
    min_cash_pct_revenue: clamp(pct(a.min_cash_pct_revenue, 0.02), 0, 0.15),
    rationale: cleanStr(a.rationale, "", 400),
    evidence: cleanStr(a.evidence, "No existing-debt disclosure cited.", 300),
  };
}
function normA3(a) {
  return {
    exit_year: clamp(Math.round(num(a.exit_year, 5)), 3, 7),
    exit_ev_ebitda_x: mult(a.exit_ev_ebitda_x, 10),
    exit_fee_pct: clamp(pct(a.exit_fee_pct, 0.015), 0, 0.1),
    rationale: cleanStr(a.rationale, "", 400),
    evidence: cleanStr(a.evidence, "No multiple evidence cited.", 300),
  };
}
function normA4(a) {
  const g = (v, d) => clamp(pct(v, d), -0.5, 0.6);
  const m = (v, d) => clamp(pct(v, d), 0.01, 0.85);
  return {
    revenue_growth_base_pct: g(a.revenue_growth_base_pct, 0.04),
    revenue_growth_upside_pct: g(a.revenue_growth_upside_pct, 0.07),
    revenue_growth_downside_pct: g(a.revenue_growth_downside_pct, 0.0),
    exit_margin_base_pct: m(a.exit_margin_base_pct, 0.18),
    exit_margin_upside_pct: m(a.exit_margin_upside_pct, 0.21),
    exit_margin_downside_pct: m(a.exit_margin_downside_pct, 0.15),
    capex_pct_revenue: clamp(pct(a.capex_pct_revenue, 0.03), 0, 0.4),
    nwc_pct_delta_revenue: clamp(pct(a.nwc_pct_delta_revenue, 0.1), -0.5, 0.8),
    da_pct_revenue: clamp(pct(a.da_pct_revenue, 0.035), 0, 0.4),
    tax_rate_pct: clamp(pct(a.tax_rate_pct, 0.25), 0, 0.55),
    rationale: cleanStr(a.rationale, "", 400),
    evidence: cleanStr(a.evidence, "No historical trend cited.", 300),
  };
}
function normA5(a) {
  const sev = (x) => (["High", "Medium", "Low"].indexOf(x) >= 0 ? x : "Medium");
  const risks = Array.isArray(a.key_risks) ? a.key_risks : [];
  return {
    key_risks: risks.slice(0, 6).map((x) => ({
      risk: cleanStr(x.risk, "Unspecified", 220),
      severity: sev(x.severity),
      evidence: cleanStr(x.evidence, "", 220),
    })),
    downside_commentary: cleanStr(a.downside_commentary, "", 400),
  };
}
function normA6(a) {
  const routes = ["Strategic Sale", "Secondary Sale", "IPO"];
  return {
    strategic_premium_pct: clamp(pct(a.strategic_premium_pct, 0.1), -0.5, 0.5),
    secondary_premium_pct: clamp(pct(a.secondary_premium_pct, 0), -0.5, 0.5),
    ipo_discount_pct: clamp(Math.abs(pct(a.ipo_discount_pct, 0.1)), 0, 0.5),
    recommended_route: routes.indexOf(a.recommended_route) >= 0 ? a.recommended_route : "Strategic Sale",
    rationale: cleanStr(a.rationale, "", 400),
    evidence: cleanStr(a.evidence, "No transaction precedent cited.", 300),
  };
}

function houseDefaults(r) {
  const margin = r && r.ltm_revenue_mm > 0 ? r.ltm_ebitda_mm / r.ltm_revenue_mm : 0.18;
  const anchor = r && r.current_ev_ebitda_x > 0 ? r.current_ev_ebitda_x : 9;
  return {
    entry_multiple_x: Math.round(anchor * 1.25 * 4) / 4,
    txn_fee_pct: 0.02, financing_fee_pct: 0.025, mgmt_rollover_pct: 0.05,
    rationale: "House default: 25% control premium to the current trading multiple.",
    term_loan_leverage_x: 3.5, term_loan_rate_pct: 0.085, term_loan_amort_pct: 0.01,
    senior_notes_leverage_x: 1.5, senior_notes_rate_pct: 0.095,
    revolver_size_mm: Math.round((r ? r.ltm_revenue_mm : 1000) * 0.08),
    revolver_rate_pct: 0.08, cash_sweep_pct: 0.75, cash_interest_rate_pct: 0.02, min_cash_pct_revenue: 0.02,
    exit_year: 5, exit_ev_ebitda_x: Math.round(anchor * 1.25 * 4) / 4, exit_fee_pct: 0.015,
    revenue_growth_base_pct: 0.04, revenue_growth_upside_pct: 0.07, revenue_growth_downside_pct: 0.0,
    exit_margin_base_pct: Math.round((margin + 0.01) * 1000) / 1000,
    exit_margin_upside_pct: Math.round((margin + 0.03) * 1000) / 1000,
    exit_margin_downside_pct: Math.round(Math.max(0.02, margin - 0.02) * 1000) / 1000,
    capex_pct_revenue: 0.03, da_pct_revenue: 0.035, nwc_pct_delta_revenue: 0.1, tax_rate_pct: 0.25,
  };
}

/* ------------------------------------------------------------------ *
 * API PLUMBING
 * ------------------------------------------------------------------ */
function stripFences(t) { return t.replace(/```json\s*|```\s*/g, "").trim(); }

function extractJson(text) {
  const t = stripFences(text);
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== "{") continue;
    let depth = 0, inStr = false, esc2 = false;
    for (let j = i; j < t.length; j++) {
      const ch = t[j];
      if (inStr) {
        if (esc2) esc2 = false;
        else if (ch === "\\") esc2 = true;
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
  if (!currentApiKey) throw new Error("No Anthropic API key is set. Add one from the key icon at the top of the page, or switch to Manual entry mode to build the model without one.");
  const body = { model: API_MODEL, max_tokens: maxTokens || 1000, system, messages: [{ role: "user", content: userContent }] };
  if (useWebSearch) body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": currentApiKey,
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
  if (data.stop_reason === "max_tokens") throw new Error("The reply hit the token limit before the JSON closed. Try a more specific company name.");
  throw new Error("No valid JSON object found in the model response.");
}

async function callClaude(system, userContent, opts) {
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

/* ------------------------------------------------------------------ *
 * MODEL ENGINE
 * Deterministic. Interest accrues on opening balances, so there is no
 * circular reference and no iterative calculation anywhere.
 * ------------------------------------------------------------------ */
function irrFrom(cashflows) {
  if (cashflows.every((cf) => cf <= 0)) return -1;
  const npv = (r) => cashflows.reduce((s, cf, i) => s + cf / Math.pow(1 + r, i), 0);
  let lo = -0.9999, hi = 10, flo = npv(lo);
  if (flo * npv(hi) > 0) return flo < 0 ? -1 : NaN;
  for (let i = 0; i < 240; i++) {
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (flo * fm <= 0) hi = mid; else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

function buildYears(a, growthPct, exitMarginPct) {
  const years = [];
  let revenue = a.ltm_revenue_mm;
  let tlBal = a.tlAmount, snBal = a.snAmount, revBal = 0, cash = a.minCash, nolBal = 0;
  const entryMargin = a.entryMargin;
  const annualFF = a.finFees / FIN_FEE_AMORT_YEARS;

  for (let y = 1; y <= a.exit_year; y++) {
    const prevRevenue = revenue;
    revenue = revenue * (1 + growthPct);
    const margin = entryMargin + (exitMarginPct - entryMargin) * (y / a.exit_year);
    const ebitda = revenue * margin;
    const da = revenue * a.da_pct_revenue;
    const capex = revenue * a.capex_pct_revenue;
    const deltaNWC = (revenue - prevRevenue) * a.nwc_pct_delta_revenue;

    const tlBegin = tlBal, snBegin = snBal, revBegin = revBal, cashBegin = cash;
    const tlInterest = tlBegin * a.term_loan_rate_pct;
    const snInterest = snBegin * a.senior_notes_rate_pct;
    const revInterest = revBegin * a.revolver_rate_pct;
    const totalInterest = tlInterest + snInterest + revInterest;
    const cashInterest = Math.max(0, cashBegin) * a.cash_interest_rate_pct;
    const finFeeAmort = y <= FIN_FEE_AMORT_YEARS ? annualFF : 0;

    const ebit = ebitda - da;
    const ebt = ebit - totalInterest + cashInterest - finFeeAmort;

    /* Taxes floor at zero; losses carry forward. Without this a levered
       downside year books a tax refund and flatters net income. */
    const nolOpen = nolBal;
    let nolUsed = 0, taxes = 0;
    if (ebt > 0) {
      nolUsed = Math.min(nolBal, ebt);
      nolBal -= nolUsed;
      taxes = (ebt - nolUsed) * a.tax_rate_pct;
    } else {
      nolBal += -ebt;
    }
    const ni = ebt - taxes;

    const mandatoryAmort = -Math.min(tlBegin, a.tlAmount * a.term_loan_amort_pct);
    const cfads = ni + da + finFeeAmort - capex - deltaNWC;
    const avail = cfads + mandatoryAmort;

    const revolverCapacity = Math.max(0, a.revolver_size_mm - revBegin);
    const revAct = avail >= 0 ? -Math.min(revBegin, avail) : Math.min(revolverCapacity, -avail);
    const revEnd = revBegin + revAct;
    const cashForSweep = avail + revAct;
    const tlAfterMandatory = tlBegin + mandatoryAmort;
    const tlSweep = -Math.min(tlAfterMandatory, Math.max(0, cashForSweep) * a.cash_sweep_pct);
    const tlEnd = tlAfterMandatory + tlSweep;
    const snEnd = snBegin;
    const cashFlowToCash = cashForSweep + tlSweep;
    cash = cashBegin + cashFlowToCash;

    const totalDebtEnd = revEnd + tlEnd + snEnd;
    const netDebtEnd = totalDebtEnd - cash;
    years.push({
      year: y, label: "Y" + y, revenue, ebitda, margin, da, ebit, capex, deltaNWC,
      tlBegin, snBegin, revBegin, cashBegin, tlInterest, snInterest, revInterest,
      interest: totalInterest, cashInterest, finFeeAmort, ebt,
      nolOpen, nolUsed, nolClose: nolBal, taxes, ni, cfads, avail,
      mandatoryAmort, revAct, tlSweep, cashFlowToCash,
      tlEnd, snEnd, revEnd, totalDebtEnd, cash, netDebtEnd,
      leverage: ebitda > 0 ? netDebtEnd / ebitda : NaN,
      grossLeverage: ebitda > 0 ? totalDebtEnd / ebitda : NaN,
      coverage: totalInterest > 0 ? ebitda / totalInterest : Infinity,
      fcfConversion: ebitda > 0 ? cfads / ebitda : NaN,
      growth: prevRevenue > 0 ? revenue / prevRevenue - 1 : NaN,
      shortfall: cash < 0,
    });
    tlBal = tlEnd; snBal = snEnd; revBal = revEnd;
  }
  return years;
}

function computeModel(a) {
  const warnings = [];
  const ebitda0 = a.ltm_ebitda_mm;
  const entryMargin = a.ltm_ebitda_mm / a.ltm_revenue_mm;
  const entryMult = a.entry_multiple_x;
  const entryEV = ebitda0 * entryMult;
  const minCash = a.ltm_revenue_mm * a.min_cash_pct_revenue;
  const txnFees = entryEV * a.txn_fee_pct;

  let tlAmount = a.term_loan_leverage_x * ebitda0;
  let snAmount = a.senior_notes_leverage_x * ebitda0;
  let totalDebtClose = tlAmount + snAmount;

  /* Sources must fund the purchase price, both fee pools and the opening
     cash balance. Omitting cash is what breaks sources against uses. */
  const usesAt = (em, debt) => ebitda0 * em * (1 + a.txn_fee_pct) + debt * a.financing_fee_pct + minCash;

  const maxDebt = usesAt(entryMult, totalDebtClose) * 0.85;
  if (totalDebtClose > maxDebt) {
    const scale = maxDebt / totalDebtClose;
    warnings.push(`Proposed leverage of ${(totalDebtClose / ebitda0).toFixed(1)}x exceeds 85% of the funding requirement. Capped at ${(maxDebt / ebitda0).toFixed(1)}x to keep the sponsor cheque positive.`);
    tlAmount *= scale; snAmount *= scale; totalDebtClose = maxDebt;
  }

  const finFees = totalDebtClose * a.financing_fee_pct;
  const totalUses = entryEV + txnFees + finFees + minCash;
  const totalEquity = totalUses - totalDebtClose;
  const mgmtRollover = totalEquity * a.mgmt_rollover_pct;
  const sponsorEquity = totalEquity - mgmtRollover;
  const sponsorOwnership = 1 - a.mgmt_rollover_pct;
  const entryLeverage = totalDebtClose / ebitda0;

  const impliedEquityPrice = entryEV - a.net_debt_mm;
  const premiumToMarket = a.market_cap_mm > 0 ? impliedEquityPrice / a.market_cap_mm - 1 : NaN;
  if (isFinite(premiumToMarket) && premiumToMarket < 0) {
    warnings.push(`The entry price sits ${fmtPct(Math.abs(premiumToMarket))} below the current market cap, so no control premium is being paid.`);
  } else if (isFinite(premiumToMarket) && premiumToMarket > 0.6) {
    warnings.push(`The entry price implies a ${fmtPct(premiumToMarket)} premium to market cap, well above a normal control premium.`);
  }
  if (entryLeverage > 7) warnings.push(`Entry leverage of ${entryLeverage.toFixed(1)}x is above what most credit committees will underwrite outside software or healthcare.`);

  const merged = Object.assign({}, a, { entryMargin, tlAmount, snAmount, minCash, finFees });
  const yearsBase = buildYears(merged, a.revenue_growth_base_pct, a.exit_margin_base_pct);
  const yearsUpside = buildYears(merged, a.revenue_growth_upside_pct, a.exit_margin_upside_pct);
  const yearsDownside = buildYears(merged, a.revenue_growth_downside_pct, a.exit_margin_downside_pct);

  if (yearsBase.some((y) => y.shortfall)) warnings.push("The base case runs a cash shortfall: operating cash flow plus revolver capacity does not cover mandatory amortisation in at least one year.");
  else if (yearsDownside.some((y) => y.shortfall)) warnings.push("The downside case runs a cash shortfall. The structure would need a revolver upsize or an equity cure.");
  if (yearsDownside.some((y) => y.coverage < 1.5)) warnings.push("Downside interest coverage falls below 1.5x, which would breach a typical maintenance covenant.");

  function returnsFor(years) {
    const last = years[years.length - 1];
    const exitEBITDA = last.ebitda;
    const exitEV = exitEBITDA * a.exit_ev_ebitda_x;
    const exitFees = exitEV * a.exit_fee_pct;
    const exitDebt = last.totalDebtEnd;
    const exitCash = last.cash;
    /* Equity is a residual claim. It floors at zero, it does not go negative. */
    const exitEquityValue = Math.max(0, exitEV - exitFees - exitDebt + exitCash);
    const sponsorProceeds = exitEquityValue * sponsorOwnership;
    const moic = sponsorEquity > 0 ? sponsorProceeds / sponsorEquity : NaN;
    const cf = [-sponsorEquity].concat(Array(a.exit_year - 1).fill(0), [sponsorProceeds]);
    return { exitEBITDA, exitEV, exitFees, exitDebt, exitCash, exitEquityValue, sponsorProceeds, moic, irr: irrFrom(cf), cf };
  }

  const base = returnsFor(yearsBase);
  const upside = returnsFor(yearsUpside);
  const downside = returnsFor(yearsDownside);

  /* Value creation bridge. With the fee drag stated rather than buried in a
     plug, the bridge reconciles to exit equity exactly. */
  const ebitdaGrowth = (base.exitEBITDA - ebitda0) * entryMult;
  const multipleEffect = base.exitEBITDA * (a.exit_ev_ebitda_x - entryMult);
  const debtPaydown = (totalDebtClose - minCash) - (base.exitDebt - base.exitCash);
  const feeDrag = -(txnFees + finFees + base.exitFees);
  const bridgeCheck = base.exitEquityValue - (totalEquity + ebitdaGrowth + multipleEffect + debtPaydown + feeDrag);

  /* Closed-form sensitivity. Neither multiple touches the operating build,
     so exit debt and cash are invariant and no re-solve is needed. */
  const steps = [-1.0, -0.5, 0, 0.5, 1.0];
  const entryMults = steps.map((d) => Math.round((entryMult + d) * 100) / 100).filter((x) => x > 0);
  const exitMults = steps.map((d) => Math.round((a.exit_ev_ebitda_x + d) * 100) / 100).filter((x) => x > 0);
  const sponsorEquityAt = (em) => (usesAt(em, totalDebtClose) - totalDebtClose) * sponsorOwnership;
  const sponsorProceedsAt = (xm) => Math.max(0, base.exitEBITDA * xm * (1 - a.exit_fee_pct) - base.exitDebt + base.exitCash) * sponsorOwnership;
  const grid = entryMults.map((em) => ({
    entryMult: em,
    equityAt: sponsorEquityAt(em),
    row: exitMults.map((xm) => {
      const eq = sponsorEquityAt(em), pr = sponsorProceedsAt(xm);
      const moic = eq > 0 ? pr / eq : NaN;
      return { exitMult: xm, moic, irr: irrFrom([-eq].concat(Array(a.exit_year - 1).fill(0), [pr])) };
    }),
  }));
  const proceedsAtList = exitMults.map((xm) => sponsorProceedsAt(xm));

  const hurdle = a.hurdle_irr_pct;
  const verdict = !isFinite(base.irr) ? { label: "Not computable", tone: "bad" }
    : base.irr >= hurdle ? { label: "Clears the hurdle", tone: "good" }
    : base.irr >= hurdle - 0.05 ? { label: "Marginal against the hurdle", tone: "warn" }
    : { label: "Below the hurdle", tone: "bad" };

  const checks = [
    { name: "Sources equal uses", value: (totalDebtClose + totalEquity) - totalUses, ok: Math.abs((totalDebtClose + totalEquity) - totalUses) < 1e-6 },
    { name: "Value bridge reconciles", value: bridgeCheck, ok: Math.abs(bridgeCheck) < 1e-4 },
    { name: "Debt schedule ties", value: yearsBase.reduce((s, y) => s + Math.abs((y.tlEnd + y.snEnd + y.revEnd) - y.totalDebtEnd), 0), ok: yearsBase.every((y) => Math.abs((y.tlEnd + y.snEnd + y.revEnd) - y.totalDebtEnd) < 1e-6) },
  ];

  return {
    ebitda0, entryMargin, entryEV, txnFees, tlAmount, snAmount, totalDebtClose, finFees,
    totalUses, totalEquity, mgmtRollover, sponsorEquity, sponsorOwnership, minCash,
    entryLeverage, impliedEquityPrice, premiumToMarket, warnings, checks, verdict, hurdle,
    yearsBase, yearsUpside, yearsDownside, base, upside, downside,
    bridge: { entryEquity: totalEquity, ebitdaGrowth, multipleEffect, debtPaydown, feeDrag, exitEquity: base.exitEquityValue, check: bridgeCheck },
    entryMults, exitMults, grid, proceedsAtList,
  };
}

function computeRoutes(model, a, ra) {
  const defs = [
    { name: "Strategic Sale", premium: ra.strategic_premium_pct, fee: 0.015 },
    { name: "Secondary Sale", premium: ra.secondary_premium_pct, fee: 0.015 },
    { name: "IPO", premium: -Math.abs(ra.ipo_discount_pct), fee: 0.06 },
  ];
  return defs.map((r) => {
    const exitMult = a.exit_ev_ebitda_x * (1 + r.premium);
    const ev = model.base.exitEBITDA * exitMult;
    const equity = Math.max(0, ev * (1 - r.fee) - model.base.exitDebt + model.base.exitCash);
    const proceeds = equity * model.sponsorOwnership;
    const moic = model.sponsorEquity > 0 ? proceeds / model.sponsorEquity : NaN;
    const irr = irrFrom([-model.sponsorEquity].concat(Array(a.exit_year - 1).fill(0), [proceeds]));
    return Object.assign({}, r, { mult: exitMult, ev, equity, proceeds, moic, irr });
  });
}

/* ------------------------------------------------------------------ *
 * AGENT PROMPTS
 * ------------------------------------------------------------------ */
const SENIORITY = `You have thirty years of continuous experience in this discipline. You have worked through the 1998 emerging-market crisis, the 2000 technology unwind, the 2008 credit crisis, the 2020 shutdown and the 2022 rate shock, and you have seen deals underwritten in each of them succeed and fail. You know which assumptions survive a credit committee and which get torn apart. You are precise, you are sceptical of your own optimism, and you would rather return a conservative number you can defend from a filing than an attractive one you cannot.`;

const JSON_RULE = `Respond with ONLY a single valid JSON object. No markdown fences, no preamble, no commentary outside the object. Keep every string field under 30 words so the object closes within the token budget.`;

const SYSTEM = {
  research: `You are a senior equity research analyst. ${SENIORITY} You have spent your career reading primary filings rather than trusting summaries, and you have been burned often enough by vendor data to check everything against the source document.

${SOURCE_RULE}

Research the target and return its most recent reported financials. ${JSON_RULE} Schema:
{"company_name":string,"ticker":string,"exchange":string,"sector":string,"currency":3-letter ISO code,"fiscal_year_end":string,"ltm_revenue_mm":number,"ltm_ebitda_mm":number,"net_debt_mm":number,"market_cap_mm":number,"current_ev_ebitda_x":number,"ebitda_basis":string,"filing_type":string,"filing_period":string,"filing_url":string,"source_note":string,"data_gaps":string}

Rules a thirty-year veteran would not break:
1. Report figures AS DISCLOSED. Convert crores, lakhs, billions and thousands into millions of the reporting currency, and do not convert between currencies.
2. All numeric fields are bare numbers: no symbols, no "x" suffix, no thousands separators, no text.
3. Net debt is gross borrowings including the current portion, plus lease liabilities where the issuer reports under IFRS or Ind AS, less cash and cash equivalents and liquid investments. Negative if net cash. State in ebitda_basis whether leases are included.
4. If EBITDA is not separately disclosed, build it from operating profit plus depreciation and amortisation as reported, and say exactly that in ebitda_basis. Never use a company-defined "adjusted" EBITDA without flagging it, because those adjustments are where the optimism hides.
5. filing_type is the document, for example "Form 10-K" or "Annual Report FY2026 (Ind AS)". filing_period is the period it covers. filing_url is the direct link to that document on the regulator or investor-relations site, or an empty string if you cannot produce one.
6. market_cap_mm and current_ev_ebitda_x are as at the most recent close; state the basis briefly in source_note.
7. data_gaps names anything you could not source from a primary filing. An empty string means everything above traces to the filing. Be honest here: a named gap is useful, a fabricated figure is not.`,

  a1: `You are Agent 01, the LBO Builder, a managing director who has structured leveraged buyouts for three decades. ${SENIORITY} You have signed deals at the top of a cycle and lived with them, so you price control premiums against what the seller's board will actually accept rather than what makes the returns work.

${SOURCE_RULE} For structuring benchmarks, anchor on the target's own disclosed trading multiple, on announced transaction terms in the same sector disclosed in merger proxies, scheme documents or offer announcements, and on fee levels disclosed in comparable transaction filings.

${JSON_RULE} Schema:
{"entry_multiple_x":number,"txn_fee_pct":number,"financing_fee_pct":number,"mgmt_rollover_pct":number,"rationale":string,"evidence":string}

Percentages as decimals between 0 and 1. entry_multiple_x is EV/EBITDA on a cash-free debt-free basis and must carry a control premium a public board could recommend to shareholders: judge it against where the company trades today, not against a generic default. rationale: the structuring logic in one or two sentences. evidence: name the specific precedent, disclosed transaction or filing that anchors the multiple, or state plainly that you are applying judgement without a named precedent.`,

  a2: `You are Agent 02, the Debt Optimizer, a leveraged finance banker of thirty years' standing. ${SENIORITY} You have had structures pulled from syndication and you have seen covenants breached in year three, so you size leverage to the trough of the cycle rather than to the last twelve months.

${SOURCE_RULE} Anchor pricing and capacity on the target's OWN disclosed borrowings: the debt note in the annual report, the maturity profile, the stated coupons and the covenant terms. Those are facts you can cite. Where you must assume market terms, say so.

${JSON_RULE} Schema:
{"term_loan_leverage_x":number,"term_loan_rate_pct":number,"term_loan_amort_pct":number,"senior_notes_leverage_x":number,"senior_notes_rate_pct":number,"revolver_size_mm":number,"revolver_rate_pct":number,"cash_sweep_pct":number,"cash_interest_rate_pct":number,"min_cash_pct_revenue":number,"rationale":string,"evidence":string}

Rates and percentages as decimals between 0 and 1. Leverage fields are turns of LTM EBITDA. term_loan_amort_pct is annual mandatory amortisation as a percentage of original principal. Total leverage must leave a sponsor contribution of at least 30% of sources, and must be serviceable in the downside, not merely the base case. A capital-intensive or cyclical issuer carries materially less than a contracted-revenue one. evidence: cite the debt note, coupon or facility disclosure you relied on.`,

  a3: `You are Agent 03, the Valuation Engine, a valuation practitioner with thirty years across cycles. ${SENIORITY} You have watched entire sectors rerate and derate, and you know that assuming exit multiple expansion is the single most common way a model flatters a deal that should have been declined.

${SOURCE_RULE} Anchor the exit multiple on the target's own disclosed trading history and on multiples implied by disclosed transactions in the sector, taken from offer documents, merger proxies or scheme circulars.

${JSON_RULE} Schema:
{"exit_year":number,"exit_ev_ebitda_x":number,"exit_fee_pct":number,"rationale":string,"evidence":string}

exit_year is an integer from 3 to 7, typically 5. exit_fee_pct as a decimal. rationale: state explicitly whether you assume expansion, compression or a flat multiple versus entry, and why. Expansion requires a specific, named justification; absent one, hold the multiple flat or compress it, because that is the discipline a committee will hold you to. evidence: name the trading range or transaction that supports the exit level.`,

  a4: `You are Agent 04, the Cash Flow Forecaster, a research analyst who has modelled this kind of business for thirty years. ${SENIORITY} You build off what the company has actually delivered through a full cycle, not off management guidance, because you have seen how few plans survive contact with a downturn.

${SOURCE_RULE} Ground growth, margin, capex, working capital and tax on the target's OWN reported history across at least the last three disclosed years, taken from the annual report or the equivalent regulatory filing, plus the effective tax rate in the tax note and the segment disclosures where relevant.

${JSON_RULE} Schema:
{"revenue_growth_base_pct":number,"revenue_growth_upside_pct":number,"revenue_growth_downside_pct":number,"exit_margin_base_pct":number,"exit_margin_upside_pct":number,"exit_margin_downside_pct":number,"capex_pct_revenue":number,"nwc_pct_delta_revenue":number,"da_pct_revenue":number,"tax_rate_pct":number,"rationale":string,"evidence":string}

Decimals; downside growth may be negative and for a cyclical business it should be. Growth rates are constant annual rates. The exit_margin fields are the EBITDA margin in the exit year, not a delta, and margins ramp linearly from the LTM margin. nwc_pct_delta_revenue is the working capital investment per unit of incremental revenue. Use the cash tax rate the company actually pays, not the statutory headline. evidence: cite the reported history you built from, naming the years.`,

  a5: `You are Agent 05, the Risk Analyzer, a portfolio manager and former investment committee chair with thirty years of underwriting behind you. ${SENIORITY} You have written the post-mortems on deals that failed, and the causes were almost never the risks listed in the generic section of the memo.

${SOURCE_RULE} Draw risks from the target's OWN disclosures: the risk factors section, the contingent liabilities and litigation notes, customer or supplier concentration disclosures, regulatory and licensing commentary, covenant terms and the going-concern or critical-accounting-judgement notes.

${JSON_RULE} Schema:
{"key_risks":[{"risk":string,"severity":"High"|"Medium"|"Low","evidence":string}],"downside_commentary":string}

Exactly 4 risks. Each must be specific to THIS company, sector and capital structure: a risk that could be copied into any other buyout memo is worthless and you would strike it from a draft. Each risk under 20 words. evidence: name the disclosure the risk comes from, in under 15 words. downside_commentary: what would actually drive the downside here, mechanically, in one or two sentences.`,

  a6: `You are Agent 06, the Exit Strategist, a sell-side M&A and ECM banker of thirty years. ${SENIORITY} You have run the processes, so you price the route by who is genuinely able to pay and clear antitrust, and you treat IPO proceeds as staged rather than certain.

${SOURCE_RULE} Anchor route pricing on disclosed transaction terms in the sector, taken from offer announcements, merger proxies and scheme documents, and on disclosed IPO pricing ranges in the relevant listing venue.

${JSON_RULE} Schema:
{"strategic_premium_pct":number,"secondary_premium_pct":number,"ipo_discount_pct":number,"recommended_route":"Strategic Sale"|"Secondary Sale"|"IPO","rationale":string,"evidence":string}

Premiums and discounts are decimals relative to the base exit multiple. ipo_discount_pct must be positive, reflecting the listing discount and the fact that a sponsor cannot exit in full at listing. rationale: ground it in the actual buyer universe for this asset, in one or two sentences. evidence: name the transaction or listing precedent you relied on.`,
};

const CONVENTIONS = [
  "Interest accrues on opening debt balances, so the model contains no circular reference and needs no iterative calculation.",
  "Sources fund the purchase enterprise value, transaction fees, financing fees and the opening cash balance. Existing debt is refinanced at close.",
  "Financing fees are capitalised and amortised straight-line over seven years. The charge is non-cash but shields tax.",
  "Taxes floor at zero. Losses accumulate as a carryforward and offset the first available taxable income.",
  "The cash flow waterfall repays the revolver first, then sweeps the term loan at the stated rate. Senior notes are bullet.",
  "Exit equity is a residual claim floored at zero. IRR is solved from the sponsor cash flow vector, not derived from MOIC.",
  "Leverage is quoted as net debt to EBITDA throughout. Gross leverage is shown separately on the debt schedule.",
  "Not modelled: undrawn commitment fees, a management incentive pool, dividend recapitalisations, PIK toggles, and any purchase price allocation or step-up.",
  "Reported financials are taken from the target's own primary regulatory filing, cited on the Source Register. Structuring, credit, operating and exit assumptions are analyst judgement anchored on disclosed evidence, and remain estimates.",
  "Any figure the research step could not trace to a primary filing is listed as a data gap on the Source Register and must be filled before this model is relied upon.",
];

/* ================================================================== *
 * XLSX WRITER
 * The browser build of SheetJS silently drops cell styles, so the
 * workbook is emitted as raw OOXML and packed into a stored-entry ZIP.
 * That buys full control of fonts, fills, borders, number formats,
 * tab colours, frozen panes and merges.
 * ================================================================== */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function utf8bytes(str) { return new TextEncoder().encode(str); }

function zipStore(files) {
  const chunks = [], central = [];
  let offset = 0;
  const w16 = (v) => [v & 0xFF, (v >>> 8) & 0xFF];
  const w32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
  files.forEach((f) => {
    const name = utf8bytes(f.name), data = utf8bytes(f.data), crc = crc32(data);
    const local = [].concat([0x50, 0x4B, 0x03, 0x04], w16(20), w16(0), w16(0), w16(0), w16(0),
      w32(crc), w32(data.length), w32(data.length), w16(name.length), w16(0));
    chunks.push(Uint8Array.from(local), name, data);
    central.push({ name, crc, size: data.length, offset });
    offset += local.length + name.length + data.length;
  });
  let cdSize = 0;
  central.forEach((c) => {
    const rec = [].concat([0x50, 0x4B, 0x01, 0x02], w16(20), w16(20), w16(0), w16(0), w16(0), w16(0),
      w32(c.crc), w32(c.size), w32(c.size), w16(c.name.length), w16(0), w16(0), w16(0), w16(0), w32(0), w32(c.offset));
    chunks.push(Uint8Array.from(rec), c.name);
    cdSize += rec.length + c.name.length;
  });
  chunks.push(Uint8Array.from([].concat([0x50, 0x4B, 0x05, 0x06], w16(0), w16(0),
    w16(central.length), w16(central.length), w32(cdSize), w32(offset), w16(0))));
  let total = 0; chunks.forEach((c) => (total += c.length));
  const out = new Uint8Array(total);
  let p = 0; chunks.forEach((c) => { out.set(c, p); p += c.length; });
  return out;
}

function xesc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}
function colName(i) {
  let s = "", n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function StyleBook() {
  const numFmts = [], fonts = [], fills = [], borders = [], xfs = [];
  const key = (o) => JSON.stringify(o);
  const idx = { nf: {}, f: {}, fl: {}, b: {}, x: {} };
  fonts.push({ sz: 11, name: "Calibri" }); idx.f[key({ sz: 11, name: "Calibri" })] = 0;
  fills.push({ p: "none" }); fills.push({ p: "gray125" });
  borders.push({});
  xfs.push({ nf: 0, f: 0, fl: 0, b: 0, a: null });
  const nfId = (code) => {
    if (!code) return 0;
    if (idx.nf[code] === undefined) { numFmts.push(code); idx.nf[code] = 164 + numFmts.length - 1; }
    return idx.nf[code];
  };
  const fontId = (f) => {
    const o = Object.assign({ sz: 11, name: "Calibri" }, f), k = key(o);
    if (idx.f[k] === undefined) { fonts.push(o); idx.f[k] = fonts.length - 1; }
    return idx.f[k];
  };
  const fillId = (c) => {
    if (!c) return 0;
    const k = "s" + c;
    if (idx.fl[k] === undefined) { fills.push({ p: "solid", c }); idx.fl[k] = fills.length - 1; }
    return idx.fl[k];
  };
  const borderId = (b) => {
    if (!b) return 0;
    const k = key(b);
    if (idx.b[k] === undefined) { borders.push(b); idx.b[k] = borders.length - 1; }
    return idx.b[k];
  };
  return {
    s(d) {
      const rec = { nf: nfId(d.numFmt), f: fontId(d.font || {}), fl: fillId(d.fill), b: borderId(d.border), a: d.align || null };
      const k = key(rec);
      if (idx.x[k] === undefined) { xfs.push(rec); idx.x[k] = xfs.length - 1; }
      return idx.x[k];
    },
    xml() {
      const fontXml = fonts.map((f) => `<font><sz val="${f.sz}"/><name val="${f.name}"/>` +
        (f.b ? "<b/>" : "") + (f.i ? "<i/>" : "") + (f.color ? `<color rgb="FF${f.color}"/>` : "") + `</font>`).join("");
      const fillXml = fills.map((f) => f.p === "solid"
        ? `<fill><patternFill patternType="solid"><fgColor rgb="FF${f.c}"/><bgColor indexed="64"/></patternFill></fill>`
        : `<fill><patternFill patternType="${f.p}"/></fill>`).join("");
      const side = (s, v) => v ? `<${s} style="${v.style}">${v.color ? `<color rgb="FF${v.color}"/>` : ""}</${s}>` : `<${s}/>`;
      const borderXml = borders.map((b) => `<border>${side("left", b.left)}${side("right", b.right)}${side("top", b.top)}${side("bottom", b.bottom)}<diagonal/></border>`).join("");
      const xfXml = xfs.map((x) => {
        const al = x.a ? `<alignment${x.a.h ? ` horizontal="${x.a.h}"` : ""}${x.a.v ? ` vertical="${x.a.v}"` : ""}${x.a.wrap ? ` wrapText="1"` : ""}${x.a.indent ? ` indent="${x.a.indent}"` : ""}/>` : "";
        return `<xf numFmtId="${x.nf}" fontId="${x.f}" fillId="${x.fl}" borderId="${x.b}" xfId="0"` +
          `${x.nf ? ' applyNumberFormat="1"' : ""}${x.f ? ' applyFont="1"' : ""}${x.fl ? ' applyFill="1"' : ""}${x.b ? ' applyBorder="1"' : ""}${x.a ? ' applyAlignment="1"' : ""}` +
          (al ? `>${al}</xf>` : "/>");
      }).join("");
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        (numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.map((c, i) => `<numFmt numFmtId="${164 + i}" formatCode="${xesc(c)}"/>`).join("")}</numFmts>` : "") +
        `<fonts count="${fonts.length}">${fontXml}</fonts><fills count="${fills.length}">${fillXml}</fills>` +
        `<borders count="${borders.length}">${borderXml}</borders>` +
        `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
        `<cellXfs count="${xfs.length}">${xfXml}</cellXfs>` +
        `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
    },
  };
}

function WSheet(name, opts) {
  const o = opts || {};
  return {
    name, tabColor: o.tabColor, freeze: o.freeze, cols: o.cols || [], merges: [],
    rows: {}, heights: {}, maxCol: 0, maxRow: 0,
    put(c, r, cell) {
      if (!this.rows[r]) this.rows[r] = {};
      this.rows[r][c] = cell;
      if (c > this.maxCol) this.maxCol = c;
      if (r > this.maxRow) this.maxRow = r;
      return this;
    },
    txt(c, r, v, s) { return this.put(c, r, { t: "s", v: v === undefined || v === null ? "" : String(v), s }); },
    num(c, r, v, s) { return this.put(c, r, { t: "n", v: isFinite(v) ? v : 0, s }); },
    fml(c, r, f, v, s) { return this.put(c, r, { t: "n", f, v: isFinite(v) ? v : 0, s }); },
    fmlStr(c, r, f, v, s) { return this.put(c, r, { t: "str", f, v: String(v), s }); },
    blank(c, r, s) { return this.put(c, r, { t: "b", s }); },
    band(c0, c1, r, s) { for (let c = c0; c <= c1; c++) if (!(this.rows[r] && this.rows[r][c])) this.blank(c, r, s); return this; },
    merge(c0, r0, c1, r1) { this.merges.push(`${colName(c0)}${r0}:${colName(c1)}${r1}`); return this; },
    height(r, h) { this.heights[r] = h; return this; },
    xml() {
      const rowNums = Object.keys(this.rows).map(Number).sort((a, b) => a - b);
      const body = rowNums.map((r) => {
        const cs = Object.keys(this.rows[r]).map(Number).sort((a, b) => a - b);
        const cells = cs.map((c) => {
          const cell = this.rows[r][c], ref = colName(c) + r;
          const sAttr = cell.s ? ` s="${cell.s}"` : "";
          if (cell.t === "b") return `<c r="${ref}"${sAttr}/>`;
          if (cell.t === "s") return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xesc(cell.v)}</t></is></c>`;
          if (cell.t === "str") return `<c r="${ref}"${sAttr} t="str"><f>${xesc(cell.f)}</f><v>${xesc(cell.v)}</v></c>`;
          if (cell.f) return `<c r="${ref}"${sAttr}><f>${xesc(cell.f)}</f><v>${cell.v}</v></c>`;
          return `<c r="${ref}"${sAttr}><v>${cell.v}</v></c>`;
        }).join("");
        const ht = this.heights[r] ? ` ht="${this.heights[r]}" customHeight="1"` : "";
        return `<row r="${r}"${ht}>${cells}</row>`;
      }).join("");
      const colsXml = this.cols.length
        ? `<cols>${this.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
      let pane = "";
      if (this.freeze) {
        const fc = this.freeze[0], fr = this.freeze[1];
        pane = `<pane${fc ? ` xSplit="${fc}"` : ""}${fr ? ` ySplit="${fr}"` : ""} topLeftCell="${colName(fc)}${fr + 1}" activePane="bottomRight" state="frozen"/>`;
      }
      const dim = `A1:${colName(Math.max(this.maxCol, 0))}${Math.max(this.maxRow, 1)}`;
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        (this.tabColor ? `<sheetPr><tabColor rgb="FF${this.tabColor}"/></sheetPr>` : "") +
        `<dimension ref="${dim}"/><sheetViews><sheetView showGridLines="0" workbookViewId="0">${pane}</sheetView></sheetViews>` +
        `<sheetFormatPr defaultRowHeight="15"/>` + colsXml + `<sheetData>${body}</sheetData>` +
        (this.merges.length ? `<mergeCells count="${this.merges.length}">${this.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "") +
        `<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/></worksheet>`;
    },
  };
}

function writeXlsx(sheets, styles) {
  const files = [];
  files.push({ name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` });
  files.push({ name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` });
  files.push({ name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr/><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${xesc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><calcPr calcId="171027" fullCalcOnLoad="1"/></workbook>` });
  files.push({ name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` });
  files.push({ name: "xl/styles.xml", data: styles.xml() });
  sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.xml() }));
  return zipStore(files);
}

/* ------------------------------------------------------------------ *
 * WORKBOOK PALETTE — matches the house financial-model conventions
 * ------------------------------------------------------------------ */
const XP = {
  title: "1F4E78", banner: "2E5395", block: "F2F2F2", period: "C6EFCE", periodTxt: "006100",
  ctrlFill: "FFF2CC", warnFill: "FFEB9C", warnTxt: "9C6500", badFill: "FFC7CE", badTxt: "9C0006",
  goodTxt: "375623", soft: "D9E1F2", accent: "FCE4D6", grey: "808080", rule: "BFBFBF",
  input: "0000FA", link: "008000", head: "FF0000", white: "FFFFFF", body: "444444",
};
const XNF = {
  acct: '_(* #,##0_);_(* \\(#,##0\\);_(* \\-??_);_(@_)',
  acct2: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* \\-??_);_(@_)',
  pct: "0.0%", pct2: "0.00%", x: '0.00\\x', x1: '0.0\\x', int: "0", txt: "@",
};
const TAB = {
  dash: "C00000", control: "FFC000", statement: "4472C4", schedule: "ED7D31",
  valuation: "70AD47", support: "808080",
};

/* Sheet row maps. Banners and headers occupy fixed rows so every
   cross-sheet formula resolves to a known address. */
const AS = {
  rev: 6, ebitda: 7, margin: 8, netDebt: 9, mcap: 10, curX: 11,
  entryX: 14, txnFee: 15, finFee: 16, roll: 17,
  tlLev: 20, tlRate: 21, tlAm: 22, snLev: 23, snRate: 24, revSize: 25, revRate: 26, sweep: 27, cashRate: 28, minCash: 29,
  growth: 33, exitMargin: 34, capex: 35, da: 36, nwc: 37, tax: 38,
  years: 41, exitX: 42, exitFee: 43, hurdle: 44,
  scen: 47, aGrowth: 48, aMargin: 49,
};
const SU = { ev: 6, txn: 7, fin: 8, cash: 9, uses: 10, tl: 14, sn: 15, debt: 16, roll: 17, sponsor: 18, equity: 19, sources: 20, check: 23, own: 24, lev: 25, impEq: 26, prem: 27 };
const OP = { rev: 6, growth: 7, margin: 8, ebitda: 9, da: 10, ebit: 11, capex: 14, nwc: 15 };
const DS = {
  ebit: 6, tlI: 7, snI: 8, revI: 9, totI: 10, intInc: 11, ff: 12, ebt: 13,
  nolO: 14, nolU: 15, nolC: 16, tax: 17, ni: 18,
  cfads: 21, mand: 22, avail: 23, revA: 24, sweep: 25, cashF: 26,
  tlO: 29, tlC: 30, snO: 31, snC: 32, revO: 33, revC: 34, cashO: 35, cashC: 36, gross: 37, net: 38,
  lev: 41, glev: 42, cov: 43, fcf: 44,
};
const RT = { year: 6, ebitda: 7, mult: 8, ev: 9, fees: 10, debt: 11, cash: 12, equity: 13, own: 16, proceeds: 17, invested: 18, moic: 19, irr: 20, hurdle: 21, head: 22, yearRow: 25, cf: 26 };

const A = (r) => `Assumptions!$B$${r}`;
const Su = (r) => `'Sources & Uses'!$B$${r}`;
const Rt = (r) => `Returns!$B$${r}`;

function buildWorkbook(d) {
  const a = d.assumptions, m = d.model, r = d.research;
  const cur = r.currency, n = a.exit_year;
  const SB = StyleBook();
  const S = {
    title: SB.s({ font: { b: true, sz: 14, color: XP.white }, fill: XP.title, align: { v: "center" } }),
    subtitle: SB.s({ font: { sz: 10, color: XP.white }, fill: XP.title }),
    banner: SB.s({ font: { b: true, color: XP.white }, fill: XP.banner }),
    colHdr: SB.s({ font: { b: true, color: XP.white }, fill: XP.banner, align: { h: "center" } }),
    colHdrL: SB.s({ font: { b: true, color: XP.white }, fill: XP.banner }),
    period: SB.s({ font: { b: true, color: XP.periodTxt }, fill: XP.period, align: { h: "center" } }),
    periodL: SB.s({ font: { b: true, color: XP.periodTxt }, fill: XP.period }),
    sect: SB.s({ font: { b: true, color: XP.head } }),
    lbl: SB.s({}),
    lblI: SB.s({ align: { indent: 1 } }),
    lblB: SB.s({ font: { b: true } }),
    lblBlk: SB.s({ fill: XP.block }),
    lblBlkB: SB.s({ font: { b: true }, fill: XP.block }),
    note: SB.s({ font: { i: true, sz: 9, color: XP.grey } }),
    noteWrap: SB.s({ font: { i: true, sz: 9, color: XP.grey }, align: { wrap: true, v: "top" } }),
    body: SB.s({ font: { color: XP.body }, align: { wrap: true, v: "top" } }),
    tag: SB.s({ font: { sz: 9, color: XP.grey }, align: { h: "center" } }),
    ctrl: SB.s({ font: { b: true, color: XP.title }, fill: XP.ctrlFill, numFmt: XNF.int, align: { h: "center" } }),
    /* value styles: in = hardcoded input, fm = in-sheet formula, lk = cross-sheet link */
    inAcct: SB.s({ font: { color: XP.input }, numFmt: XNF.acct }),
    inPct: SB.s({ font: { color: XP.input }, numFmt: XNF.pct }),
    inX: SB.s({ font: { color: XP.input }, numFmt: XNF.x }),
    inInt: SB.s({ font: { color: XP.input }, numFmt: XNF.int }),
    fmAcct: SB.s({ numFmt: XNF.acct }),
    fmPct: SB.s({ numFmt: XNF.pct }),
    fmX: SB.s({ numFmt: XNF.x }),
    fmInt: SB.s({ numFmt: XNF.int }),
    fmAcctB: SB.s({ font: { b: true }, numFmt: XNF.acct }),
    lkAcct: SB.s({ font: { color: XP.link }, numFmt: XNF.acct }),
    lkPct: SB.s({ font: { color: XP.link }, numFmt: XNF.pct }),
    lkX: SB.s({ font: { color: XP.link }, numFmt: XNF.x }),
    lkAcctBlk: SB.s({ font: { b: true, color: XP.link }, numFmt: XNF.acct, fill: XP.block }),
    lkPctBlk: SB.s({ font: { b: true, color: XP.link }, numFmt: XNF.pct, fill: XP.block }),
    lkXBlk: SB.s({ font: { b: true, color: XP.link }, numFmt: XNF.x, fill: XP.block }),
    lkIntBlk: SB.s({ font: { b: true, color: XP.link }, numFmt: XNF.int, fill: XP.block }),
    lkStrBlk: SB.s({ font: { b: true, color: XP.link }, fill: XP.block }),
    totAcct: SB.s({ font: { b: true }, numFmt: XNF.acct, border: { top: { style: "thin" } } }),
    totPct: SB.s({ font: { b: true }, numFmt: XNF.pct, border: { top: { style: "thin" } } }),
    totX: SB.s({ font: { b: true }, numFmt: XNF.x, border: { top: { style: "thin" } } }),
    checkOK: SB.s({ font: { b: true, color: XP.goodTxt }, numFmt: XNF.acct2, fill: XP.period }),
    checkBad: SB.s({ font: { b: true, color: XP.badTxt }, numFmt: XNF.acct2, fill: XP.badFill }),
    warnTxt: SB.s({ font: { color: XP.warnTxt }, fill: XP.warnFill, align: { wrap: true, v: "top" } }),
    gridCell: SB.s({ numFmt: XNF.x, border: { top: { style: "thin", color: XP.rule }, bottom: { style: "thin", color: XP.rule }, left: { style: "thin", color: XP.rule }, right: { style: "thin", color: XP.rule } }, align: { h: "center" } }),
    gridCellP: SB.s({ numFmt: XNF.pct, border: { top: { style: "thin", color: XP.rule }, bottom: { style: "thin", color: XP.rule }, left: { style: "thin", color: XP.rule }, right: { style: "thin", color: XP.rule } }, align: { h: "center" } }),
    gridLive: SB.s({ font: { b: true, color: XP.title }, numFmt: XNF.x, fill: XP.ctrlFill, border: { top: { style: "thin", color: XP.rule }, bottom: { style: "thin", color: XP.rule }, left: { style: "thin", color: XP.rule }, right: { style: "thin", color: XP.rule } }, align: { h: "center" } }),
    gridLiveP: SB.s({ font: { b: true, color: XP.title }, numFmt: XNF.pct, fill: XP.ctrlFill, border: { top: { style: "thin", color: XP.rule }, bottom: { style: "thin", color: XP.rule }, left: { style: "thin", color: XP.rule }, right: { style: "thin", color: XP.rule } }, align: { h: "center" } }),
    gridAxis: SB.s({ font: { b: true }, numFmt: XNF.x, fill: XP.soft, align: { h: "center" } }),
    sevHigh: SB.s({ font: { b: true, color: XP.badTxt }, fill: XP.badFill, align: { h: "center" } }),
    sevMed: SB.s({ font: { b: true, color: XP.warnTxt }, fill: XP.warnFill, align: { h: "center" } }),
    sevLow: SB.s({ font: { color: XP.grey }, fill: XP.block, align: { h: "center" } }),
  };

  const yc = (k) => k + 1;                 // Y1 sits in column index 2 (C)
  const yr = (k) => colName(yc(k));
  const sheets = [];
  const banner = (sh, row, text, wide) => { sh.txt(0, row, text, S.banner).band(0, wide, row, S.banner).merge(0, row, wide, row); };
  const titleBlock = (sh, wide, t1, t2) => {
    sh.height(1, 22).height(2, 14);
    sh.txt(0, 1, t1, S.title).band(0, wide, 1, S.title).merge(0, 1, wide, 1);
    sh.txt(0, 2, t2, S.subtitle).band(0, wide, 2, S.subtitle).merge(0, 2, wide, 2);
  };
  const unitNote = `${cur} figures in millions unless stated otherwise`;
  const co = r.company_name + " (" + r.ticker + ")";

  /* ---------------- DASHBOARD ---------------- */
  const W = 5;
  const dash = WSheet("Dashboard", { tabColor: TAB.dash, freeze: [0, 4], cols: [40, 16, 3, 40, 16, 16] });
  titleBlock(dash, W, co.toUpperCase() + " \u2014 LBO MODEL DASHBOARD", unitNote + ". Every figure links to a calculation sheet.");
  banner(dash, 4, "A.  HEADLINE RETURNS AND DEAL VERDICT", W);
  const kv = (row, c0, label, formula, value, style) => {
    dash.txt(c0, row, label, S.lblBlk);
    dash.fml(c0 + 1, row, formula, value, style);
  };
  kv(6, 0, "Sponsor IRR", `=${Rt(RT.irr)}`, m.base.irr, S.lkPctBlk);
  kv(7, 0, "Sponsor MOIC", `=${Rt(RT.moic)}`, m.base.moic, S.lkXBlk);
  kv(8, 0, "Target IRR (hurdle)", `=${A(AS.hurdle)}`, a.hurdle_irr_pct, S.lkPctBlk);
  kv(9, 0, "Headroom to hurdle", `=${Rt(RT.irr)}-${A(AS.hurdle)}`, m.base.irr - a.hurdle_irr_pct, S.lkPctBlk);
  kv(6, 3, "Hold period (years)", `=${A(AS.years)}`, n, S.lkIntBlk);
  kv(7, 3, "Sponsor equity cheque", `=${Su(SU.sponsor)}`, m.sponsorEquity, S.lkAcctBlk);
  kv(8, 3, "Sponsor ownership", `=${Su(SU.own)}`, m.sponsorOwnership, S.lkPctBlk);
  dash.txt(3, 9, "Verdict against hurdle", S.lblBlk);
  dash.fmlStr(4, 9, `IF(${Rt(RT.irr)}>=${A(AS.hurdle)},"CLEARS",IF(${Rt(RT.irr)}>=${A(AS.hurdle)}-0.05,"MARGINAL","BELOW"))`, m.verdict.label, S.lkStrBlk);

  banner(dash, 11, "B.  TRANSACTION AND ENTRY PRICING", W);
  kv(13, 0, "Entry EV/EBITDA", `=${A(AS.entryX)}`, a.entry_multiple_x, S.lkXBlk);
  kv(14, 0, "Purchase enterprise value", `=${Su(SU.ev)}`, m.entryEV, S.lkAcctBlk);
  kv(15, 0, "Implied equity purchase price", `=${Su(SU.impEq)}`, m.impliedEquityPrice, S.lkAcctBlk);
  kv(16, 0, "Premium to market capitalisation", `=${Su(SU.prem)}`, isFinite(m.premiumToMarket) ? m.premiumToMarket : 0, S.lkPctBlk);
  kv(13, 3, "Current trading EV/EBITDA", `=${A(AS.curX)}`, a.current_ev_ebitda_x, S.lkXBlk);
  kv(14, 3, "Entry leverage (x LTM EBITDA)", `=${Su(SU.lev)}`, m.entryLeverage, S.lkXBlk);
  kv(15, 3, "LTM EBITDA margin", `=${A(AS.margin)}`, m.entryMargin, S.lkPctBlk);
  kv(16, 3, "Total debt at close", `=${Su(SU.debt)}`, m.totalDebtClose, S.lkAcctBlk);

  banner(dash, 18, "C.  EXIT AND DELEVERAGING", W);
  const lastY = m.yearsBase[n - 1];
  kv(20, 0, "Exit EV/EBITDA", `=${A(AS.exitX)}`, a.exit_ev_ebitda_x, S.lkXBlk);
  kv(21, 0, "Exit year EBITDA", `=${Rt(RT.ebitda)}`, m.base.exitEBITDA, S.lkAcctBlk);
  kv(22, 0, "Exit enterprise value", `=${Rt(RT.ev)}`, m.base.exitEV, S.lkAcctBlk);
  kv(23, 0, "Exit equity value", `=${Rt(RT.equity)}`, m.base.exitEquityValue, S.lkAcctBlk);
  kv(20, 3, "Exit net debt", `=${Rt(RT.debt)}-${Rt(RT.cash)}`, m.base.exitDebt - m.base.exitCash, S.lkAcctBlk);
  kv(21, 3, "Exit net leverage", `='Debt Schedule'!${yr(n)}${DS.lev}`, lastY.leverage, S.lkXBlk);
  kv(22, 3, "Turns of deleveraging", `=${Su(SU.lev)}-'Debt Schedule'!${yr(n)}${DS.lev}`, m.entryLeverage - lastY.leverage, S.lkXBlk);
  kv(23, 3, "Sponsor proceeds at exit", `=${Rt(RT.proceeds)}`, m.base.sponsorProceeds, S.lkAcctBlk);

  banner(dash, 25, "D.  SCENARIO OUTCOMES", W);
  dash.txt(0, 26, "Scenario", S.colHdrL); dash.txt(1, 26, "MOIC", S.colHdr);
  dash.txt(3, 26, "IRR", S.colHdr); dash.txt(4, 26, "Exit net leverage", S.colHdr);
  [["Downside", m.downside, m.yearsDownside], ["Base", m.base, m.yearsBase], ["Upside", m.upside, m.yearsUpside]].forEach((sc, i) => {
    const row = 27 + i, bold = sc[0] === "Base";
    dash.txt(0, row, sc[0], bold ? S.lblB : S.lbl);
    dash.num(1, row, sc[1].moic, S.fmX);
    dash.num(3, row, sc[1].irr, S.fmPct);
    dash.num(4, row, sc[2][n - 1].leverage, S.fmX);
  });
  dash.txt(0, 31, "Engine snapshots. Set the scenario switch on Assumptions!B" + AS.scen + " to 1, 2 or 3 to drive every live sheet.", S.note);

  banner(dash, 33, "E.  AUDIT CHECKS", W);
  dash.txt(0, 34, "Sources less uses (must be zero)", S.lbl);
  dash.fml(1, 34, `=${Su(SU.check)}`, 0, S.checkOK);
  dash.txt(0, 35, "Value bridge residual (must be zero)", S.lbl);
  dash.fml(1, 35, `='Value Bridge'!$B$14`, m.bridge.check, Math.abs(m.bridge.check) < 1e-6 ? S.checkOK : S.checkBad);
  dash.txt(3, 34, "Minimum interest coverage, base case", S.lbl);
  dash.fml(4, 34, `=MIN('Debt Schedule'!${yr(1)}${DS.cov}:${yr(n)}${DS.cov})`, Math.min.apply(null, m.yearsBase.map((y) => (isFinite(y.coverage) ? y.coverage : 99))), S.fmX);
  dash.txt(3, 35, "Minimum cash balance, base case", S.lbl);
  dash.fml(4, 35, `=MIN('Debt Schedule'!${yr(1)}${DS.cashC}:${yr(n)}${DS.cashC})`, Math.min.apply(null, m.yearsBase.map((y) => y.cash)), S.fmAcct);

  let dr = 37;
  if (m.warnings.length) {
    banner(dash, dr, "F.  MODEL WARNINGS", W); dr++;
    m.warnings.forEach((w) => {
      dash.txt(0, dr, w, S.warnTxt).band(0, W, dr, S.warnTxt).merge(0, dr, W, dr);
      dash.height(dr, 28); dr++;
    });
    dr++;
  }
  dash.txt(0, dr, "Source for research figures: " + r.source_note, S.note);
  dash.txt(0, dr + 1, "Blue = hardcoded input \u00b7 green = link to another sheet \u00b7 black = in-sheet formula. All inputs live on the Assumptions sheet.", S.note);
  sheets.push(dash);

  /* ---------------- ASSUMPTIONS ---------------- */
  const asm = WSheet("Assumptions", { tabColor: TAB.control, freeze: [1, 5], cols: [44, 15, 15, 15, 11, 30, 64] });
  titleBlock(asm, 6, co.toUpperCase() + " \u2014 ASSUMPTIONS AND CONTROLS", "Every hardcoded input in this workbook lives on this sheet. Type over the blue cells; all other sheets recalculate.");
  banner(asm, 4, "A.  TARGET FINANCIALS", 6);
  asm.txt(0, 5, "Line item", S.colHdrL); asm.txt(1, 5, "Base", S.colHdr); asm.txt(2, 5, "Upside", S.colHdr);
  asm.txt(3, 5, "Downside", S.colHdr); asm.txt(4, 5, "Type", S.colHdr);
  asm.txt(5, 5, "Source", S.colHdrL); asm.txt(6, 5, "Basis / rationale", S.colHdrL);
  const inp = (row, label, value, st, note, src) => {
    asm.txt(0, row, label, S.lblI); asm.num(1, row, value, st); asm.txt(4, row, "INPUT", S.tag);
    if (src) asm.txt(5, row, src, S.note);
    if (note) asm.txt(6, row, note, S.note);
  };
  const FILED = r.filing_type && r.filing_type !== "\u2014" ? r.filing_type + (r.filing_period && r.filing_period !== "\u2014" ? ", " + r.filing_period : "") : "Primary filing";
  const JUDG = "Analyst judgement";
  inp(AS.rev, "LTM revenue", a.ltm_revenue_mm, S.inAcct, r.source_note, FILED);
  inp(AS.ebitda, "LTM EBITDA", a.ltm_ebitda_mm, S.inAcct, r.ebitda_basis, FILED);
  asm.txt(0, AS.margin, "LTM EBITDA margin", S.lblI);
  asm.fml(1, AS.margin, `=B${AS.ebitda}/B${AS.rev}`, m.entryMargin, S.fmPct);
  asm.txt(4, AS.margin, "FORMULA", S.tag);
  inp(AS.netDebt, "Net debt at announcement", a.net_debt_mm, S.inAcct, "Gross borrowings including leases where reported, less cash", FILED);
  inp(AS.mcap, "Market capitalisation", a.market_cap_mm, S.inAcct, "Most recent close", "Exchange");
  inp(AS.curX, "Current trading EV/EBITDA", a.current_ev_ebitda_x, S.inX, "Most recent close over LTM EBITDA", "Exchange");

  banner(asm, 13, "B.  TRANSACTION STRUCTURE", 6);
  inp(AS.entryX, "Entry EV/EBITDA", a.entry_multiple_x, S.inX, d.a1 ? d.a1.rationale : "", d.a1 ? d.a1.evidence : JUDG);
  inp(AS.txnFee, "Transaction fees (% of EV)", a.txn_fee_pct, S.inPct);
  inp(AS.finFee, "Financing fees (% of debt)", a.financing_fee_pct, S.inPct);
  inp(AS.roll, "Management rollover (% of equity)", a.mgmt_rollover_pct, S.inPct);

  banner(asm, 19, "C.  CAPITAL STRUCTURE", 6);
  inp(AS.tlLev, "Term loan leverage (x LTM EBITDA)", a.term_loan_leverage_x, S.inX, d.a2 ? d.a2.rationale : "", d.a2 ? d.a2.evidence : JUDG);
  inp(AS.tlRate, "Term loan interest rate", a.term_loan_rate_pct, S.inPct);
  inp(AS.tlAm, "Term loan amortisation (% of original)", a.term_loan_amort_pct, S.inPct);
  inp(AS.snLev, "Senior notes leverage (x LTM EBITDA)", a.senior_notes_leverage_x, S.inX);
  inp(AS.snRate, "Senior notes coupon", a.senior_notes_rate_pct, S.inPct);
  inp(AS.revSize, "Revolver commitment", a.revolver_size_mm, S.inAcct);
  inp(AS.revRate, "Revolver drawn rate", a.revolver_rate_pct, S.inPct);
  inp(AS.sweep, "Cash sweep of excess cash flow", a.cash_sweep_pct, S.inPct);
  inp(AS.cashRate, "Interest earned on cash", a.cash_interest_rate_pct, S.inPct);
  inp(AS.minCash, "Minimum cash (% of revenue)", a.min_cash_pct_revenue, S.inPct);

  banner(asm, 31, "D.  OPERATING CASES", 6);
  asm.txt(0, 32, "Driver", S.colHdrL); asm.txt(1, 32, "Base", S.colHdr); asm.txt(2, 32, "Upside", S.colHdr);
  asm.txt(3, 32, "Downside", S.colHdr); asm.txt(4, 32, "Type", S.colHdr);
  asm.txt(5, 32, "Source", S.colHdrL); asm.txt(6, 32, "Basis / rationale", S.colHdrL);
  asm.txt(0, AS.growth, "Revenue growth (annual)", S.lblI);
  asm.num(1, AS.growth, a.revenue_growth_base_pct, S.inPct);
  asm.num(2, AS.growth, a.revenue_growth_upside_pct, S.inPct);
  asm.num(3, AS.growth, a.revenue_growth_downside_pct, S.inPct);
  asm.txt(4, AS.growth, "INPUT", S.tag);
  asm.txt(5, AS.growth, d.a4 ? d.a4.evidence : JUDG, S.note);
  asm.txt(6, AS.growth, d.a4 ? d.a4.rationale : "", S.note);
  asm.txt(0, AS.exitMargin, "EBITDA margin at exit year", S.lblI);
  asm.num(1, AS.exitMargin, a.exit_margin_base_pct, S.inPct);
  asm.num(2, AS.exitMargin, a.exit_margin_upside_pct, S.inPct);
  asm.num(3, AS.exitMargin, a.exit_margin_downside_pct, S.inPct);
  asm.txt(4, AS.exitMargin, "INPUT", S.tag);
  asm.txt(5, AS.exitMargin, d.a4 ? d.a4.evidence : JUDG, S.note);
  asm.txt(6, AS.exitMargin, "Margins ramp linearly from the LTM margin to this level.", S.note);
  inp(AS.capex, "Capital expenditure (% of revenue)", a.capex_pct_revenue, S.inPct);
  inp(AS.da, "Depreciation & amortisation (% of revenue)", a.da_pct_revenue, S.inPct);
  inp(AS.nwc, "Working capital (% of revenue change)", a.nwc_pct_delta_revenue, S.inPct);
  inp(AS.tax, "Cash tax rate", a.tax_rate_pct, S.inPct);

  banner(asm, 40, "E.  EXIT AND RETURN HURDLE", 6);
  inp(AS.years, "Hold period (years)", n, S.inInt, d.a3 ? d.a3.rationale : "", d.a3 ? d.a3.evidence : JUDG);
  inp(AS.exitX, "Exit EV/EBITDA", a.exit_ev_ebitda_x, S.inX);
  inp(AS.exitFee, "Exit fees (% of EV)", a.exit_fee_pct, S.inPct);
  inp(AS.hurdle, "Target IRR (hurdle)", a.hurdle_irr_pct, S.inPct);

  banner(asm, 46, "F.  SCENARIO CONTROL", 6);
  asm.txt(0, AS.scen, "SELECT SCENARIO:", S.lblB);
  asm.num(1, AS.scen, 1, S.ctrl);
  asm.txt(2, AS.scen, "\u2190 Type 1 for Base, 2 for Upside, 3 for Downside", S.note);
  asm.txt(0, AS.aGrowth, "\u25b6 Active revenue growth", S.lblI);
  asm.fml(1, AS.aGrowth, `=CHOOSE($B$${AS.scen},$B$${AS.growth},$C$${AS.growth},$D$${AS.growth})`, a.revenue_growth_base_pct, S.lkPctBlk);
  asm.txt(4, AS.aGrowth, "FORMULA", S.tag);
  asm.txt(0, AS.aMargin, "\u25b6 Active exit EBITDA margin", S.lblI);
  asm.fml(1, AS.aMargin, `=CHOOSE($B$${AS.scen},$B$${AS.exitMargin},$C$${AS.exitMargin},$D$${AS.exitMargin})`, a.exit_margin_base_pct, S.lkPctBlk);
  asm.txt(4, AS.aMargin, "FORMULA", S.tag);

  banner(asm, 51, "G.  LEGEND", 6);
  [["Blue text", "Hardcoded input. These are the only cells to type over."],
   ["Green text", "Link to another sheet in this workbook."],
   ["Black text", "Formula calculated within its own sheet."],
   ["Cream fill", "Control cell that drives the whole model."],
   ["Green fill", "Period header, or an audit check that must hold."],
   ["Amber fill", "Warning raised by the model engine."]].forEach((L, i) => {
    asm.txt(0, 52 + i, L[0], i === 0 ? S.inAcct : i === 1 ? SB.s({ font: { color: XP.link } }) : i === 3 ? S.ctrl : i === 4 ? S.periodL : i === 5 ? S.warnTxt : S.lbl);
    asm.txt(1, 52 + i, L[1], S.note);
    asm.merge(1, 52 + i, 6, 52 + i);
  });
  sheets.push(asm);

  /* ---------------- SOURCES & USES ---------------- */
  const su = WSheet("Sources & Uses", { tabColor: TAB.statement, freeze: [1, 5], cols: [44, 16, 14, 60] });
  titleBlock(su, 3, "SOURCES AND USES OF FUNDS", unitNote + ". Cash-free, debt-free basis: existing debt is refinanced at close.");
  banner(su, 4, "A.  USES OF FUNDS", 3);
  su.txt(0, 5, "Item", S.colHdrL); su.txt(1, 5, "Amount", S.colHdr); su.txt(2, 5, "% of total", S.colHdr); su.txt(3, 5, "Basis", S.colHdrL);
  const suRow = (row, label, formula, value, basis, isTotal) => {
    su.txt(0, row, label, isTotal ? S.lblB : S.lblI);
    su.fml(1, row, formula, value, isTotal ? S.totAcct : S.fmAcct);
    su.fml(2, row, `=IF($B$${SU.uses}<>0,B${row}/$B$${SU.uses},0)`, m.totalUses ? value / m.totalUses : 0, isTotal ? S.totPct : S.fmPct);
    if (basis) su.txt(3, row, basis, S.note);
  };
  suRow(SU.ev, "Purchase enterprise value", `=${A(AS.ebitda)}*${A(AS.entryX)}`, m.entryEV, "LTM EBITDA \u00d7 entry multiple");
  suRow(SU.txn, "Transaction fees", `=B${SU.ev}*${A(AS.txnFee)}`, m.txnFees, "% of enterprise value");
  suRow(SU.fin, "Financing fees", `=B${SU.debt}*${A(AS.finFee)}`, m.finFees, "% of total debt raised");
  suRow(SU.cash, "Cash to balance sheet", `=${A(AS.rev)}*${A(AS.minCash)}`, m.minCash, "Minimum operating cash");
  su.txt(0, SU.uses, "TOTAL USES", S.lblB);
  su.fml(1, SU.uses, `=SUM(B${SU.ev}:B${SU.cash})`, m.totalUses, S.totAcct);
  su.fml(2, SU.uses, `=IF($B$${SU.uses}<>0,B${SU.uses}/$B$${SU.uses},0)`, 1, S.totPct);

  banner(su, 12, "B.  SOURCES OF FUNDS", 3);
  su.txt(0, 13, "Instrument", S.colHdrL); su.txt(1, 13, "Amount", S.colHdr); su.txt(2, 13, "% of total", S.colHdr); su.txt(3, 13, "Basis", S.colHdrL);
  suRow(SU.tl, "Term loan", `=${A(AS.tlLev)}*${A(AS.ebitda)}`, m.tlAmount, "Turns of LTM EBITDA");
  suRow(SU.sn, "Senior notes", `=${A(AS.snLev)}*${A(AS.ebitda)}`, m.snAmount, "Turns of LTM EBITDA");
  su.txt(0, SU.debt, "Total debt", S.lblB);
  su.fml(1, SU.debt, `=B${SU.tl}+B${SU.sn}`, m.totalDebtClose, S.totAcct);
  su.fml(2, SU.debt, `=IF($B$${SU.uses}<>0,B${SU.debt}/$B$${SU.uses},0)`, m.totalDebtClose / m.totalUses, S.totPct);
  suRow(SU.roll, "Management rollover", `=B${SU.equity}*${A(AS.roll)}`, m.mgmtRollover, "% of total equity");
  suRow(SU.sponsor, "Sponsor equity", `=B${SU.equity}-B${SU.roll}`, m.sponsorEquity, "Balancing equity cheque");
  su.txt(0, SU.equity, "Total equity", S.lblB);
  su.fml(1, SU.equity, `=B${SU.uses}-B${SU.debt}`, m.totalEquity, S.totAcct);
  su.fml(2, SU.equity, `=IF($B$${SU.uses}<>0,B${SU.equity}/$B$${SU.uses},0)`, m.totalEquity / m.totalUses, S.totPct);
  su.txt(0, SU.sources, "TOTAL SOURCES", S.lblB);
  su.fml(1, SU.sources, `=B${SU.debt}+B${SU.equity}`, m.totalDebtClose + m.totalEquity, S.totAcct);

  banner(su, 22, "C.  CHECKS AND ENTRY METRICS", 3);
  su.txt(0, SU.check, "Check: sources less uses (must be zero)", S.lblB);
  su.fml(1, SU.check, `=B${SU.sources}-B${SU.uses}`, 0, S.checkOK);
  su.txt(0, SU.own, "Sponsor ownership of equity", S.lblI);
  su.fml(1, SU.own, `=1-${A(AS.roll)}`, m.sponsorOwnership, S.fmPct);
  su.txt(0, SU.lev, "Entry leverage (x LTM EBITDA)", S.lblI);
  su.fml(1, SU.lev, `=B${SU.debt}/${A(AS.ebitda)}`, m.entryLeverage, S.fmX);
  su.txt(0, SU.impEq, "Implied equity purchase price", S.lblI);
  su.fml(1, SU.impEq, `=B${SU.ev}-${A(AS.netDebt)}`, m.impliedEquityPrice, S.fmAcct);
  su.txt(0, SU.prem, "Premium to market capitalisation", S.lblI);
  su.fml(1, SU.prem, `=IF(${A(AS.mcap)}>0,B${SU.impEq}/${A(AS.mcap)}-1,0)`, isFinite(m.premiumToMarket) ? m.premiumToMarket : 0, S.fmPct);
  su.txt(0, 29, "Enterprise value is paid on a cash-free debt-free basis, so the implied equity price nets off existing net debt.", S.note);
  sheets.push(su);

  /* ---------------- OPERATING MODEL ---------------- */
  const opCols = [44, 14].concat(Array(n).fill(13));
  const op = WSheet("Operating Model", { tabColor: TAB.statement, freeze: [1, 5], cols: opCols });
  titleBlock(op, n + 1, "OPERATING MODEL", unitNote + ". Driven by the active scenario on Assumptions!B" + AS.scen + ".");
  banner(op, 4, "A.  REVENUE AND EARNINGS", n + 1);
  op.txt(0, 5, "Line item", S.periodL); op.txt(1, 5, "LTM", S.period);
  for (let k = 1; k <= n; k++) op.txt(yc(k), 5, "Y" + k, S.period);
  op.txt(0, OP.rev, "Revenue", S.lblI);
  op.fml(1, OP.rev, `=${A(AS.rev)}`, a.ltm_revenue_mm, S.lkAcct);
  op.txt(0, OP.growth, "Revenue growth", S.lblI);
  op.txt(0, OP.margin, "EBITDA margin", S.lblI);
  op.fml(1, OP.margin, `=${A(AS.margin)}`, m.entryMargin, S.lkPct);
  op.txt(0, OP.ebitda, "EBITDA", S.sect);
  op.fml(1, OP.ebitda, `=${A(AS.ebitda)}`, a.ltm_ebitda_mm, S.lkAcct);
  op.txt(0, OP.da, "Depreciation and amortisation", S.lblI);
  op.txt(0, OP.ebit, "EBIT", S.sect);
  banner(op, 13, "B.  CASH ITEMS", n + 1);
  op.txt(0, OP.capex, "Capital expenditure", S.lblI);
  op.txt(0, OP.nwc, "(Increase) in working capital", S.lblI);
  m.yearsBase.forEach((y, i) => {
    const k = i + 1, c = yc(k), C = yr(k), P = colName(c - 1);
    op.fml(c, OP.rev, `=${P}${OP.rev}*(1+${A(AS.aGrowth)})`, y.revenue, S.fmAcct);
    op.fml(c, OP.growth, `=${C}${OP.rev}/${P}${OP.rev}-1`, y.growth, S.fmPct);
    op.fml(c, OP.margin, `=${A(AS.margin)}+(${A(AS.aMargin)}-${A(AS.margin)})*((COLUMN()-2)/${A(AS.years)})`, y.margin, S.fmPct);
    op.fml(c, OP.ebitda, `=${C}${OP.rev}*${C}${OP.margin}`, y.ebitda, S.fmAcctB);
    op.fml(c, OP.da, `=${C}${OP.rev}*${A(AS.da)}`, y.da, S.fmAcct);
    op.fml(c, OP.ebit, `=${C}${OP.ebitda}-${C}${OP.da}`, y.ebit, S.fmAcctB);
    op.fml(c, OP.capex, `=${C}${OP.rev}*${A(AS.capex)}`, y.capex, S.fmAcct);
    op.fml(c, OP.nwc, `=(${C}${OP.rev}-${P}${OP.rev})*${A(AS.nwc)}`, y.deltaNWC, S.fmAcct);
  });
  op.txt(0, 17, "Margins ramp linearly from the LTM margin to the active exit margin over the hold period.", S.note);
  sheets.push(op);

  /* ---------------- DEBT SCHEDULE ---------------- */
  const ds = WSheet("Debt Schedule", { tabColor: TAB.schedule, freeze: [1, 5], cols: [44, 3].concat(Array(n).fill(13)) });
  titleBlock(ds, n + 1, "DEBT SCHEDULE AND CASH FLOW WATERFALL", unitNote + ". Interest accrues on opening balances, so there is no circular reference.");
  banner(ds, 4, "A.  INTEREST, TAX AND EARNINGS", n + 1);
  ds.txt(0, 5, "Line item", S.periodL);
  for (let k = 1; k <= n; k++) ds.txt(yc(k), 5, "Y" + k, S.period);
  const dsLbl = [
    [DS.ebit, "EBIT (linked)", 0], [DS.tlI, "Term loan interest", 1], [DS.snI, "Senior notes interest", 1],
    [DS.revI, "Revolver interest", 1], [DS.totI, "Total interest expense", 2], [DS.intInc, "Interest income on cash", 1],
    [DS.ff, "Financing fee amortisation", 1], [DS.ebt, "Profit before tax", 2],
    [DS.nolO, "Loss carryforward, opening", 1], [DS.nolU, "Carryforward utilised", 1], [DS.nolC, "Loss carryforward, closing", 1],
    [DS.tax, "Cash taxes", 1], [DS.ni, "Net income", 2],
    [DS.cfads, "Cash flow available for debt service", 2], [DS.mand, "Mandatory amortisation", 1],
    [DS.avail, "Cash available after mandatory amortisation", 1], [DS.revA, "Revolver draw / (repayment)", 1],
    [DS.sweep, "Cash sweep of term loan", 1], [DS.cashF, "Net movement in cash", 2],
    [DS.tlO, "Term loan, opening", 1], [DS.tlC, "Term loan, closing", 1],
    [DS.snO, "Senior notes, opening", 1], [DS.snC, "Senior notes, closing", 1],
    [DS.revO, "Revolver, opening", 1], [DS.revC, "Revolver, closing", 1],
    [DS.cashO, "Cash, opening", 1], [DS.cashC, "Cash, closing", 1],
    [DS.gross, "Total debt", 2], [DS.net, "Net debt", 2],
    [DS.lev, "Net debt / EBITDA", 1], [DS.glev, "Gross debt / EBITDA", 1],
    [DS.cov, "EBITDA / interest expense", 1], [DS.fcf, "Cash conversion (CFADS / EBITDA)", 1],
  ];
  dsLbl.forEach((p) => ds.txt(0, p[0], p[1], p[2] === 2 ? S.sect : p[2] === 1 ? S.lblI : S.lbl));
  banner(ds, 20, "B.  CASH FLOW WATERFALL", n + 1);
  banner(ds, 28, "C.  DEBT AND CASH BALANCES", n + 1);
  banner(ds, 40, "D.  CREDIT STATISTICS", n + 1);
  m.yearsBase.forEach((y, i) => {
    const k = i + 1, c = yc(k), C = yr(k), P = colName(c - 1), first = k === 1;
    ds.fml(c, DS.ebit, `='Operating Model'!${C}${OP.ebit}`, y.ebit, S.lkAcct);
    ds.fml(c, DS.tlI, `=${C}${DS.tlO}*${A(AS.tlRate)}`, y.tlInterest, S.fmAcct);
    ds.fml(c, DS.snI, `=${C}${DS.snO}*${A(AS.snRate)}`, y.snInterest, S.fmAcct);
    ds.fml(c, DS.revI, `=${C}${DS.revO}*${A(AS.revRate)}`, y.revInterest, S.fmAcct);
    ds.fml(c, DS.totI, `=SUM(${C}${DS.tlI}:${C}${DS.revI})`, y.interest, S.fmAcctB);
    ds.fml(c, DS.intInc, `=MAX(0,${C}${DS.cashO})*${A(AS.cashRate)}`, y.cashInterest, S.fmAcct);
    ds.fml(c, DS.ff, k <= FIN_FEE_AMORT_YEARS ? `=${Su(SU.fin)}/${FIN_FEE_AMORT_YEARS}` : `=0`, y.finFeeAmort, S.fmAcct);
    ds.fml(c, DS.ebt, `=${C}${DS.ebit}-${C}${DS.totI}+${C}${DS.intInc}-${C}${DS.ff}`, y.ebt, S.fmAcctB);
    ds.fml(c, DS.nolO, first ? `=0` : `=${P}${DS.nolC}`, y.nolOpen, S.fmAcct);
    ds.fml(c, DS.nolU, `=IF(${C}${DS.ebt}>0,MIN(${C}${DS.nolO},${C}${DS.ebt}),0)`, y.nolUsed, S.fmAcct);
    ds.fml(c, DS.nolC, `=${C}${DS.nolO}-${C}${DS.nolU}+IF(${C}${DS.ebt}<0,-${C}${DS.ebt},0)`, y.nolClose, S.fmAcct);
    ds.fml(c, DS.tax, `=IF(${C}${DS.ebt}>0,(${C}${DS.ebt}-${C}${DS.nolU})*${A(AS.tax)},0)`, y.taxes, S.fmAcct);
    ds.fml(c, DS.ni, `=${C}${DS.ebt}-${C}${DS.tax}`, y.ni, S.fmAcctB);
    ds.fml(c, DS.cfads, `=${C}${DS.ni}+'Operating Model'!${C}${OP.da}+${C}${DS.ff}-'Operating Model'!${C}${OP.capex}-'Operating Model'!${C}${OP.nwc}`, y.cfads, S.fmAcctB);
    ds.fml(c, DS.mand, `=-MIN(${C}${DS.tlO},${Su(SU.tl)}*${A(AS.tlAm)})`, y.mandatoryAmort, S.fmAcct);
    ds.fml(c, DS.avail, `=${C}${DS.cfads}+${C}${DS.mand}`, y.avail, S.fmAcct);
    ds.fml(c, DS.revA, `=IF(${C}${DS.avail}>=0,-MIN(${C}${DS.revO},${C}${DS.avail}),MIN(${A(AS.revSize)}-${C}${DS.revO},-${C}${DS.avail}))`, y.revAct, S.fmAcct);
    ds.fml(c, DS.sweep, `=-MIN(${C}${DS.tlO}+${C}${DS.mand},MAX(0,${C}${DS.avail}+${C}${DS.revA})*${A(AS.sweep)})`, y.tlSweep, S.fmAcct);
    ds.fml(c, DS.cashF, `=${C}${DS.avail}+${C}${DS.revA}+${C}${DS.sweep}`, y.cashFlowToCash, S.fmAcctB);
    ds.fml(c, DS.tlO, first ? `=${Su(SU.tl)}` : `=${P}${DS.tlC}`, y.tlBegin, first ? S.lkAcct : S.fmAcct);
    ds.fml(c, DS.tlC, `=${C}${DS.tlO}+${C}${DS.mand}+${C}${DS.sweep}`, y.tlEnd, S.fmAcct);
    ds.fml(c, DS.snO, first ? `=${Su(SU.sn)}` : `=${P}${DS.snC}`, y.snBegin, first ? S.lkAcct : S.fmAcct);
    ds.fml(c, DS.snC, `=${C}${DS.snO}`, y.snEnd, S.fmAcct);
    ds.fml(c, DS.revO, first ? `=0` : `=${P}${DS.revC}`, y.revBegin, S.fmAcct);
    ds.fml(c, DS.revC, `=${C}${DS.revO}+${C}${DS.revA}`, y.revEnd, S.fmAcct);
    ds.fml(c, DS.cashO, first ? `=${Su(SU.cash)}` : `=${P}${DS.cashC}`, y.cashBegin, first ? S.lkAcct : S.fmAcct);
    ds.fml(c, DS.cashC, `=${C}${DS.cashO}+${C}${DS.cashF}`, y.cash, S.fmAcct);
    ds.fml(c, DS.gross, `=${C}${DS.tlC}+${C}${DS.snC}+${C}${DS.revC}`, y.totalDebtEnd, S.fmAcctB);
    ds.fml(c, DS.net, `=${C}${DS.gross}-${C}${DS.cashC}`, y.netDebtEnd, S.fmAcctB);
    ds.fml(c, DS.lev, `=IF('Operating Model'!${C}${OP.ebitda}>0,${C}${DS.net}/'Operating Model'!${C}${OP.ebitda},0)`, y.leverage, S.fmX);
    ds.fml(c, DS.glev, `=IF('Operating Model'!${C}${OP.ebitda}>0,${C}${DS.gross}/'Operating Model'!${C}${OP.ebitda},0)`, y.grossLeverage, S.fmX);
    ds.fml(c, DS.cov, `=IF(${C}${DS.totI}>0,'Operating Model'!${C}${OP.ebitda}/${C}${DS.totI},0)`, isFinite(y.coverage) ? y.coverage : 0, S.fmX);
    ds.fml(c, DS.fcf, `=IF('Operating Model'!${C}${OP.ebitda}>0,${C}${DS.cfads}/'Operating Model'!${C}${OP.ebitda},0)`, y.fcfConversion, S.fmPct);
  });
  ds.txt(0, 46, "Waterfall order: mandatory amortisation, then revolver repayment, then a cash sweep of the term loan at the stated rate. Senior notes are bullet.", S.note);
  sheets.push(ds);

  /* ---------------- RETURNS ---------------- */
  const rets = WSheet("Returns", { tabColor: TAB.valuation, freeze: [1, 5], cols: [44, 16].concat(Array(n).fill(13)) });
  const EX = yr(n);
  titleBlock(rets, Math.max(n + 1, 3), "SPONSOR RETURNS", unitNote + ". IRR is solved from the sponsor cash flow vector, not derived from MOIC.");
  banner(rets, 4, "A.  EXIT VALUATION", Math.max(n + 1, 3));
  rets.txt(0, 5, "Line item", S.colHdrL); rets.txt(1, 5, "Value", S.colHdr);
  const rt = (row, label, formula, value, st, bold) => {
    rets.txt(0, row, label, bold ? S.lblB : S.lblI);
    rets.fml(1, row, formula, value, st);
  };
  rt(RT.year, "Hold period (years)", `=${A(AS.years)}`, n, S.fmInt);
  rt(RT.ebitda, "Exit year EBITDA", `='Operating Model'!${EX}${OP.ebitda}`, m.base.exitEBITDA, S.lkAcct);
  rt(RT.mult, "Exit EV/EBITDA", `=${A(AS.exitX)}`, a.exit_ev_ebitda_x, S.lkX);
  rt(RT.ev, "Exit enterprise value", `=B${RT.ebitda}*B${RT.mult}`, m.base.exitEV, S.fmAcctB, true);
  rt(RT.fees, "Exit fees", `=B${RT.ev}*${A(AS.exitFee)}`, m.base.exitFees, S.fmAcct);
  rt(RT.debt, "Total debt at exit", `='Debt Schedule'!${EX}${DS.gross}`, m.base.exitDebt, S.lkAcct);
  rt(RT.cash, "Cash at exit", `='Debt Schedule'!${EX}${DS.cashC}`, m.base.exitCash, S.lkAcct);
  rets.txt(0, RT.equity, "Exit equity value", S.sect);
  rets.fml(1, RT.equity, `=MAX(0,B${RT.ev}-B${RT.fees}-B${RT.debt}+B${RT.cash})`, m.base.exitEquityValue, S.totAcct);
  banner(rets, 15, "B.  SPONSOR RETURNS", Math.max(n + 1, 3));
  rt(RT.own, "Sponsor ownership", `=${Su(SU.own)}`, m.sponsorOwnership, S.lkPct);
  rt(RT.proceeds, "Sponsor proceeds at exit", `=B${RT.equity}*B${RT.own}`, m.base.sponsorProceeds, S.fmAcct);
  rt(RT.invested, "Sponsor equity invested", `=${Su(SU.sponsor)}`, m.sponsorEquity, S.lkAcct);
  rets.txt(0, RT.moic, "Sponsor MOIC", S.sect);
  rets.fml(1, RT.moic, `=IF(B${RT.invested}>0,B${RT.proceeds}/B${RT.invested},0)`, m.base.moic, S.totX);
  const cfLast = colName(1 + n);
  rets.txt(0, RT.irr, "Sponsor IRR", S.sect);
  rets.fml(1, RT.irr, `=IFERROR(IRR(B${RT.cf}:${cfLast}${RT.cf}),-1)`, m.base.irr, S.totPct);
  rt(RT.hurdle, "Target IRR (hurdle)", `=${A(AS.hurdle)}`, a.hurdle_irr_pct, S.lkPct);
  rt(RT.head, "Headroom to hurdle", `=B${RT.irr}-B${RT.hurdle}`, m.base.irr - a.hurdle_irr_pct, S.fmPct);
  banner(rets, 24, "C.  SPONSOR CASH FLOW", Math.max(n + 1, 3));
  rets.txt(0, RT.yearRow, "Year", S.periodL);
  rets.num(1, RT.yearRow, 0, S.period);
  for (let k = 1; k <= n; k++) rets.num(1 + k, RT.yearRow, k, S.period);
  rets.txt(0, RT.cf, "Sponsor cash flow", S.lblB);
  rets.fml(1, RT.cf, `=-B${RT.invested}`, -m.sponsorEquity, S.fmAcct);
  for (let k = 1; k <= n; k++) {
    rets.fml(1 + k, RT.cf, k === n ? `=B${RT.proceeds}` : "=0", k === n ? m.base.sponsorProceeds : 0, S.fmAcct);
  }
  rets.txt(0, 28, "No interim distributions are modelled, so the vector is a single outflow at close and a single inflow at exit.", S.note);
  sheets.push(rets);

  /* ---------------- VALUE BRIDGE ---------------- */
  const vb = WSheet("Value Bridge", { tabColor: TAB.valuation, freeze: [1, 5], cols: [50, 16, 60] });
  titleBlock(vb, 2, "VALUE CREATION BRIDGE", unitNote + ". Entry equity to exit equity, fully attributed. The residual must be zero.");
  banner(vb, 4, "A.  ATTRIBUTION OF EQUITY VALUE", 2);
  vb.txt(0, 5, "Driver", S.colHdrL); vb.txt(1, 5, "Value", S.colHdr); vb.txt(2, 5, "Definition", S.colHdrL);
  const vbRow = (row, label, formula, value, note, st) => {
    vb.txt(0, row, label, S.lblI); vb.fml(1, row, formula, value, st || S.fmAcct);
    if (note) vb.txt(2, row, note, S.note);
  };
  vbRow(6, "Entry equity", `=${Su(SU.equity)}`, m.bridge.entryEquity, "Total equity funded at close, including fees and opening cash");
  vbRow(7, "EBITDA growth at the entry multiple", `=(${Rt(RT.ebitda)}-${A(AS.ebitda)})*${A(AS.entryX)}`, m.bridge.ebitdaGrowth, "Earnings growth held at a constant multiple");
  vbRow(8, "Multiple expansion / (compression)", `=${Rt(RT.ebitda)}*(${A(AS.exitX)}-${A(AS.entryX)})`, m.bridge.multipleEffect, "Rerating applied to exit-year EBITDA");
  vbRow(9, "Net debt paydown", `=(${Su(SU.debt)}-${Su(SU.cash)})-(${Rt(RT.debt)}-${Rt(RT.cash)})`, m.bridge.debtPaydown, "Reduction in net debt over the hold");
  vbRow(10, "Transaction, financing and exit fees", `=-(${Su(SU.txn)}+${Su(SU.fin)}+${Rt(RT.fees)})`, m.bridge.feeDrag, "Stated explicitly rather than left in a plug");
  vb.txt(0, 11, "Exit equity, built up", S.lblB);
  vb.fml(1, 11, `=SUM(B6:B10)`, m.bridge.exitEquity - m.bridge.check, S.totAcct);
  banner(vb, 13, "B.  RECONCILIATION", 2);
  vb.txt(0, 14, "Reconciliation difference (must be zero)", S.lblB);
  vb.fml(1, 14, `=${Rt(RT.equity)}-B11`, m.bridge.check, Math.abs(m.bridge.check) < 1e-6 ? S.checkOK : S.checkBad);
  vb.txt(2, 14, "Exit equity per the Returns sheet less the build-up above", S.note);
  vb.txt(0, 15, "Exit equity per the Returns sheet", S.lblI);
  vb.fml(1, 15, `=${Rt(RT.equity)}`, m.bridge.exitEquity, S.lkAcct);
  sheets.push(vb);

  /* ---------------- SENSITIVITY ---------------- */
  const nx = m.exitMults.length, ne = m.entryMults.length;
  const sn = WSheet("Sensitivity", { tabColor: TAB.valuation, freeze: [1, 5], cols: [30, 16].concat(Array(Math.max(nx, 2)).fill(13)) });
  titleBlock(sn, Math.max(nx, 2), "SENSITIVITY \u2014 ENTRY VERSUS EXIT MULTIPLE", unitNote + ". Helper blocks are live; overwrite the multiples in column A to reshape the grids.");
  banner(sn, 4, "A.  SPONSOR EQUITY AT EACH ENTRY MULTIPLE", Math.max(nx, 2));
  sn.txt(0, 5, "Entry EV/EBITDA", S.colHdrL); sn.txt(1, 5, "Sponsor equity", S.colHdr);
  const eqTop = 6;
  m.entryMults.forEach((em, i) => {
    const row = eqTop + i;
    sn.num(0, row, em, S.inX);
    sn.fml(1, row, `=(${A(AS.ebitda)}*A${row}*(1+${A(AS.txnFee)})+${Su(SU.debt)}*${A(AS.finFee)}+${Su(SU.cash)}-${Su(SU.debt)})*${Rt(RT.own)}`, m.grid[i].equityAt, S.fmAcct);
  });
  const eqBot = eqTop + ne - 1;
  const prHdr = eqBot + 2, prTop = prHdr + 1;
  banner(sn, eqBot + 1, "B.  SPONSOR PROCEEDS AT EACH EXIT MULTIPLE", Math.max(nx, 2));
  sn.txt(0, prHdr, "Exit EV/EBITDA", S.colHdrL); sn.txt(1, prHdr, "Sponsor proceeds", S.colHdr);
  m.exitMults.forEach((xm, i) => {
    const row = prTop + i;
    sn.num(0, row, xm, S.inX);
    sn.fml(1, row, `=MAX(0,${Rt(RT.ebitda)}*A${row}*(1-${A(AS.exitFee)})-${Rt(RT.debt)}+${Rt(RT.cash)})*${Rt(RT.own)}`, m.proceedsAtList[i], S.fmAcct);
  });
  const prBot = prTop + nx - 1;
  const gBan = prBot + 2, gHdr = gBan + 1, gTop = gHdr + 1;
  banner(sn, gBan, "C.  SPONSOR MOIC", Math.max(nx, 2));
  sn.txt(0, gHdr, "Entry \\ Exit multiple", S.colHdrL);
  m.exitMults.forEach((xm, j) => sn.num(1 + j, gHdr, xm, S.gridAxis));
  m.grid.forEach((rw, i) => {
    const row = gTop + i;
    sn.num(0, row, rw.entryMult, S.gridAxis);
    rw.row.forEach((cell, j) => {
      const live = Math.abs(rw.entryMult - a.entry_multiple_x) < 1e-9 && Math.abs(cell.exitMult - a.exit_ev_ebitda_x) < 1e-9;
      sn.fml(1 + j, row, `=IF($B$${eqTop + i}>0,$B$${prTop + j}/$B$${eqTop + i},0)`, cell.moic, live ? S.gridLive : S.gridCell);
    });
  });
  const gBot = gTop + ne - 1;
  const iBan = gBot + 2, iHdr = iBan + 1, iTop = iHdr + 1;
  banner(sn, iBan, "D.  SPONSOR IRR", Math.max(nx, 2));
  sn.txt(0, iHdr, "Entry \\ Exit multiple", S.colHdrL);
  m.exitMults.forEach((xm, j) => sn.num(1 + j, iHdr, xm, S.gridAxis));
  m.grid.forEach((rw, i) => {
    const row = iTop + i;
    sn.num(0, row, rw.entryMult, S.gridAxis);
    rw.row.forEach((cell, j) => {
      const mc = `${colName(1 + j)}${gTop + i}`;
      const live = Math.abs(rw.entryMult - a.entry_multiple_x) < 1e-9 && Math.abs(cell.exitMult - a.exit_ev_ebitda_x) < 1e-9;
      sn.fml(1 + j, row, `=IF(${mc}>0,${mc}^(1/${A(AS.years)})-1,-1)`, cell.irr, live ? S.gridLiveP : S.gridCellP);
    });
  });
  sn.txt(0, iTop + ne + 1, "The cream cell is the live case. Neither multiple affects the operating build, so exit debt and cash are invariant across the grid.", S.note);
  sheets.push(sn);

  /* ---------------- SCENARIOS ---------------- */
  const sc = WSheet("Scenarios", { tabColor: TAB.control, freeze: [1, 5], cols: [34, 15, 15, 15, 56] });
  titleBlock(sc, 4, "SCENARIO SUMMARY", "Engine snapshots. Set Assumptions!B" + AS.scen + " to 1, 2 or 3 to drive the live sheets to the matching case.");
  banner(sc, 4, "A.  DRIVERS AND OUTCOMES", 4);
  sc.txt(0, 5, "Metric", S.colHdrL); sc.txt(1, 5, "Downside", S.colHdr); sc.txt(2, 5, "Base", S.colHdr);
  sc.txt(3, 5, "Upside", S.colHdr); sc.txt(4, 5, "Basis", S.colHdrL);
  const minCov = (ys) => { const c = ys.map((y) => y.coverage).filter(isFinite); return c.length ? Math.min.apply(null, c) : 0; };
  const scRows = [
    ["Revenue growth (annual)", a.revenue_growth_downside_pct, a.revenue_growth_base_pct, a.revenue_growth_upside_pct, S.fmPct, "Constant annual rate"],
    ["EBITDA margin at exit", a.exit_margin_downside_pct, a.exit_margin_base_pct, a.exit_margin_upside_pct, S.fmPct, "Ramped linearly from LTM"],
    ["Exit year EBITDA", m.downside.exitEBITDA, m.base.exitEBITDA, m.upside.exitEBITDA, S.fmAcct, ""],
    ["Exit enterprise value", m.downside.exitEV, m.base.exitEV, m.upside.exitEV, S.fmAcct, ""],
    ["Exit net leverage", m.yearsDownside[n - 1].leverage, m.yearsBase[n - 1].leverage, m.yearsUpside[n - 1].leverage, S.fmX, ""],
    ["Minimum interest coverage", minCov(m.yearsDownside), minCov(m.yearsBase), minCov(m.yearsUpside), S.fmX, "Covenant test proxy"],
    ["Exit equity value", m.downside.exitEquityValue, m.base.exitEquityValue, m.upside.exitEquityValue, S.fmAcct, ""],
    ["Sponsor MOIC", m.downside.moic, m.base.moic, m.upside.moic, S.totX, ""],
    ["Sponsor IRR", m.downside.irr, m.base.irr, m.upside.irr, S.totPct, ""],
  ];
  scRows.forEach((row, i) => {
    const rr = 6 + i;
    sc.txt(0, rr, row[0], i >= 7 ? S.lblB : S.lblI);
    sc.num(1, rr, row[1], row[4]); sc.num(2, rr, row[2], row[4]); sc.num(3, rr, row[3], row[4]);
    if (row[5]) sc.txt(4, rr, row[5], S.note);
  });
  sc.txt(0, 16, "Cash shortfall in any year", S.lblI);
  [m.yearsDownside, m.yearsBase, m.yearsUpside].forEach((ys, i) => {
    const bad = ys.some((y) => y.shortfall);
    sc.txt(1 + i, 16, bad ? "YES" : "No", bad ? S.sevHigh : S.sevLow);
  });
  sc.txt(0, 18, "The engine evaluates all three cases simultaneously. The live sheets follow whichever case the scenario switch selects.", S.note);
  sheets.push(sc);

  /* ---------------- EXIT STRATEGY ---------------- */
  const ex = WSheet("Exit Strategy", { tabColor: TAB.valuation, freeze: [1, 5], cols: [22, 14, 16, 16, 18, 11, 11] });
  titleBlock(ex, 6, "EXIT ROUTE COMPARISON", unitNote + ". Each route is modelled as a full exit at the end of the hold period.");
  banner(ex, 4, "A.  ROUTES", 6);
  ["Route", "Exit multiple", "Exit EV", "Exit equity", "Sponsor proceeds", "MOIC", "IRR"].forEach((h, i) =>
    ex.txt(i, 5, h, i === 0 ? S.colHdrL : S.colHdr));
  (d.routes || []).forEach((rt2, i) => {
    const row = 6 + i, rec = d.a6 && rt2.name === d.a6.recommended_route;
    ex.txt(0, row, rt2.name + (rec ? "  \u25c0 recommended" : ""), rec ? S.lblB : S.lblI);
    ex.num(1, row, rt2.mult, S.fmX); ex.num(2, row, rt2.ev, S.fmAcct); ex.num(3, row, rt2.equity, S.fmAcct);
    ex.num(4, row, rt2.proceeds, S.fmAcct); ex.num(5, row, rt2.moic, S.fmX); ex.num(6, row, rt2.irr, S.fmPct);
  });
  banner(ex, 10, "B.  COMMENTARY", 6);
  ex.txt(0, 11, "Recommended route", S.lblB); ex.txt(1, 11, d.a6 ? d.a6.recommended_route : "\u2014", S.lbl);
  ex.txt(0, 12, "Rationale", S.lblB);
  ex.txt(1, 12, d.a6 ? d.a6.rationale : "", S.body).merge(1, 12, 6, 12); ex.height(12, 30);
  ex.txt(0, 14, "An IPO would in practice be a staged sell-down, so the IPO line overstates day-one liquidity.", S.note);
  sheets.push(ex);

  /* ---------------- RISKS ---------------- */
  const rk = WSheet("Risks", { tabColor: TAB.schedule, freeze: [1, 5], cols: [14, 96] });
  titleBlock(rk, 1, "KEY RISKS AND MODEL WARNINGS", "Deal-specific risks identified against the computed base case.");
  banner(rk, 4, "A.  KEY RISKS", 1);
  rk.txt(0, 5, "Severity", S.colHdr); rk.txt(1, 5, "Risk", S.colHdrL);
  const risks = (d.a5 && d.a5.key_risks) || [];
  risks.forEach((x, i) => {
    rk.txt(0, 6 + i, x.severity, x.severity === "High" ? S.sevHigh : x.severity === "Medium" ? S.sevMed : S.sevLow);
    rk.txt(1, 6 + i, x.risk, S.lbl);
  });
  let rr = 6 + risks.length + 1;
  banner(rk, rr, "B.  DOWNSIDE COMMENTARY", 1); rr++;
  rk.txt(0, rr, d.a5 ? d.a5.downside_commentary : "", S.body).merge(0, rr, 1, rr); rk.height(rr, 30);
  rr += 2;
  banner(rk, rr, "C.  WARNINGS RAISED BY THE MODEL ENGINE", 1); rr++;
  const ws2 = m.warnings.length ? m.warnings : ["None raised on this run."];
  ws2.forEach((w, i) => {
    rk.txt(0, rr + i, w, m.warnings.length ? S.warnTxt : S.note);
    rk.merge(0, rr + i, 1, rr + i); rk.height(rr + i, 28);
  });
  sheets.push(rk);

  /* ---------------- SOURCE REGISTER ---------------- */
  const sr = WSheet("Source Register", { tabColor: TAB.support, freeze: [1, 5], cols: [26, 30, 22, 62, 46] });
  titleBlock(sr, 4, "SOURCE REGISTER", "Provenance for every input. Reported financials trace to a primary filing; assumptions are analyst judgement anchored on disclosed evidence.");
  banner(sr, 4, "A.  PRIMARY FILING RELIED UPON", 4);
  sr.txt(0, 5, "Attribute", S.colHdrL); sr.txt(1, 5, "Detail", S.colHdrL);
  const filingRows = [
    ["Issuer", r.company_name],
    ["Ticker", r.ticker],
    ["Listing venue", r.exchange],
    ["Reporting currency", cur + ", figures in millions"],
    ["Fiscal year end", r.fiscal_year_end],
    ["Document", r.filing_type],
    ["Period covered", r.filing_period],
    ["Direct link", r.filing_url || "Not returned by the research step \u2014 locate the filing on the exchange or regulator site before relying on these figures."],
    ["Retrieval note", r.source_note],
    ["EBITDA basis", r.ebitda_basis],
  ];
  filingRows.forEach((row, i) => {
    sr.txt(0, 6 + i, row[0], S.lblI);
    sr.txt(1, 6 + i, row[1], S.body);
    sr.merge(1, 6 + i, 4, 6 + i);
  });
  let srr = 6 + filingRows.length + 1;
  banner(sr, srr, "B.  DATA GAPS FLAGGED BY THE RESEARCH STEP", 4); srr++;
  const gaps = r.data_gaps && r.data_gaps.trim()
    ? r.data_gaps
    : "None flagged. Every reported figure above was traced to the primary filing named in section A.";
  sr.txt(0, srr, gaps, r.data_gaps && r.data_gaps.trim() ? S.warnTxt : S.note);
  sr.merge(0, srr, 4, srr); sr.height(srr, 30);
  srr += 2;
  banner(sr, srr, "C.  ASSUMPTION PROVENANCE", 4); srr++;
  ["Agent", "Assumption set", "Nature", "Evidence cited", "Rationale"].forEach((h, i) =>
    sr.txt(i, srr, h, i === 0 ? S.colHdrL : S.colHdrL));
  srr++;
  const provRows = [
    ["Research", "Reported financials", "Primary filing", r.filing_type + (r.filing_period && r.filing_period !== "\u2014" ? ", " + r.filing_period : ""), r.source_note],
    ["01 LBO Builder", "Entry multiple and fees", "Analyst judgement", d.a1 ? d.a1.evidence : "", d.a1 ? d.a1.rationale : ""],
    ["02 Debt Optimizer", "Capital structure and pricing", "Analyst judgement", d.a2 ? d.a2.evidence : "", d.a2 ? d.a2.rationale : ""],
    ["03 Valuation Engine", "Exit multiple and hold period", "Analyst judgement", d.a3 ? d.a3.evidence : "", d.a3 ? d.a3.rationale : ""],
    ["04 Cash Flow Forecaster", "Operating cases", "Analyst judgement", d.a4 ? d.a4.evidence : "", d.a4 ? d.a4.rationale : ""],
    ["06 Exit Strategist", "Exit route pricing", "Analyst judgement", d.a6 ? d.a6.evidence : "", d.a6 ? d.a6.rationale : ""],
  ];
  provRows.forEach((row, i) => {
    const rw = srr + i;
    sr.txt(0, rw, row[0], i === 0 ? S.lblB : S.lblI);
    sr.txt(1, rw, row[1], S.lbl);
    sr.txt(2, rw, row[2], i === 0 ? S.periodL : S.tag);
    sr.txt(3, rw, row[3], S.noteWrap);
    sr.txt(4, rw, row[4], S.noteWrap);
    sr.height(rw, 30);
  });
  srr += provRows.length + 1;
  banner(sr, srr, "D.  WHERE TO VERIFY BY JURISDICTION", 4); srr++;
  sr.txt(0, srr, "Jurisdiction", S.colHdrL); sr.txt(1, srr, "Primary regulator or exchange", S.colHdrL);
  sr.txt(2, srr, "Documents to check", S.colHdrL); sr.merge(2, srr, 4, srr);
  srr++;
  FILING_SOURCES.forEach((f, i) => {
    sr.txt(0, srr + i, f[0], S.lblI);
    sr.txt(1, srr + i, f[1], S.lbl);
    sr.txt(2, srr + i, f[2], S.note);
    sr.merge(2, srr + i, 4, srr + i);
  });
  srr += FILING_SOURCES.length + 1;
  sr.txt(0, srr, "Vendor and aggregator figures were not used. Any assumption above marked analyst judgement is an estimate and must be re-underwritten before it informs a decision.", S.note);
  sr.merge(0, srr, 4, srr);
  sheets.push(sr);

  /* ---------------- CONVENTIONS ---------------- */
  const cv = WSheet("Conventions", { tabColor: TAB.support, freeze: [0, 5], cols: [6, 110] });
  titleBlock(cv, 1, "MODEL CONVENTIONS, CELL DISCIPLINE AND LIMITATIONS", "Read before relying on any figure in this workbook.");
  banner(cv, 4, "A.  CELL DISCIPLINE", 1);
  const disc = [
    "Blue text marks a hardcoded input. Every one of them lives on the Assumptions sheet; no other sheet contains a typed operating number.",
    "Green text marks a link to another sheet in this workbook. Black text marks a formula calculated within its own sheet.",
    "The Type column on the Assumptions sheet tags each row INPUT or FORMULA, so the convention survives even in a monochrome print.",
    "Cream fill marks a control cell that drives the whole model. Green fill marks a period header or an audit check that must hold.",
    "Every formula cell also carries the value computed by the model engine, so the file opens with numbers and recalculates on any edit. If a formula and the engine ever disagreed, the figure would move on recalculation.",
    "Snapshot sheets (Scenarios, Exit Strategy, Risks) hold engine outputs rather than live formulas, and say so.",
  ];
  disc.forEach((s, i) => { cv.txt(0, 5 + i, String(i + 1).padStart(2, "0"), S.tag); cv.txt(1, 5 + i, s, S.noteWrap); cv.height(5 + i, 26); });
  let cr = 5 + disc.length + 1;
  banner(cv, cr, "B.  MODELLING CONVENTIONS", 1); cr++;
  CONVENTIONS.forEach((s, i) => { cv.txt(0, cr + i, String(i + 1).padStart(2, "0"), S.tag); cv.txt(1, cr + i, s, S.noteWrap); cv.height(cr + i, 26); });
  cr += CONVENTIONS.length + 1;
  banner(cv, cr, "C.  SOURCING", 1); cr++;
  cv.txt(0, cr, "01", S.tag);
  cv.txt(1, cr, "Reported financials: " + r.filing_type + (r.filing_period && r.filing_period !== "\u2014" ? ", " + r.filing_period : "") + ". Full provenance, direct link and data gaps are on the Source Register sheet.", S.noteWrap);
  cv.height(cr, 26);
  cv.txt(0, cr + 1, "02", S.tag);
  cv.txt(1, cr + 1, "Structuring, credit, operating and exit assumptions are analyst judgement anchored on disclosed evidence rather than figures lifted from a filing. Each carries its cited evidence on the Source Register. Re-underwrite every one before relying on this analysis.", S.noteWrap);
  cv.height(cr + 1, 26);
  cv.txt(0, cr + 2, "03", S.tag);
  cv.txt(1, cr + 2, "Assumption mode used: " + (d.mode === "custom" ? "analyst-specified criteria" : "standard agent logic") + ". Generated " + new Date().toISOString().slice(0, 10) + ".", S.noteWrap);
  sheets.push(cv);

  return writeXlsx(sheets, SB);
}

/* ------------------------------------------------------------------ *
 * UI PRIMITIVES
 * ------------------------------------------------------------------ */
function Eyebrow({ children, color }) {
  return <div style={{ ...mono, fontSize: 10, letterSpacing: 1.6, color: color || MUTED, textTransform: "uppercase" }}>{children}</div>;
}
function Panel({ children, style }) {
  return <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 10, padding: 16, ...(style || {}) }}>{children}</div>;
}
function Stat({ label, value, color, sub }) {
  return (
    <Panel>
      <Eyebrow>{label}</Eyebrow>
      <div style={{ fontSize: 26, fontWeight: 700, color: color || TEXT, marginTop: 8, ...mono }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: FAINT, marginTop: 4 }}>{sub}</div>}
    </Panel>
  );
}
function Row({ label, value, bold, color, top }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "7px 0", borderTop: top ? `1px solid ${LINE}` : "none" }}>
      <span style={{ fontSize: 12.5, color: bold ? TEXT : MUTED, fontWeight: bold ? 700 : 400 }}>{label}</span>
      <span style={{ fontSize: 12.5, ...mono, fontWeight: bold ? 700 : 400, color: color || TEXT, whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}
function Field({ label, value, onChange, kind, hint, step }) {
  const toDisplay = (v) => (kind === "pct" ? Math.round(v * 10000) / 100 : v);
  const fromDisplay = (v) => (kind === "pct" ? v / 100 : v);
  const [draft, setDraft] = useState(String(toDisplay(value)));
  const [focused, setFocused] = useState(false);
  if (!focused && String(toDisplay(value)) !== draft) setDraft(String(toDisplay(value)));
  const suffix = kind === "pct" ? "%" : kind === "x" ? "x" : kind === "mm" ? "mm" : "";
  return (
    <label style={{ display: "block" }}>
      <div style={{ fontSize: 11.5, color: MUTED, marginBottom: 5, lineHeight: 1.3 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", background: INK, border: `1px solid ${LINE}`, borderRadius: 7 }}>
        <input
          type="number"
          step={step || (kind === "pct" ? 0.5 : kind === "x" ? 0.25 : 1)}
          value={draft}
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); const nn = parseFloat(draft); if (isFinite(nn)) onChange(fromDisplay(nn)); else setDraft(String(toDisplay(value))); }}
          onChange={(e) => { setDraft(e.target.value); const nn = parseFloat(e.target.value); if (isFinite(nn)) onChange(fromDisplay(nn)); }}
          style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: TEXT, ...mono, fontSize: 13, padding: "9px 10px" }}
        />
        {suffix && <span style={{ ...mono, fontSize: 11, color: FAINT, paddingRight: 10 }}>{suffix}</span>}
      </div>
      {hint && <div style={{ fontSize: 10.5, color: FAINT, marginTop: 4 }}>{hint}</div>}
    </label>
  );
}
function FieldGroup({ title, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <Eyebrow color={AMBER}>{title}</Eyebrow>
        <div style={{ flex: 1, height: 1, background: LINE }} />
      </div>
      <div className="fieldgrid">{children}</div>
    </div>
  );
}
const ghostBtn = {
  display: "flex", alignItems: "center", gap: 7, background: "transparent",
  border: `1px solid ${LINE}`, color: MUTED, borderRadius: 8,
  padding: "9px 14px", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
};

function Provenance({ research, agents }) {
  const gaps = research.data_gaps && research.data_gaps.trim();
  const rows = [
    ["01 LBO Builder", "Entry multiple and fees", agents.a1 && agents.a1.evidence],
    ["02 Debt Optimizer", "Capital structure", agents.a2 && agents.a2.evidence],
    ["03 Valuation Engine", "Exit multiple", agents.a3 && agents.a3.evidence],
    ["04 Cash Flow Forecaster", "Operating cases", agents.a4 && agents.a4.evidence],
    ["06 Exit Strategist", "Exit route pricing", agents.a6 && agents.a6.evidence],
  ].filter((r) => r[2]);
  return (
    <Panel style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <Eyebrow color={TEAL}>Sourcing and provenance</Eyebrow>
        <span style={{ ...mono, fontSize: 10, color: FAINT }}>PRIMARY FILING · NO VENDOR DATA</span>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 12, paddingBottom: 12, borderBottom: `1px solid ${LINE}` }}>
        <FileText size={15} color={TEAL} style={{ flexShrink: 0, marginTop: 2 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {research.filing_type}{research.filing_period && research.filing_period !== "\u2014" ? " \u00b7 " + research.filing_period : ""}
          </div>
          <div style={{ fontSize: 11.5, color: MUTED, marginTop: 3, lineHeight: 1.5 }}>
            {research.exchange !== "—" ? research.exchange + " · " : ""}{research.currency} · {research.source_note}
          </div>
          {research.ebitda_basis && (
            <div style={{ fontSize: 11.5, color: FAINT, marginTop: 4, lineHeight: 1.5 }}>EBITDA basis: {research.ebitda_basis}</div>
          )}
          {research.filing_url && (
            <a href={research.filing_url} target="_blank" rel="noopener noreferrer"
              style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 7, color: TEAL, fontSize: 11.5, textDecoration: "none", wordBreak: "break-all" }}>
              <ExternalLink size={12} /> Open the filing
            </a>
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "12px 0", borderBottom: rows.length ? `1px solid ${LINE}` : "none" }}>
        {gaps ? <AlertTriangle size={15} color={GOLD} style={{ flexShrink: 0, marginTop: 2 }} />
              : <BadgeCheck size={15} color={GREEN} style={{ flexShrink: 0, marginTop: 2 }} />}
        <div style={{ fontSize: 12, color: gaps ? TEXT : MUTED, lineHeight: 1.5 }}>
          {gaps ? "Data gaps: " + research.data_gaps
                : "No data gaps flagged. Every reported figure traces to the filing above."}
        </div>
      </div>
      {rows.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{ fontSize: 11, color: FAINT, margin: "10px 0 4px" }}>Evidence cited for analyst judgement:</div>
          {rows.map((r, i) => (
            <div key={r[0]} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "6px 0", borderTop: i ? `1px solid ${LINE}` : "none" }}>
              <span style={{ ...mono, fontSize: 9.5, color: AMBER, flexShrink: 0, marginTop: 2, width: 22 }}>{r[0].slice(0, 2)}</span>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 12, color: MUTED }}>{r[1]}: </span>
                <span style={{ fontSize: 12 }}>{r[2]}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function ApiKeyPanel({ hasKey, onSave, onClose }) {
  const [draft, setDraft] = useState("");
  const [revealed, setRevealed] = useState(false);
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 50,
      display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "14vh 16px 16px",
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 20, width: "100%", maxWidth: 420,
      }}>
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
          The AI research and structuring agents call the Anthropic API straight from this device, so they need your own key.
          Stored only in this app's local storage, never sent anywhere but api.anthropic.com. Get one at{" "}
          <span style={{ color: TEAL }}>console.anthropic.com</span>. No key at all is fine too — use Manual entry mode instead.
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
                <button onClick={() => { onSave(""); setDraft(""); setRevealed(false); }} style={ghostBtn}>
                  Remove key
                </button>
              )}
              <button
                onClick={() => { if (draft.trim()) { onSave(draft.trim()); setDraft(""); setRevealed(false); onClose(); } }}
                disabled={!draft.trim()}
                style={{
                  background: draft.trim() ? AMBER : PANEL2, color: draft.trim() ? "#180D03" : MUTED, border: "none",
                  borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 700, cursor: draft.trim() ? "pointer" : "default",
                }}>
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
 * MAIN
 * ------------------------------------------------------------------ */
export default function LBOModelWithClaude() {
  const [company, setCompany] = useState("");
  const [mode, setMode] = useState("standard");
  const [phase, setPhase] = useState("idle");
  const [status, setStatus] = useState({});
  const [log, setLog] = useState({});
  const [error, setError] = useState(null);
  const [research, setResearch] = useState(null);
  const [agents, setAgents] = useState({});
  const [assumptions, setAssumptions] = useState(null);
  const [model, setModel] = useState(null);
  const [routes, setRoutes] = useState(null);
  const [sensMode, setSensMode] = useState("moic");
  const [showAdjust, setShowAdjust] = useState(false);
  const [showConventions, setShowConventions] = useState(false);
  const [fileUrl, setFileUrl] = useState(null);
  const [buildNote, setBuildNote] = useState(null);
  const [hasKey, setHasKey] = useState(false);
  const [showKeyPanel, setShowKeyPanel] = useState(false);
  const proposalRef = useRef(null);

  useEffect(() => {
    setHasKey(!!loadApiKey());
  }, []);

  const running = phase === "running";
  const sym = research ? currencySymbol(research.currency) : "$";

  function setStat(k, s) { setStatus((p) => Object.assign({}, p, { [k]: s })); }
  function setLogLine(k, s) { setLog((p) => Object.assign({}, p, { [k]: s })); }
  function assemble(r, a1, a2, a3, a4) { return Object.assign({}, r, a1, a2, a3, a4, { hurdle_irr_pct: 0.2 }); }

  function blankResearch(name) {
    return normResearch({
      company_name: name, ticker: "—", exchange: "—", sector: "—", currency: "USD",
      fiscal_year_end: "—", filing_type: "Manual entry", filing_period: "—",
      source_note: "All figures entered manually by the user, not sourced from a filing.",
      ebitda_basis: "Entered manually.",
    });
  }

  function startManual() {
    if (!company.trim() || running) return;
    setError(null); setBuildNote(null); setFileUrl(null); setShowAdjust(false);
    setAgents({}); setModel(null); setRoutes(null); setStatus({}); setLog({});
    const r = blankResearch(company.trim());
    const proposed = Object.assign({}, r, houseDefaults(r), { hurdle_irr_pct: 0.2 });
    proposalRef.current = proposed;
    setResearch(r);
    setAssumptions(proposed);
    setPhase("review");
  }

  function recompute(next, routeAssumptions) {
    const m = computeModel(next);
    setModel(m);
    const ra = routeAssumptions || agents.a6 || null;
    setRoutes(ra ? computeRoutes(m, next, ra) : null);
    return m;
  }

  async function run() {
    if (!company.trim() || running) return;
    if (!hasKey) {
      setError("Add your Anthropic API key (key icon, top right) to run AI research, or switch to Manual entry to build the model yourself with no key.");
      return;
    }
    setPhase("running"); setError(null); setBuildNote(null);
    setResearch(null); setAgents({}); setModel(null); setRoutes(null); setAssumptions(null);
    setFileUrl(null); setShowAdjust(false);
    const init = {}; PIPELINE.forEach((p) => (init[p.key] = "pending"));
    setStatus(init); setLog({});
    let key = null;
    try {
      key = "research"; setStat(key, "running");
      const r = normResearch(await callClaude(SYSTEM.research, `Research this company for a potential leveraged buyout: ${company}`, { useWebSearch: true, maxTokens: 2000 }));
      if (!(r.ltm_revenue_mm > 0) || !(r.ltm_ebitda_mm > 0)) {
        throw new Error(`Research returned revenue of ${r.ltm_revenue_mm} and EBITDA of ${r.ltm_ebitda_mm}. An LBO needs positive LTM EBITDA. Check the name, or pick a profitable target.`);
      }
      setResearch(r); setStat(key, "done");
      setLogLine(key, `${r.filing_type !== "\u2014" ? r.filing_type : "Filing"} \u00b7 EBITDA ${currencySymbol(r.currency)}${Math.round(r.ltm_ebitda_mm).toLocaleString()}mm`);

      key = "a1"; setStat(key, "running");
      const a1 = normA1(await callClaude(SYSTEM.a1, JSON.stringify(r)));
      setAgents((p) => Object.assign({}, p, { a1 })); setStat(key, "done");
      setLogLine(key, `Entry ${a1.entry_multiple_x.toFixed(1)}x`);

      key = "a2"; setStat(key, "running");
      const a2 = normA2(await callClaude(SYSTEM.a2, JSON.stringify(Object.assign({}, r, a1))));
      setAgents((p) => Object.assign({}, p, { a2 })); setStat(key, "done");
      setLogLine(key, `${(a2.term_loan_leverage_x + a2.senior_notes_leverage_x).toFixed(1)}x leverage`);

      key = "a3"; setStat(key, "running");
      const a3 = normA3(await callClaude(SYSTEM.a3, JSON.stringify(Object.assign({}, r, a1))));
      setAgents((p) => Object.assign({}, p, { a3 })); setStat(key, "done");
      setLogLine(key, `Exit ${a3.exit_ev_ebitda_x.toFixed(1)}x, Y${a3.exit_year}`);

      key = "a4"; setStat(key, "running");
      const a4 = normA4(await callClaude(SYSTEM.a4, JSON.stringify(r)));
      setAgents((p) => Object.assign({}, p, { a4 })); setStat(key, "done");
      setLogLine(key, `${fmtPct(a4.revenue_growth_base_pct)} growth`);

      const proposed = assemble(r, a1, a2, a3, a4);
      proposalRef.current = proposed;
      setAssumptions(proposed);
      if (mode === "custom") { setPhase("review"); return; }
      await finish(proposed, r);
    } catch (e) {
      if (key) setStat(key, "error");
      setError((e && e.message) || String(e));
      setPhase("idle");
    }
  }

  async function finish(next, r) {
    let key = null;
    let builtModel = null;
    try {
      setPhase("running");
      key = "compute1"; setStat(key, "running");
      const m = computeModel(next);
      builtModel = m;
      setModel(m); setAssumptions(next); setStat(key, "done");
      setLogLine(key, `${fmtX(m.base.moic)} MOIC \u00b7 ${fmtPct(m.base.irr)} IRR`);

      if (!currentApiKey) {
        const a5 = normA5({});
        const a6 = normA6({});
        setAgents((p) => Object.assign({}, p, { a5, a6 }));
        setRoutes(computeRoutes(m, next, a6));
        setBuildNote("Built with no API key: risk analysis and exit-route commentary were skipped. Add a key to have Claude fill those in.");
        setPhase("built");
        return;
      }

      key = "a5"; setStat(key, "running");
      const a5 = normA5(await callClaude(SYSTEM.a5, JSON.stringify({
        company: r.company_name, sector: r.sector, base_irr: m.base.irr, base_moic: m.base.moic,
        entry_leverage_x: m.entryLeverage, exit_leverage_x: m.yearsBase[m.yearsBase.length - 1].leverage,
      })));
      setAgents((p) => Object.assign({}, p, { a5 })); setStat(key, "done");
      setLogLine(key, `${a5.key_risks.length} risks`);

      key = "a6"; setStat(key, "running");
      const a6 = normA6(await callClaude(SYSTEM.a6, JSON.stringify({
        company: r.company_name, sector: r.sector, exit_multiple_x: next.exit_ev_ebitda_x,
        exit_ebitda_mm: m.base.exitEBITDA, base_irr: m.base.irr,
      })));
      setAgents((p) => Object.assign({}, p, { a6 })); setStat(key, "done");
      setLogLine(key, a6.recommended_route);

      key = "compute2"; setStat(key, "running");
      setRoutes(computeRoutes(m, next, a6)); setStat(key, "done");
      setLogLine(key, "3 routes");
      setPhase("built");
    } catch (e) {
      if (key) setStat(key, "error");
      setError((e && e.message) || String(e));
      setPhase(builtModel ? "built" : "idle");
    }
  }

  function editResearch(patch) {
    setResearch((r) => Object.assign({}, r, patch));
  }

  function edit(patch) {
    const next = Object.assign({}, assumptions, patch);
    setAssumptions(next);
    if (phase === "built") recompute(next);
  }

  function fileName() {
    return (research ? research.company_name.replace(/[^a-z0-9]+/gi, "_") : "LBO") + "_-_LBO_Model.xlsx";
  }
  function exportWorkbook() {
    if (!model || !assumptions || !research) return;
    try {
      const bytes = buildWorkbook({
        assumptions, model, research, routes,
        a1: agents.a1, a2: agents.a2, a3: agents.a3, a4: agents.a4, a5: agents.a5, a6: agents.a6, mode,
      });
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      setFileUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return url; });
      const link = document.createElement("a");
      link.href = url; link.download = fileName(); link.rel = "noopener";
      document.body.appendChild(link); link.click(); document.body.removeChild(link);
      setBuildNote("Workbook built with 12 formatted sheets. If nothing landed in your downloads folder, use the Save workbook link.");
    } catch (e) {
      setError("The workbook could not be built: " + ((e && e.message) || String(e)));
    }
  }

  const waterfall = useMemo(() => {
    if (!model) return [];
    const b = model.bridge;
    const steps = [
      { name: "Entry equity", raw: b.entryEquity, total: true },
      { name: "EBITDA growth", raw: b.ebitdaGrowth },
      { name: "Multiple", raw: b.multipleEffect },
      { name: "Debt paydown", raw: b.debtPaydown },
      { name: "Fees", raw: b.feeDrag },
      { name: "Exit equity", raw: b.exitEquity, total: true },
    ];
    let cum = 0;
    return steps.map((s, i) => {
      if (s.total) { if (i === 0) cum = s.raw; return { name: s.name, base: 0, delta: s.raw, raw: s.raw, total: true }; }
      const base = s.raw >= 0 ? cum : cum + s.raw;
      const out = { name: s.name, base, delta: Math.abs(s.raw), raw: s.raw, total: false };
      cum += s.raw;
      return out;
    });
  }, [model]);

  const creditData = useMemo(() => (model ? model.yearsBase.map((y) => ({
    label: y.label, leverage: y.leverage, coverage: isFinite(y.coverage) ? y.coverage : null,
  })) : []), [model]);

  const opData = useMemo(() => {
    if (!model || !research) return [];
    return [{ label: "LTM", revenue: research.ltm_revenue_mm, ebitda: research.ltm_ebitda_mm }]
      .concat(model.yearsBase.map((y) => ({ label: y.label, revenue: y.revenue, ebitda: y.ebitda })));
  }, [model, research]);

  const verdictColor = model ? (model.verdict.tone === "good" ? GREEN : model.verdict.tone === "warn" ? GOLD : RED) : MUTED;

  return (
    <div style={{ background: INK, minHeight: "100vh", color: TEXT, fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif" }}>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "36px 22px 90px" }}>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginBottom: 22 }}>
          <div>
            <Eyebrow color={AMBER}>Leveraged buyout desk</Eyebrow>
            <h1 className="hero" style={{ ...serif, fontWeight: 700, margin: "8px 0 6px", lineHeight: 1.05, letterSpacing: -0.5 }}>
              LBO Model <span style={{ color: AMBER, fontStyle: "italic" }}>with Claude</span>
            </h1>
            <p style={{ color: MUTED, fontSize: 14.5, maxWidth: 580, margin: 0, lineHeight: 1.55 }}>
              Six analysts, thirty years apiece, working the target's own regulatory filings. Structure the buyout, stress the credit, and export a formula-driven workbook in house format with every figure traced to its source.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ border: `1px solid ${LINE}`, borderRadius: 20, padding: "6px 13px", ...mono, fontSize: 10, letterSpacing: 1, color: MUTED, whiteSpace: "nowrap" }}>
              {"\u25cf LIVE \u00b7 MULTI-AGENT"}
            </div>
            <button onClick={() => setShowKeyPanel(true)} title="Anthropic API key" style={{
              display: "flex", alignItems: "center", gap: 6, background: hasKey ? AMBER_DIM : PANEL,
              border: `1px solid ${hasKey ? AMBER : LINE}`, borderRadius: 20, padding: "6px 12px",
              color: hasKey ? AMBER : MUTED, fontSize: 11, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
            }}>
              <KeyRound size={13} /> {hasKey ? "Key set" : "Add key"}
            </button>
          </div>
        </div>

        {showKeyPanel && (
          <ApiKeyPanel
            hasKey={hasKey}
            onSave={(k) => { saveApiKey(k); setHasKey(!!k); }}
            onClose={() => setShowKeyPanel(false)}
          />
        )}

        {(phase === "idle" || phase === "running") && (
          <>
            <div className="modegrid" style={{ marginBottom: 16 }}>
              {[
                { id: "standard", title: "Standard logic", body: "The six analysts pull the filings and set every assumption themselves. Fastest route to a first read on the deal.", Icon: Zap },
                { id: "custom", title: "My own criteria", body: "The analysts pull the filings and propose, then hand you the assumption sheet. Nothing is computed until you approve or overwrite it.", Icon: Sliders },
                { id: "manual", title: "Manual entry", body: "Skip the AI agents entirely. Type in the target's financials and every assumption yourself. No API key needed.", Icon: PencilLine },
              ].map((opt) => {
                const on = mode === opt.id;
                return (
                  <button key={opt.id} onClick={() => !running && setMode(opt.id)} disabled={running}
                    style={{
                      textAlign: "left", background: on ? AMBER_DIM : PANEL, border: `1px solid ${on ? AMBER : LINE}`,
                      borderRadius: 10, padding: 16, cursor: running ? "default" : "pointer", color: TEXT, transition: "all .18s",
                    }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 7 }}>
                      <opt.Icon size={15} color={on ? AMBER : MUTED} />
                      <span style={{ fontSize: 14, fontWeight: 700 }}>{opt.title}</span>
                      {on && <Check size={14} color={AMBER} style={{ marginLeft: "auto" }} />}
                    </div>
                    <div style={{ fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>{opt.body}</div>
                  </button>
                );
              })}
            </div>

            <div style={{ display: "flex", gap: 10, marginBottom: 30, flexWrap: "wrap" }}>
              <input
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (mode === "manual" ? startManual() : run())}
                placeholder={mode === "manual" ? "Company name, e.g. Bharti Airtel" : "Company name or ticker, e.g. Bharti Airtel"}
                disabled={running}
                style={{ flex: 1, minWidth: 230, background: PANEL, border: `1px solid ${LINE}`, borderRadius: 8, padding: "13px 15px", color: TEXT, fontSize: 14, outline: "none" }}
              />
              <button onClick={() => (mode === "manual" ? startManual() : run())} disabled={running || !company.trim()}
                style={{
                  display: "flex", alignItems: "center", gap: 8, background: running || !company.trim() ? PANEL2 : AMBER,
                  color: running || !company.trim() ? MUTED : "#180D03", border: "none", borderRadius: 8,
                  padding: "13px 22px", fontSize: 14, fontWeight: 700, cursor: running || !company.trim() ? "default" : "pointer",
                }}>
                {running ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
                {running ? "Working\u2026" : mode === "custom" ? "Research & propose" : mode === "manual" ? "Set up the model" : "Run analysis"}
              </button>
            </div>
          </>
        )}

        {error && (
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start", background: "rgba(242,100,90,0.08)", border: `1px solid ${RED}`, borderRadius: 8, padding: 14, marginBottom: 24 }}>
            <AlertCircle size={17} color={RED} style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>{error}</div>
          </div>
        )}

        {Object.keys(status).length > 0 && phase !== "built" && (
          <div style={{ marginBottom: 30 }}>
            <Eyebrow color={FAINT}>Agent pipeline</Eyebrow>
            <div className="pipegrid" style={{ marginTop: 11 }}>
              {PIPELINE.map((p) => {
                const s = status[p.key] || "pending";
                return (
                  <div key={p.key} style={{
                    background: s === "running" ? AMBER_DIM : PANEL, border: `1px solid ${s === "running" ? AMBER : LINE}`,
                    borderRadius: 8, padding: 11, opacity: s === "pending" ? 0.42 : 1, transition: "all .3s",
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                      <span style={{ ...mono, fontSize: 10, color: p.local ? TEAL : AMBER }}>{p.code}</span>
                      {s === "done" && <CheckCircle2 size={13} color={GREEN} />}
                      {s === "running" && <Loader2 size={13} color={AMBER} className="spin" />}
                      {s === "pending" && <Circle size={11} color={FAINT} />}
                      {s === "error" && <AlertCircle size={13} color={RED} />}
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: MUTED, marginTop: 2 }}>{p.role}</div>
                    {log[p.key] && <div style={{ fontSize: 10, color: GREEN, ...mono, marginTop: 4 }}>{log[p.key]}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {phase === "review" && assumptions && research && (
          <Panel style={{ marginBottom: 28, borderColor: AMBER }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, flexWrap: "wrap", marginBottom: 6 }}>
              <div>
                <Eyebrow color={AMBER}>{mode === "manual" ? "Manual entry" : "Step 2 of 2 \u00b7 your criteria"}</Eyebrow>
                <div style={{ fontSize: 17, fontWeight: 700, marginTop: 6 }}>
                  {mode === "manual" ? "Enter the target's financials and every assumption" : "Review the assumptions before anything is computed"}
                </div>
                <div style={{ fontSize: 12.5, color: MUTED, marginTop: 4, maxWidth: 660, lineHeight: 1.55 }}>
                  {mode === "manual"
                    ? "Nothing has been researched or assumed for you. Fill in the target financials below, adjust the house-default structuring, credit, operating and exit assumptions, then build the model. No API key required."
                    : `Reported financials come from ${research.filing_type}${research.filing_period && research.filing_period !== "\u2014" ? ", " + research.filing_period : ""}. The structuring, credit, operating and exit assumptions below are analyst judgement. Overwrite anything you disagree with; every field becomes a blue input cell on the Assumptions sheet, with its source recorded alongside.`}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {mode !== "manual" && (
                  <button onClick={() => setAssumptions(Object.assign({}, proposalRef.current))} style={ghostBtn}>
                    <RotateCcw size={14} /> Agent proposal
                  </button>
                )}
                <button onClick={() => setAssumptions(Object.assign({}, assumptions, houseDefaults(research)))} style={ghostBtn}>
                  {mode === "manual" ? <><RotateCcw size={14} /> Reset structuring defaults</> : "House defaults"}
                </button>
              </div>
            </div>
            {mode === "manual" && (
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16, marginBottom: 4 }}>
                <label style={{ flex: "1 1 220px" }}>
                  <div style={{ fontSize: 11.5, color: MUTED, marginBottom: 5 }}>Company name</div>
                  <input
                    value={research.company_name}
                    onChange={(e) => editResearch({ company_name: e.target.value || "Unknown" })}
                    style={{ width: "100%", background: INK, border: `1px solid ${LINE}`, borderRadius: 7, padding: "9px 10px", color: TEXT, fontSize: 13, outline: "none" }}
                  />
                </label>
                <label style={{ flex: "0 1 140px" }}>
                  <div style={{ fontSize: 11.5, color: MUTED, marginBottom: 5 }}>Currency</div>
                  <select
                    value={research.currency}
                    onChange={(e) => editResearch({ currency: e.target.value })}
                    style={{ width: "100%", background: INK, border: `1px solid ${LINE}`, borderRadius: 7, padding: "9px 10px", color: TEXT, fontSize: 13, outline: "none" }}
                  >
                    {["USD", "INR", "EUR", "GBP", "JPY", "CNY", "AUD", "CAD"].map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
              </div>
            )}
            <AssumptionEditor a={assumptions} sym={sym} onEdit={edit} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 6 }}>
              <button onClick={() => finish(assumptions, research)} style={{
                display: "flex", alignItems: "center", gap: 8, background: AMBER, color: "#180D03",
                border: "none", borderRadius: 8, padding: "12px 22px", fontSize: 14, fontWeight: 700, cursor: "pointer",
              }}>
                Build the model <ArrowRight size={15} />
              </button>
            </div>
          </Panel>
        )}

        {phase === "built" && model && research && assumptions && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 14, flexWrap: "wrap", marginBottom: 14, paddingBottom: 14, borderBottom: `1px solid ${LINE}` }}>
              <div>
                <Eyebrow color={FAINT}>Executive dashboard</Eyebrow>
                <div style={{ fontSize: 22, fontWeight: 700, marginTop: 6 }}>
                  {research.company_name} <span style={{ color: MUTED, fontWeight: 400 }}>({research.ticker})</span>
                </div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 3 }}>
                  {research.sector} · {assumptions.exit_year}-year hold · {research.currency} figures in millions · {mode === "custom" ? "analyst criteria" : "standard agent logic"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => setShowAdjust((v) => !v)} style={ghostBtn}>
                  <Sliders size={14} /> {showAdjust ? "Hide assumptions" : "Adjust assumptions"}
                </button>
                <button onClick={exportWorkbook} style={{
                  display: "flex", alignItems: "center", gap: 8, background: AMBER, color: "#180D03",
                  border: "none", borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer",
                }}>
                  <FileSpreadsheet size={15} /> Build workbook
                </button>
                {fileUrl && (
                  <a href={fileUrl} download={fileName()} target="_blank" rel="noopener noreferrer" style={Object.assign({}, ghostBtn, { textDecoration: "none", borderColor: AMBER, color: AMBER })}>
                    <Download size={14} /> Save workbook
                  </a>
                )}
              </div>
            </div>

            {buildNote && (
              <div style={{ fontSize: 12, color: MUTED, background: PANEL, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 13px", marginBottom: 16, lineHeight: 1.5 }}>
                {buildNote} Preview panes block downloads; opening this artifact in its own browser tab also fixes it.
              </div>
            )}

            {showAdjust && (
              <Panel style={{ marginBottom: 20, borderColor: TEAL }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
                  <div>
                    <Eyebrow color={TEAL}>Live assumptions</Eyebrow>
                    <div style={{ fontSize: 12.5, color: MUTED, marginTop: 5 }}>Every edit recalculates the whole model instantly. No agent is re-run.</div>
                  </div>
                  {proposalRef.current && (
                    <button onClick={() => { const p = Object.assign({}, proposalRef.current); setAssumptions(p); recompute(p); }} style={ghostBtn}>
                      <RotateCcw size={14} /> Reset to proposal
                    </button>
                  )}
                </div>
                <AssumptionEditor a={assumptions} sym={sym} onEdit={edit} />
              </Panel>
            )}

            {model.warnings.length > 0 && (
              <div style={{ background: "rgba(229,185,78,0.07)", border: `1px solid ${GOLD}`, borderRadius: 9, padding: 14, marginBottom: 20 }}>
                {model.warnings.map((w, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: i ? 9 : 0 }}>
                    <AlertTriangle size={15} color={GOLD} style={{ flexShrink: 0, marginTop: 2 }} />
                    <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>{w}</div>
                  </div>
                ))}
              </div>
            )}

            <div style={{
              display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
              background: `linear-gradient(90deg, ${PANEL} 0%, ${PANEL2} 100%)`,
              border: `1px solid ${verdictColor}`, borderLeft: `3px solid ${verdictColor}`,
              borderRadius: 10, padding: "16px 18px", marginBottom: 16,
            }}>
              <div style={{ flex: "1 1 220px" }}>
                <Eyebrow color={verdictColor}>{model.verdict.label}</Eyebrow>
                <div style={{ fontSize: 13, color: MUTED, marginTop: 6, lineHeight: 1.5 }}>
                  Base case returns {fmtPct(model.base.irr)} against a {fmtPct(model.hurdle, 0)} target, a headroom of {fmtPct(model.base.irr - model.hurdle)}. Downside holds at {fmtPct(model.downside.irr)}.
                </div>
              </div>
              <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
                {[["IRR", fmtPct(model.base.irr), verdictColor], ["MOIC", fmtX(model.base.moic), TEXT], ["Equity cheque", fmtM(sym, model.sponsorEquity), TEXT]].map((s) => (
                  <div key={s[0]}>
                    <Eyebrow>{s[0]}</Eyebrow>
                    <div style={{ fontSize: 25, fontWeight: 700, color: s[2], ...mono, marginTop: 5 }}>{s[1]}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="kpigrid" style={{ marginBottom: 18 }}>
              <Stat label="Entry multiple" value={fmtX1(assumptions.entry_multiple_x)} sub={`vs ${fmtX1(research.current_ev_ebitda_x)} traded`} />
              <Stat label="Exit multiple" value={fmtX1(assumptions.exit_ev_ebitda_x)} sub={assumptions.exit_ev_ebitda_x > assumptions.entry_multiple_x ? "expansion assumed" : assumptions.exit_ev_ebitda_x < assumptions.entry_multiple_x ? "compression assumed" : "flat to entry"} />
              <Stat label="Entry leverage" value={fmtX1(model.entryLeverage)} color={model.entryLeverage > 6 ? GOLD : TEXT} sub="net debt / LTM EBITDA" />
              <Stat label="Exit leverage" value={fmtX1(model.yearsBase[model.yearsBase.length - 1].leverage)} color={TEAL} sub={`${fmtX1(model.entryLeverage - model.yearsBase[model.yearsBase.length - 1].leverage)} of deleveraging`} />
              <Stat label="Premium paid" value={fmtPct(model.premiumToMarket)} sub="to market capitalisation" />
              <Stat label="Min. coverage" value={fmtX1(Math.min.apply(null, model.yearsBase.map((y) => (isFinite(y.coverage) ? y.coverage : 99))))} color={TEAL} sub="EBITDA / interest, base" />
            </div>

            <Provenance research={research} agents={agents} />

            <Panel style={{ marginBottom: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
                <Eyebrow color={AMBER}>Where the equity return comes from</Eyebrow>
                <span style={{ ...mono, fontSize: 10.5, color: model.checks[1].ok ? GREEN : RED }}>
                  RECONCILES TO {fmtM(sym, model.bridge.check, 4)}
                </span>
              </div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 12 }}>
                Entry equity of {fmtM(sym, model.bridge.entryEquity)} becomes {fmtM(sym, model.bridge.exitEquity)} at exit. Fees are stated explicitly rather than left in a plug.
              </div>
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={waterfall} margin={{ top: 6, right: 8, left: 0, bottom: 4 }}>
                  <CartesianGrid stroke={LINE} strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="name" stroke={FAINT} tick={{ fontSize: 10.5, fill: MUTED }} axisLine={{ stroke: LINE }} tickLine={false} interval={0} />
                  <YAxis stroke={FAINT} tick={{ fontSize: 10.5, fill: MUTED }} axisLine={false} tickLine={false} width={58} />
                  <Tooltip cursor={{ fill: "rgba(255,255,255,0.03)" }}
                    contentStyle={{ background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, fontSize: 12 }}
                    formatter={(v, nm, p) => [fmtM(sym, p && p.payload ? p.payload.raw : v), "Contribution"]} />
                  <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
                  <Bar dataKey="delta" stackId="w" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                    {waterfall.map((e, i) => <Cell key={i} fill={e.total ? AMBER : e.raw >= 0 ? GREEN : RED} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Panel>

            <div className="g2" style={{ marginBottom: 18 }}>
              <Panel>
                <Eyebrow>Revenue and EBITDA · base case ({sym}mm)</Eyebrow>
                <ResponsiveContainer width="100%" height={196}>
                  <LineChart data={opData} margin={{ top: 14, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={LINE} strokeDasharray="2 4" vertical={false} />
                    <XAxis dataKey="label" stroke={FAINT} tick={{ fontSize: 10.5, fill: MUTED }} axisLine={{ stroke: LINE }} tickLine={false} />
                    <YAxis stroke={FAINT} tick={{ fontSize: 10.5, fill: MUTED }} axisLine={false} tickLine={false} width={54} />
                    <Tooltip contentStyle={{ background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, fontSize: 12 }} formatter={(v) => fmtM(sym, v)} />
                    <Line type="monotone" dataKey="revenue" name="Revenue" stroke={AMBER} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="ebitda" name="EBITDA" stroke={GREEN} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </Panel>
              <Panel>
                <Eyebrow color={TEAL}>Credit profile · leverage and coverage</Eyebrow>
                <ResponsiveContainer width="100%" height={196}>
                  <LineChart data={creditData} margin={{ top: 14, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={LINE} strokeDasharray="2 4" vertical={false} />
                    <XAxis dataKey="label" stroke={FAINT} tick={{ fontSize: 10.5, fill: MUTED }} axisLine={{ stroke: LINE }} tickLine={false} />
                    <YAxis stroke={FAINT} tick={{ fontSize: 10.5, fill: MUTED }} axisLine={false} tickLine={false} width={40} />
                    <Tooltip contentStyle={{ background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, fontSize: 12 }} formatter={(v) => fmtX(v)} />
                    <ReferenceLine y={1.5} stroke={RED} strokeDasharray="3 3" strokeWidth={1} />
                    <Line type="monotone" dataKey="leverage" name="Net leverage" stroke={TEAL} strokeWidth={2} dot={{ r: 2.5, fill: TEAL }} />
                    <Line type="monotone" dataKey="coverage" name="Coverage" stroke={GOLD} strokeWidth={2} dot={{ r: 2.5, fill: GOLD }} />
                  </LineChart>
                </ResponsiveContainer>
                <div style={{ fontSize: 10.5, color: FAINT, marginTop: 4 }}>Dashed line marks a 1.5x coverage covenant.</div>
              </Panel>
            </div>

            <div className="g2" style={{ marginBottom: 18 }}>
              <Panel>
                <Eyebrow>Sources and uses ({sym}mm)</Eyebrow>
                <div style={{ marginTop: 10 }}>
                  <Row label="Purchase enterprise value" value={fmtM(sym, model.entryEV)} />
                  <Row label="Transaction fees" value={fmtM(sym, model.txnFees)} />
                  <Row label="Financing fees" value={fmtM(sym, model.finFees)} />
                  <Row label="Cash to balance sheet" value={fmtM(sym, model.minCash)} />
                  <Row label="Total uses" value={fmtM(sym, model.totalUses)} bold top />
                  <Row label="Term loan" value={fmtM(sym, model.tlAmount)} />
                  <Row label="Senior notes" value={fmtM(sym, model.snAmount)} />
                  <Row label="Management rollover" value={fmtM(sym, model.mgmtRollover)} />
                  <Row label="Sponsor equity" value={fmtM(sym, model.sponsorEquity)} bold top />
                </div>
              </Panel>
              <Panel>
                <Eyebrow>Scenario outcomes</Eyebrow>
                <div style={{ marginTop: 10 }}>
                  {[["Downside", model.downside, model.yearsDownside], ["Base", model.base, model.yearsBase], ["Upside", model.upside, model.yearsUpside]].map((sc) => (
                    <div key={sc[0]} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "10px 0", borderTop: `1px solid ${LINE}` }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: sc[0] === "Base" ? 700 : 400, color: sc[0] === "Base" ? TEXT : MUTED }}>{sc[0]}</div>
                        <div style={{ fontSize: 10.5, color: FAINT, marginTop: 2 }}>
                          exit leverage {fmtX1(sc[2][sc[2].length - 1].leverage)}
                          {sc[2].some((y) => y.shortfall) ? " \u00b7 cash shortfall" : ""}
                        </div>
                      </div>
                      <div style={{ ...mono, fontSize: 13.5, color: sc[1].irr < 0 ? RED : sc[1].irr >= model.hurdle ? GREEN : TEXT, whiteSpace: "nowrap" }}>
                        {fmtX(sc[1].moic)} &nbsp;/&nbsp; {fmtPct(sc[1].irr)}
                      </div>
                    </div>
                  ))}
                </div>
                {agents.a5 && <div style={{ fontSize: 12, color: MUTED, marginTop: 12, lineHeight: 1.55 }}>{agents.a5.downside_commentary}</div>}
              </Panel>
            </div>

            <Panel style={{ marginBottom: 18, overflowX: "auto" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
                <div>
                  <Eyebrow>Sponsor {sensMode} · entry against exit multiple</Eyebrow>
                  <div style={{ fontSize: 11.5, color: FAINT, marginTop: 4 }}>The boxed cell is the live case.</div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {["moic", "irr"].map((k) => (
                    <button key={k} onClick={() => setSensMode(k)} style={{
                      background: sensMode === k ? AMBER_DIM : "transparent", border: `1px solid ${sensMode === k ? AMBER : LINE}`,
                      color: sensMode === k ? AMBER : MUTED, borderRadius: 6, padding: "4px 12px", ...mono, fontSize: 10, letterSpacing: 1, cursor: "pointer",
                    }}>{k.toUpperCase()}</button>
                  ))}
                </div>
              </div>
              <table style={{ borderCollapse: "separate", borderSpacing: 3, fontSize: 12, width: "100%", minWidth: 430 }}>
                <thead>
                  <tr>
                    <td style={{ padding: 6 }} />
                    {model.exitMults.map((x) => <td key={x} style={{ padding: 6, textAlign: "center", ...mono, fontSize: 11, color: MUTED }}>{x.toFixed(2)}x</td>)}
                  </tr>
                </thead>
                <tbody>
                  {model.grid.map((rw) => (
                    <tr key={rw.entryMult}>
                      <td style={{ padding: 6, ...mono, fontSize: 11, color: MUTED, whiteSpace: "nowrap" }}>{rw.entryMult.toFixed(2)}x</td>
                      {rw.row.map((c) => {
                        const isLive = Math.abs(c.exitMult - assumptions.exit_ev_ebitda_x) < 1e-6 && Math.abs(rw.entryMult - assumptions.entry_multiple_x) < 1e-6;
                        const heat = clamp((c.irr - 0.05) / 0.3, 0, 1);
                        return (
                          <td key={c.exitMult} style={{
                            padding: "9px 6px", textAlign: "center", ...mono, borderRadius: 5,
                            background: isLive ? AMBER_DIM : `rgba(91,217,138,${heat * 0.24})`,
                            outline: isLive ? `1px solid ${AMBER}` : "none",
                            color: isLive ? AMBER : c.irr < 0 ? RED : TEXT, fontWeight: isLive ? 700 : 400,
                          }}>{sensMode === "moic" ? fmtX(c.moic) : fmtPct(c.irr, 0)}</td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            <div className="g2c" style={{ marginBottom: 18 }}>
              {agents.a5 && (
                <Panel>
                  <Eyebrow>Key risks</Eyebrow>
                  <div style={{ marginTop: 8 }}>
                    {agents.a5.key_risks.map((rk2, i) => (
                      <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "9px 0", borderTop: i ? `1px solid ${LINE}` : "none" }}>
                        <span style={{
                          ...mono, fontSize: 9, padding: "2px 7px", borderRadius: 4, flexShrink: 0, marginTop: 2,
                          background: rk2.severity === "High" ? "rgba(242,100,90,0.15)" : rk2.severity === "Medium" ? AMBER_DIM : "rgba(138,143,154,0.14)",
                          color: rk2.severity === "High" ? RED : rk2.severity === "Medium" ? AMBER : MUTED,
                        }}>{rk2.severity.toUpperCase()}</span>
                        <span style={{ fontSize: 12.5, lineHeight: 1.45 }}>
                          {rk2.risk}
                          {rk2.evidence && <span style={{ display: "block", fontSize: 10.5, color: FAINT, marginTop: 3 }}>{rk2.evidence}</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}
              {routes && agents.a6 && (
                <Panel>
                  <Eyebrow>Exit routes</Eyebrow>
                  <div style={{ marginTop: 8 }}>
                    {routes.map((rt2, i) => {
                      const rec = rt2.name === agents.a6.recommended_route;
                      return (
                        <div key={rt2.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "10px 0", borderTop: i ? `1px solid ${LINE}` : "none" }}>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: rec ? 700 : 400, color: rec ? AMBER : TEXT }}>{rt2.name}</div>
                            <div style={{ fontSize: 10.5, color: FAINT, marginTop: 2 }}>{rt2.mult.toFixed(2)}x exit multiple</div>
                          </div>
                          <div style={{ ...mono, fontSize: 13, whiteSpace: "nowrap" }}>{fmtX(rt2.moic)} / {fmtPct(rt2.irr)}</div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 12, color: MUTED, marginTop: 11, lineHeight: 1.55 }}>{agents.a6.rationale}</div>
                </Panel>
              )}
            </div>

            <Panel style={{ marginBottom: 18 }}>
              <Eyebrow>Audit checks</Eyebrow>
              <div className="auditgrid" style={{ marginTop: 11 }}>
                {model.checks.map((c) => (
                  <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    {c.ok ? <CheckCircle2 size={15} color={GREEN} /> : <AlertCircle size={15} color={RED} />}
                    <div>
                      <div style={{ fontSize: 12.5 }}>{c.name}</div>
                      <div style={{ ...mono, fontSize: 10.5, color: c.ok ? FAINT : RED }}>{c.value.toExponential(2)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>

            <button onClick={() => setShowConventions((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 6, background: "transparent", border: "none", color: FAINT, ...mono, fontSize: 11, cursor: "pointer", padding: 0, marginBottom: 14 }}>
              <Info size={13} /> {showConventions ? "HIDE" : "READ"} MODEL CONVENTIONS AND LIMITATIONS
            </button>
            {showConventions && (
              <Panel style={{ marginBottom: 18 }}>
                {CONVENTIONS.map((c, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, padding: "6px 0", fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
                    <span style={{ ...mono, color: FAINT, flexShrink: 0 }}>{String(i + 1).padStart(2, "0")}</span>
                    <span>{c}</span>
                  </div>
                ))}
              </Panel>
            )}

            <div style={{ textAlign: "center", paddingTop: 20, borderTop: `1px solid ${LINE}` }}>
              <div style={{ fontSize: 11.5, color: FAINT, lineHeight: 1.6, maxWidth: 660, margin: "0 auto 14px" }}>
                Reported financials are drawn from the target's own primary filing and still warrant checking against the source document. Structuring, credit, operating and exit assumptions are analyst judgement anchored on disclosed evidence, not disclosures themselves. Re-underwrite every input before this informs a decision.
              </div>
              <span style={{ ...serif, fontSize: 15 }}>Build it. Stress it. <span style={{ color: AMBER, fontStyle: "italic" }}>Then decide.</span></span>
            </div>
          </>
        )}
      </div>

      <style>{`
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        input::placeholder { color: ${FAINT}; }
        input[type=number]::-webkit-inner-spin-button { opacity: 0.25; }
        .hero { font-size: 44px; }
        .g2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
        .g2c { display: grid; grid-template-columns: 1fr 1.15fr; gap: 14px; }
        .modegrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
        @media (max-width: 900px) { .modegrid { grid-template-columns: 1fr 1fr; } }
        .kpigrid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; }
        .pipegrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(142px, 1fr)); gap: 9px; }
        .fieldgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(178px, 1fr)); gap: 12px; }
        .auditgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; }
        @media (max-width: 1000px) { .kpigrid { grid-template-columns: repeat(3, 1fr); } }
        @media (max-width: 820px) {
          .g2, .g2c, .modegrid { grid-template-columns: 1fr; }
          .kpigrid { grid-template-columns: repeat(2, 1fr); }
          .hero { font-size: 31px; }
        }
        button:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid ${AMBER}; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
      `}</style>
    </div>
  );
}

function AssumptionEditor({ a, sym, onEdit }) {
  const set = (k) => (v) => onEdit({ [k]: v });
  return (
    <div style={{ marginTop: 16 }}>
      <FieldGroup title="Target financials">
        <Field label={`LTM revenue (${sym}mm)`} value={a.ltm_revenue_mm} onChange={set("ltm_revenue_mm")} kind="mm" step={10} />
        <Field label={`LTM EBITDA (${sym}mm)`} value={a.ltm_ebitda_mm} onChange={set("ltm_ebitda_mm")} kind="mm" step={10} />
        <Field label={`Net debt (${sym}mm)`} value={a.net_debt_mm} onChange={set("net_debt_mm")} kind="mm" step={10} />
        <Field label={`Market cap (${sym}mm)`} value={a.market_cap_mm} onChange={set("market_cap_mm")} kind="mm" step={10} />
        <Field label="Current trading EV/EBITDA" value={a.current_ev_ebitda_x} onChange={set("current_ev_ebitda_x")} kind="x" />
      </FieldGroup>
      <FieldGroup title="Transaction structure">
        <Field label="Entry EV/EBITDA" value={a.entry_multiple_x} onChange={set("entry_multiple_x")} kind="x" />
        <Field label="Transaction fees" value={a.txn_fee_pct} onChange={set("txn_fee_pct")} kind="pct" step={0.25} />
        <Field label="Financing fees" value={a.financing_fee_pct} onChange={set("financing_fee_pct")} kind="pct" step={0.25} />
        <Field label="Management rollover" value={a.mgmt_rollover_pct} onChange={set("mgmt_rollover_pct")} kind="pct" />
      </FieldGroup>
      <FieldGroup title="Capital structure">
        <Field label="Term loan leverage" value={a.term_loan_leverage_x} onChange={set("term_loan_leverage_x")} kind="x" />
        <Field label="Term loan rate" value={a.term_loan_rate_pct} onChange={set("term_loan_rate_pct")} kind="pct" step={0.25} />
        <Field label="Term loan amortisation" value={a.term_loan_amort_pct} onChange={set("term_loan_amort_pct")} kind="pct" step={0.5} />
        <Field label="Senior notes leverage" value={a.senior_notes_leverage_x} onChange={set("senior_notes_leverage_x")} kind="x" />
        <Field label="Senior notes coupon" value={a.senior_notes_rate_pct} onChange={set("senior_notes_rate_pct")} kind="pct" step={0.25} />
        <Field label={`Revolver commitment (${sym}mm)`} value={a.revolver_size_mm} onChange={set("revolver_size_mm")} kind="mm" step={10} />
        <Field label="Revolver rate" value={a.revolver_rate_pct} onChange={set("revolver_rate_pct")} kind="pct" step={0.25} />
        <Field label="Cash sweep" value={a.cash_sweep_pct} onChange={set("cash_sweep_pct")} kind="pct" step={5} />
        <Field label="Interest on cash" value={a.cash_interest_rate_pct} onChange={set("cash_interest_rate_pct")} kind="pct" step={0.25} />
        <Field label="Minimum cash (% revenue)" value={a.min_cash_pct_revenue} onChange={set("min_cash_pct_revenue")} kind="pct" step={0.5} />
      </FieldGroup>
      <FieldGroup title="Operating cases">
        <Field label="Revenue growth · base" value={a.revenue_growth_base_pct} onChange={set("revenue_growth_base_pct")} kind="pct" />
        <Field label="Revenue growth · upside" value={a.revenue_growth_upside_pct} onChange={set("revenue_growth_upside_pct")} kind="pct" />
        <Field label="Revenue growth · downside" value={a.revenue_growth_downside_pct} onChange={set("revenue_growth_downside_pct")} kind="pct" />
        <Field label="Exit margin · base" value={a.exit_margin_base_pct} onChange={set("exit_margin_base_pct")} kind="pct" />
        <Field label="Exit margin · upside" value={a.exit_margin_upside_pct} onChange={set("exit_margin_upside_pct")} kind="pct" />
        <Field label="Exit margin · downside" value={a.exit_margin_downside_pct} onChange={set("exit_margin_downside_pct")} kind="pct" />
        <Field label="Capex (% revenue)" value={a.capex_pct_revenue} onChange={set("capex_pct_revenue")} kind="pct" step={0.25} />
        <Field label="D&A (% revenue)" value={a.da_pct_revenue} onChange={set("da_pct_revenue")} kind="pct" step={0.25} />
        <Field label="Working capital (% Δ revenue)" value={a.nwc_pct_delta_revenue} onChange={set("nwc_pct_delta_revenue")} kind="pct" />
        <Field label="Cash tax rate" value={a.tax_rate_pct} onChange={set("tax_rate_pct")} kind="pct" />
      </FieldGroup>
      <FieldGroup title="Exit and hurdle">
        <Field label="Hold period (years)" value={a.exit_year} onChange={(v) => onEdit({ exit_year: clamp(Math.round(v), 3, 7) })} step={1} />
        <Field label="Exit EV/EBITDA" value={a.exit_ev_ebitda_x} onChange={set("exit_ev_ebitda_x")} kind="x" />
        <Field label="Exit fees" value={a.exit_fee_pct} onChange={set("exit_fee_pct")} kind="pct" step={0.25} />
        <Field label="Target IRR (hurdle)" value={a.hurdle_irr_pct} onChange={set("hurdle_irr_pct")} kind="pct" />
      </FieldGroup>
    </div>
  );
}
