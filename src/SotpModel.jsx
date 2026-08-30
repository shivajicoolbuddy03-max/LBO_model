import React, { useRef, useState } from "react";
import {
  KeyRound, Loader2, Play, FileSpreadsheet, Wand2, PencilLine,
  Plus, Trash2, Rocket, Download, AlertTriangle,
} from "lucide-react";
import {
  INK, PANEL, PANEL2, LINE, AMBER, AMBER_DIM, TEAL, GREEN, RED, GOLD, TEXT, MUTED, FAINT, mono, serif, ghostBtn,
} from "./lib/theme.js";
import { getApiKey, getSelectedProvider, loadSelectedProvider } from "./lib/apiKey.js";
import { callAI, PROVIDERS } from "./lib/aiClient.js";
import {
  JURISDICTIONS, defaultSotpState, makeSegment, makeMultiple,
  computeNetDebt, computeBridge, percentile, computeSOTP, num,
} from "./lib/sotpCalc.js";
import { StyleBook, WSheet, writeXlsx, colName } from "./lib/xlsxWriter.js";
import ApiKeyPanel from "./components/ApiKeyPanel.jsx";

/* ------------------------------------------------------------------ *
 * FORMATTERS
 * ------------------------------------------------------------------ */
function fmt(n, currency, dp = 0) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  const neg = n < 0;
  const v = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return neg ? `(${currency} ${v})` : `${currency} ${v}`;
}
function fmtNum(n, dp = 0) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function pctStr(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return (n * 100).toFixed(1) + "%";
}
function metricLabel(pm) { return pm === "EBITDA" ? "EBITDA" : "Operating Income"; }
function metricShort(pm) { return pm === "EBITDA" ? "Seg. EBITDA" : "Seg. OI"; }
function metricAbbr(pm) { return pm === "EBITDA" ? "EBITDA" : "OI"; }

/* ------------------------------------------------------------------ *
 * AI SOURCING RULES — every fetch in this tool is restricted to the
 * company's own IR site plus its home jurisdiction's official
 * regulator/exchange filing system; never a data aggregator.
 * ------------------------------------------------------------------ */
function todayStr() {
  return new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}
function asOfDateLabel(company) {
  if (company.asOfDate) {
    const d = new Date(company.asOfDate + "T00:00:00");
    if (!isNaN(d)) return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  }
  return todayStr();
}
function effectiveJurisdiction(company) {
  return company.jurisdiction === "OTHER" ? (company.otherJur || "the company's home market") : company.jurisdiction;
}
function sourceRuleText(company) {
  const asOf = asOfDateLabel(company);
  const jur = effectiveJurisdiction(company);
  return `You are a strict financial-data sourcing assistant. The user has explicitly specified that data should be sourced as of ${asOf} — treat this as the authoritative "today" for recency purposes, NOT your training-data knowledge of recent filings. Find the single most recent filing/quote dated on or before ${asOf}. Your training data has a knowledge cutoff well before this date, so any filing you recall from memory is very likely stale — companies have filed newer quarterly and/or annual reports since your training data was collected, and you must search to confirm rather than assume. Before finalizing any figure, check the filing/period date shown in your search results and ask yourself "is this really the newest one available as of ${asOf}, or just the newest one I happen to remember?" If a search result surfaces a filing more recent than the one you were about to use (and it is not after ${asOf}), switch to the more recent one.

You may ONLY use, search for, and cite pages/documents on these domains:
(1) the company's own official investor-relations website (e.g. investor.company.com, ir.company.com), and
(2) the official regulator/exchange filing system for this jurisdiction: ${jur || "the company's home market"}.
For share price specifically, you may ALSO cite the primary listing exchange's own site (e.g. nyse.com, nasdaq.com, or the relevant national exchange's own domain) if the company's own IR site doesn't have it, and — as a last resort, only for share price, only if none of the above yield a plain-text number — a reputable third-party quote service: Bloomberg.com, Yahoo Finance, or Google Finance. When you use one of these three as a last resort, set "source" to clearly say so, e.g. "Yahoo Finance (third-party quote, IR/exchange price unavailable)".

PERMITTED SOURCES TEST — this is a test about the URL/DOMAIN you are citing, not about where that page's underlying data ultimately comes from:
✅ If the page you're citing lives on the company's own IR domain, the official regulator/exchange filing system, or (for price only) the exchange's own domain — it is PERMITTED, full stop.
✅ For share price ONLY, and only as a last resort: Bloomberg.com, Yahoo Finance, or Google Finance are PERMITTED, but must be labeled "third-party" in "source".
❌ For every field OTHER than share price, these count as prohibited: pages on a THIRD-PARTY financial site's own domain — Yahoo Finance, Google Finance, Bloomberg.com, Reuters, MarketWatch, Simply Wall St, stockanalysis.com, wsj.com, Macrotrends, TradingView, screener.in, moneycontrol, Wisesheets, or any other stock screener/aggregator/news article/broker note.
IMPORTANT: a permitted page that shows "quote delayed 15/20 minutes" or "data provided by [some vendor]" is STILL fully permitted — that disclaimer describes the feed technology, not the page you're citing. Do NOT set a value to null just because of a "data provided by" disclaimer on an otherwise-permitted page.
If a figure genuinely only appears on a prohibited domain (and, for share price, none of the three named third-party quote services have it either), set "value" to JSON null. Do not reason about it further. For every field, give the exact source document/page name, the URL, and the as-of or filing date, each kept short.

OUTPUT BUDGET IS EXTREMELY TIGHT. Do all searching, comparing, and deciding silently — write nothing down except the final JSON. No bullet points, no bold labels, no narration of which filing you're about to check. The very first character of your entire reply must be { — nothing before it, nothing after the final }, no markdown fences. You may run up to 4-5 searches if genuinely needed, but once you've found a value or exhausted the reasonable permitted-source options for it, move on immediately.
Every numeric value must be a bare JSON number (never a string, never containing commas or currency symbols). Use JSON null where a value is unknown. No trailing commas before any closing } or ]. If you notice you're running low on room, abandon whatever field you're mid-explaining, set remaining unconfirmed fields to null, and close the JSON object immediately.`;
}
function sharePriceSourcingHint(companyLabel) {
  return `Check the company's own investor-relations website under its "Stock Information" / "Stock Quote & Chart" section. This page belongs to ${companyLabel} itself, so it is fully permitted — a "delayed quote" or "data provided by [vendor]" disclaimer does NOT make it prohibited. If that page's number isn't extractable as plain text, try, in order: (a) the primary listing exchange's own quote page for this ticker; (b) the company's most recent insider-transaction filing on the official regulator system, which discloses an exact transaction price and date in a plain-text table — a transaction within the last month or two is a reasonable proxy for "current" price; (c) as a last resort, a reputable third-party quote service — Bloomberg.com, Yahoo Finance, or Google Finance — clearly labeled "third-party" in "source" so the user knows it isn't a primary source. Only fall back to (c) once (a) and (b) have genuinely failed. If none of these yield a plain-text number, set the value to null.`;
}
async function fetchOneField({ company, instruction, unitLabel, extraHint, maxTokens }) {
  const schema = `{"value":number|null,"source":string,"url":string,"as_of":string}`;
  const prompt = `Company: ${company.name} (Ticker: ${company.ticker}, Exchange: ${company.exchange}). Data as-of date: ${asOfDateLabel(company)}.
Find only this ONE figure: ${instruction}
${extraHint || ""}
Value in ${unitLabel}. Return JSON only, schema: ${schema}`;
  return await callAI(sourceRuleText(company), prompt, { useWebSearch: true, maxTokens: maxTokens || 1000 });
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
function StatTile({ label, value, sub, color }) {
  return (
    <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 10, padding: 16 }}>
      <Eyebrow>{label}</Eyebrow>
      <div style={{ ...mono, fontSize: 20, fontWeight: 700, color: color || TEXT, marginTop: 8 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: FAINT, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
function StatusMsg({ status }) {
  if (!status || !status.text) return null;
  const color = status.err ? RED : status.ok ? GREEN : TEAL;
  return <div style={{ fontSize: 12, color, marginTop: 8, lineHeight: 1.5 }}>{status.text}</div>;
}
function ModeToggle({ mode, onChange }) {
  return (
    <div style={{ display: "flex", border: `1px solid ${LINE}`, borderRadius: 20, overflow: "hidden", width: "fit-content" }}>
      {[["ai", "AI-Assisted", Wand2], ["manual", "Manual", PencilLine]].map(([id, label, Icon]) => {
        const on = mode === id;
        return (
          <button key={id} onClick={() => onChange(id)} style={{
            border: "none", background: on ? AMBER : "transparent", color: on ? "#fff" : MUTED,
            padding: "7px 14px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 5,
          }}>
            <Icon size={12} /> {label}
          </button>
        );
      })}
    </div>
  );
}
function NumField({ label, help, value, onChange, suffix, step, bare }) {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  const [focused, setFocused] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const display = value == null ? "" : String(value);
  if (!focused && display !== draft) setDraft(display);
  const box = (
    <div style={{ display: "flex", alignItems: "center", background: INK, border: `1px solid ${LINE}`, borderRadius: bare ? 6 : 7 }}>
      <input
        type="number"
        step={step || "any"}
        value={draft}
        placeholder={bare ? "" : "—"}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); const nn = parseFloat(draft); onChange(isFinite(nn) ? nn : null); if (!isFinite(nn)) setDraft(""); }}
        onChange={(e) => { setDraft(e.target.value); const nn = parseFloat(e.target.value); if (isFinite(nn)) onChange(nn); else if (e.target.value === "") onChange(null); }}
        style={{ flex: 1, minWidth: 0, width: "100%", background: "transparent", border: "none", outline: "none", color: TEXT, ...mono, fontSize: bare ? 12 : 12.5, padding: bare ? "6px 7px" : "8px 9px", textAlign: "right" }}
      />
      {suffix && <span style={{ ...mono, fontSize: 10.5, color: FAINT, paddingRight: 8 }}>{suffix}</span>}
    </div>
  );
  if (bare) return box;
  return (
    <label style={{ display: "block" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
        <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.3, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
        {help && <InfoDot open={showHelp} onClick={(e) => { e.preventDefault(); setShowHelp((v) => !v); }} />}
      </div>
      {box}
      {help && showHelp && <div style={{ fontSize: 10.5, color: MUTED, marginTop: 5, lineHeight: 1.45 }}>{help}</div>}
    </label>
  );
}
function TextField({ label, help, value, onChange, placeholder, type }) {
  const [showHelp, setShowHelp] = useState(false);
  return (
    <label style={{ display: "block" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
        <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.3, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
        {help && <InfoDot open={showHelp} onClick={(e) => { e.preventDefault(); setShowHelp((v) => !v); }} />}
      </div>
      <input
        type={type || "text"}
        value={value || ""}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%", background: INK, border: `1px solid ${LINE}`, borderRadius: 7, padding: "9px 10px", color: TEXT, fontSize: 13, outline: "none" }}
      />
      {help && showHelp && <div style={{ fontSize: 10.5, color: MUTED, marginTop: 5, lineHeight: 1.45 }}>{help}</div>}
    </label>
  );
}
function SelectField({ label, help, value, onChange, options }) {
  const [showHelp, setShowHelp] = useState(false);
  return (
    <label style={{ display: "block" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
        <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.3, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
        {help && <InfoDot open={showHelp} onClick={(e) => { e.preventDefault(); setShowHelp((v) => !v); }} />}
      </div>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%", background: INK, border: `1px solid ${LINE}`, borderRadius: 7, padding: "9px 10px", color: TEXT, fontSize: 13, outline: "none" }}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {help && showHelp && <div style={{ fontSize: 10.5, color: MUTED, marginTop: 5, lineHeight: 1.45 }}>{help}</div>}
    </label>
  );
}
function SrcNote({ src }) {
  if (!src || !src.source) return null;
  return (
    <div style={{ fontSize: 10.5, color: FAINT, marginTop: 4 }}>
      {src.source}{src.as_of ? ` · ${src.as_of}` : ""}{" "}
      {src.url && <a href={src.url} target="_blank" rel="noopener noreferrer" style={{ color: TEAL }}>↗</a>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * EXCEL EXPORT — real formulas, no pasted values, same convention as
 * the Merger Model workbook: a fixed row map on the sheets that don't
 * scale with user data, formula chains for the dynamic segment table.
 * ------------------------------------------------------------------ */
const XP = { title: "1F4E78", banner: "2E5395", white: "FFFFFF", dark: "1A1D2E", input: "0000FA", bad: "9C0006" };
function buildSotpWorkbook(d) {
  const { company, market, netDebt, segments, multiples, profitMetric, sotp } = d;
  const cur = company.currency || "USD";
  const SB = StyleBook();
  const S = {
    title: SB.s({ font: { b: true, sz: 14, color: XP.white }, fill: XP.title, align: { v: "center" } }),
    subtitle: SB.s({ font: { sz: 9, color: XP.white }, fill: XP.title }),
    banner: SB.s({ font: { b: true, color: XP.white }, fill: XP.banner }),
    colHdr: SB.s({ font: { b: true, sz: 9, color: XP.dark }, fill: "E6E7ED", align: { h: "center" } }),
    lbl: SB.s({ font: {} }),
    lblB: SB.s({ font: { b: true } }),
    inputUSD: SB.s({ font: { color: XP.input }, numFmt: `"${cur}" #,##0.0;[Red]("${cur}" (#,##0.0))` }),
    inputUSD2: SB.s({ font: { color: XP.input }, numFmt: `"${cur}" #,##0.00;[Red]("${cur}" (#,##0.00))` }),
    inputNum: SB.s({ font: { color: XP.input }, numFmt: "#,##0.000" }),
    inputX: SB.s({ font: { color: XP.input }, numFmt: "0.00" }),
    formUSD: SB.s({ numFmt: `"${cur}" #,##0.0;[Red]("${cur}" (#,##0.0))` }),
    formNum: SB.s({ numFmt: "#,##0.0" }),
    formPct: SB.s({ numFmt: "0.0%" }),
    total: SB.s({ font: { b: true, color: XP.input }, border: { top: { style: "thin" } }, numFmt: `"${cur}" #,##0.0;[Red]("${cur}" (#,##0.0))` }),
    totalPct: SB.s({ font: { b: true, color: XP.input }, border: { top: { style: "thin" } }, numFmt: "0.0%" }),
  };
  const MKT_SHEET = "Setup & Market", SEG_SHEET = "Segments & Multiples";
  const MKref = (col, row) => `'${MKT_SHEET}'!$${col}$${row}`;
  const SEGref = (col, row) => `'${SEG_SHEET}'!$${col}$${row}`;

  const MK = { sharePrice: 4, basicShares: 5, dilutedShares: 6 };
  const NDr = {
    currentDebt: 9, ltDebt: 10, cash: 11, pensionLiab: 12, pensionAsset: 13, nci: 14, other: 15,
    totalDebt: 17, netDebt: 18, mktCap: 19, currentEV: 20,
  };

  // ---------- Setup & Market ----------
  const ws1 = WSheet(MKT_SHEET, { cols: [34, 20, 20] });
  ws1.txt(0, 1, `SOTP Valuation — ${company.name}${company.ticker ? ` (${company.ticker})` : ""}`, S.title).band(0, 2, 1, S.title).merge(0, 1, 2, 1);
  ws1.txt(0, 2, `Currency: ${cur} mm, except per-share · Jurisdiction: ${effectiveJurisdiction(company)}`, S.subtitle).band(0, 2, 2, S.subtitle).merge(0, 2, 2, 2);
  ws1.txt(0, 3, "Market Data", S.banner).band(0, 2, 3, S.banner).merge(0, 3, 2, 3);
  ws1.txt(0, MK.sharePrice, "Current Share Price", S.lbl); ws1.num(1, MK.sharePrice, num(market.sharePrice), S.inputUSD2);
  ws1.txt(0, MK.basicShares, "Basic Shares O/S (mm)", S.lbl); ws1.num(1, MK.basicShares, num(market.basicSharesMM), S.inputNum);
  ws1.txt(0, MK.dilutedShares, "Diluted Shares O/S (mm)", S.lbl); ws1.num(1, MK.dilutedShares, num(market.dilutedSharesMM), S.inputNum);
  ws1.txt(0, 8, "Net Debt / (Net Cash) Bridge", S.banner).band(0, 2, 8, S.banner).merge(0, 8, 2, 8);
  ws1.txt(0, NDr.currentDebt, "Current Portion LT Debt", S.lbl); ws1.num(1, NDr.currentDebt, num(netDebt.currentDebt), S.inputUSD);
  ws1.txt(0, NDr.ltDebt, "LT Debt, Net of Current", S.lbl); ws1.num(1, NDr.ltDebt, num(netDebt.ltDebt), S.inputUSD);
  ws1.txt(0, NDr.cash, "Cash & Equivalents", S.lbl); ws1.num(1, NDr.cash, num(netDebt.cash), S.inputUSD);
  ws1.txt(0, NDr.pensionLiab, "Pension/OPB Liabilities", S.lbl); ws1.num(1, NDr.pensionLiab, num(netDebt.pensionLiab), S.inputUSD);
  ws1.txt(0, NDr.pensionAsset, "Pension/OPB Assets", S.lbl); ws1.num(1, NDr.pensionAsset, num(netDebt.pensionAsset), S.inputUSD);
  ws1.txt(0, NDr.nci, "Noncontrolling Interests", S.lbl); ws1.num(1, NDr.nci, num(netDebt.nci), S.inputUSD);
  ws1.txt(0, NDr.other, "Other Adjustments (+/-)", S.lbl); ws1.num(1, NDr.other, num(netDebt.other), S.inputUSD);
  ws1.txt(0, NDr.totalDebt, "Total Debt", S.lblB);
  ws1.fml(1, NDr.totalDebt, `=B${NDr.currentDebt}+B${NDr.ltDebt}`, computeNetDebt(netDebt).totalDebt, S.formUSD);
  ws1.txt(0, NDr.netDebt, "Net Debt / (Net Cash)", S.lblB);
  ws1.fml(1, NDr.netDebt, `=B${NDr.totalDebt}-B${NDr.cash}+B${NDr.pensionLiab}-B${NDr.pensionAsset}+B${NDr.nci}+B${NDr.other}`, computeNetDebt(netDebt).netDebt, S.total);
  ws1.txt(0, NDr.mktCap, "Current Market Capitalization", S.lblB);
  ws1.fml(1, NDr.mktCap, `=B${MK.sharePrice}*B${MK.dilutedShares}`, sotp.bridge.mktCap, S.formUSD);
  ws1.txt(0, NDr.currentEV, "Implied Current Enterprise Value", S.lblB);
  ws1.fml(1, NDr.currentEV, `=B${NDr.mktCap}+B${NDr.netDebt}`, sotp.bridge.currentEV, S.total);

  // ---------- Segments & Multiples ----------
  const ws2 = WSheet(SEG_SHEET, { cols: [26, 14, 14, 12, 12, 12, 12, 14, 14, 14, 14, 14, 14] });
  ws2.txt(0, 1, "Segment-Level EV Build", S.banner).band(0, 12, 1, S.banner).merge(0, 1, 12, 1);
  const hdrRow = 2;
  ["Segment", "Current Sales", `Current ${metricAbbr(profitMetric)}`, "EV/Sales 25th", "EV/Sales 75th", `EV/${metricAbbr(profitMetric)} 25th`, `EV/${metricAbbr(profitMetric)} 75th`,
    "EV@Sales Low", "EV@Sales High", `EV@${metricAbbr(profitMetric)} Low`, `EV@${metricAbbr(profitMetric)} High`, "Blended EV Low", "Blended EV High"]
    .forEach((h, ci) => ws2.txt(ci, hdrRow, h, S.colHdr));
  const firstRow = hdrRow + 1;
  segments.forEach((s, i) => {
    const row = firstRow + i;
    const m = multiples[s.id] || {};
    ws2.txt(0, row, s.name, S.lbl);
    ws2.num(1, row, num(s.currentSales), S.inputUSD);
    ws2.num(2, row, num(s.currentOI), S.inputUSD);
    ws2.num(3, row, num(m.evSalesLow), S.inputX);
    ws2.num(4, row, num(m.evSalesHigh), S.inputX);
    ws2.num(5, row, num(m.evOILow), S.inputX);
    ws2.num(6, row, num(m.evOIHigh), S.inputX);
    ws2.fml(7, row, `=B${row}*D${row}`, num(s.currentSales) * num(m.evSalesLow), S.formUSD);
    ws2.fml(8, row, `=B${row}*E${row}`, num(s.currentSales) * num(m.evSalesHigh), S.formUSD);
    ws2.fml(9, row, `=C${row}*F${row}`, num(s.currentOI) * num(m.evOILow), S.formUSD);
    ws2.fml(10, row, `=C${row}*G${row}`, num(s.currentOI) * num(m.evOIHigh), S.formUSD);
    ws2.fml(11, row, `=(H${row}+J${row})/2`, (num(s.currentSales) * num(m.evSalesLow) + num(s.currentOI) * num(m.evOILow)) / 2, S.formUSD);
    ws2.fml(12, row, `=(I${row}+K${row})/2`, (num(s.currentSales) * num(m.evSalesHigh) + num(s.currentOI) * num(m.evOIHigh)) / 2, S.formUSD);
  });
  const totalRow = firstRow + segments.length;
  ws2.txt(0, totalRow, "Total", S.lblB);
  const colSums = { 1: 0, 2: 0, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0 };
  segments.forEach((s) => {
    const m = multiples[s.id] || {};
    const evSalesLow = num(s.currentSales) * num(m.evSalesLow), evSalesHigh = num(s.currentSales) * num(m.evSalesHigh);
    const evOILow = num(s.currentOI) * num(m.evOILow), evOIHigh = num(s.currentOI) * num(m.evOIHigh);
    colSums[1] += num(s.currentSales); colSums[2] += num(s.currentOI);
    colSums[7] += evSalesLow; colSums[8] += evSalesHigh; colSums[9] += evOILow; colSums[10] += evOIHigh;
    colSums[11] += (evSalesLow + evOILow) / 2; colSums[12] += (evSalesHigh + evOIHigh) / 2;
  });
  [1, 2, 7, 8, 9, 10, 11, 12].forEach((ci) => {
    const col = colName(ci);
    ws2.fml(ci, totalRow, `=SUM(${col}${firstRow}:${col}${totalRow - 1})`, colSums[ci], ci >= 11 ? S.total : S.formUSD);
  });

  // ---------- Results ----------
  const ws3 = WSheet("Results", { cols: [34, 20, 20] });
  ws3.txt(0, 1, "Bridge to Implied Equity Value & Share Price", S.banner).band(0, 2, 1, S.banner).merge(0, 1, 2, 1);
  ws3.txt(1, 2, "Low", S.lblB); ws3.txt(2, 2, "High", S.lblB);
  ws3.txt(0, 3, "Total Segment Enterprise Value", S.lbl);
  ws3.fml(1, 3, `=${SEGref("L", totalRow)}`, sotp.sotpEVLow, S.formUSD);
  ws3.fml(2, 3, `=${SEGref("M", totalRow)}`, sotp.sotpEVHigh, S.formUSD);
  ws3.txt(0, 4, "(-) Net Debt / (+) Net Cash", S.lbl);
  ws3.fml(1, 4, `=-${MKref("B", NDr.netDebt)}`, -sotp.bridge.netDebt, S.formUSD);
  ws3.fml(2, 4, `=-${MKref("B", NDr.netDebt)}`, -sotp.bridge.netDebt, S.formUSD);
  ws3.txt(0, 5, "Implied SOTP Equity Value", S.lblB);
  ws3.fml(1, 5, `=B3+B4`, sotp.equityLow, S.total); ws3.fml(2, 5, `=C3+C4`, sotp.equityHigh, S.total);
  ws3.txt(0, 6, "÷ Diluted Shares Outstanding (mm)", S.lbl);
  ws3.fml(1, 6, `=${MKref("B", MK.dilutedShares)}`, sotp.dilutedShares, S.formNum);
  ws3.fml(2, 6, `=${MKref("B", MK.dilutedShares)}`, sotp.dilutedShares, S.formNum);
  ws3.txt(0, 7, "Implied Share Price (SOTP)", S.lblB);
  ws3.fml(1, 7, `=B5/B6`, sotp.priceLow, S.total); ws3.fml(2, 7, `=C5/C6`, sotp.priceHigh, S.total);
  ws3.txt(0, 8, "Current Share Price", S.lbl);
  ws3.fml(1, 8, `=${MKref("B", MK.sharePrice)}`, sotp.currentPrice, S.formUSD);
  ws3.fml(2, 8, `=${MKref("B", MK.sharePrice)}`, sotp.currentPrice, S.formUSD);
  ws3.txt(0, 9, "Implied Premium / (Discount) to Current", S.lblB);
  ws3.fml(1, 9, `=B7/B8-1`, sotp.premLow, S.totalPct); ws3.fml(2, 9, `=C7/C8-1`, sotp.premHigh, S.totalPct);

  ws3.txt(0, 11, "Cross-Check — SOTP EV vs. Current Market-Implied EV", S.banner).band(0, 2, 11, S.banner).merge(0, 11, 2, 11);
  ws3.txt(1, 12, "Low", S.lblB); ws3.txt(2, 12, "High", S.lblB);
  ws3.txt(0, 13, "Current Market-Implied Enterprise Value", S.lbl);
  ws3.fml(1, 13, `=${MKref("B", NDr.currentEV)}`, sotp.bridge.currentEV, S.formUSD);
  ws3.fml(2, 13, `=${MKref("B", NDr.currentEV)}`, sotp.bridge.currentEV, S.formUSD);
  ws3.txt(0, 14, "Total SOTP Enterprise Value", S.lbl);
  ws3.fml(1, 14, `=B3`, sotp.sotpEVLow, S.formUSD); ws3.fml(2, 14, `=C3`, sotp.sotpEVHigh, S.formUSD);
  ws3.txt(0, 15, "Implied Conglomerate Discount / (Premium)", S.lblB);
  ws3.fml(1, 15, `=1-B13/B14`, sotp.discLow, S.totalPct); ws3.fml(2, 15, `=1-C13/C14`, sotp.discHigh, S.totalPct);

  return writeXlsx([ws1, ws2, ws3], SB);
}

/* ------------------------------------------------------------------ *
 * MAIN
 * ------------------------------------------------------------------ */
export default function SotpModel() {
  const [state, setState] = useState(defaultSotpState);
  const [tab, setTab] = useState("setup");
  const [modes, setModes] = useState({ market: "ai", netdebt: "ai", segments: "ai" });
  const [status, setStatus] = useState({}); // key -> {text, err, ok}
  const [peerStatus, setPeerStatus] = useState({});
  const [peerTickers, setPeerTickers] = useState({});
  const [masterLog, setMasterLog] = useState([]);
  const [busy, setBusy] = useState({});
  const [dashboard, setDashboard] = useState(null);
  const segCounter = useRef(2);
  const [hasKey, setHasKey] = useState(false);
  const [provider, setProvider] = useState("anthropic");
  const [showKeyPanel, setShowKeyPanel] = useState(false);
  const [exportError, setExportError] = useState("");

  function refreshKeyState() {
    const p = loadSelectedProvider();
    setProvider(p);
    setHasKey(!!getApiKey(p));
  }
  React.useEffect(() => { refreshKeyState(); }, []);

  const setBusyFlag = (key, v) => setBusy((b) => ({ ...b, [key]: v }));
  const setSt = (key, text, err, ok) => setStatus((s) => ({ ...s, [key]: { text, err, ok } }));

  function setCompany(field, value) { setState((p) => ({ ...p, company: { ...p.company, [field]: value } })); }
  function setMarket(field, value) { setState((p) => ({ ...p, market: { ...p.market, [field]: value } })); }
  function setNetDebtField(field, value) { setState((p) => ({ ...p, netDebt: { ...p.netDebt, [field]: value } })); }
  function addSegment(name) {
    segCounter.current += 1;
    const id = "seg" + segCounter.current;
    setState((p) => ({
      ...p,
      segments: [...p.segments, makeSegment(id, name || `Segment ${p.segments.length + 1}`)],
      multiples: { ...p.multiples, [id]: makeMultiple() },
    }));
  }
  function removeSegment(id) {
    setState((p) => {
      const multiples = { ...p.multiples }; delete multiples[id];
      return { ...p, segments: p.segments.filter((s) => s.id !== id), multiples };
    });
  }
  function updateSegment(id, field, value) {
    setState((p) => ({ ...p, segments: p.segments.map((s) => (s.id === id ? { ...s, [field]: value } : s)) }));
  }
  function setSegSrc(id, field, src) {
    setState((p) => ({ ...p, segments: p.segments.map((s) => (s.id === id ? { ...s, src: { ...s.src, [field]: src } } : s)) }));
  }
  function updateMultiple(id, field, value) {
    setState((p) => ({ ...p, multiples: { ...p.multiples, [id]: { ...(p.multiples[id] || makeMultiple()), [field]: value } } }));
  }
  function replaceSegments(names) {
    const nextMultiples = {};
    const nextSegments = names.map((n) => {
      segCounter.current += 1;
      const id = "seg" + segCounter.current;
      nextMultiples[id] = makeMultiple();
      return makeSegment(id, n);
    });
    setState((p) => ({ ...p, segments: nextSegments, multiples: nextMultiples }));
  }

  function requireKey(msg) {
    if (getApiKey(getSelectedProvider())) return true;
    setSt("master", msg || `Add your ${PROVIDERS[getSelectedProvider()].label} API key (key icon, top right) to run AI research, or use Manual mode instead.`, true);
    return false;
  }

  /* ---------------- AI: market data ---------------- */
  async function fetchMarketData() {
    if (!state.company.name) { alert("Enter a company name on the Company Setup tab first."); return; }
    if (!requireKey()) return;
    setBusyFlag("market", true);
    setSt("market", "Fetching share price…");
    const got = { price: false, basic: false, diluted: false };
    try {
      const r1 = await fetchOneField({
        company: state.company, instruction: `the current/most recent share price as of ${asOfDateLabel(state.company)}.`,
        unitLabel: state.company.currency, extraHint: sharePriceSourcingHint(state.company.name),
      }).catch(() => null);
      if (r1 && r1.value != null) { setMarket("sharePrice", r1.value); setMarket("src", { ...state.market.src, sharePrice: r1 }); got.price = true; }

      setSt("market", "Fetching basic shares outstanding…");
      const r2 = await fetchOneField({
        company: state.company,
        instruction: `basic shares outstanding, from the cover page of the single most recent regulator filing available as of ${asOfDateLabel(state.company)} — this may be a quarterly filing if one has been filed more recently than the last annual report.`,
        unitLabel: "millions",
      }).catch(() => null);
      if (r2 && r2.value != null) { setMarket("basicSharesMM", r2.value); got.basic = true; }

      setSt("market", "Fetching diluted shares outstanding…");
      const r3 = await fetchOneField({
        company: state.company, instruction: "weighted-average diluted shares outstanding, from that same most-recent filing or its accompanying earnings release.", unitLabel: "millions",
      }).catch(() => null);
      if (r3 && r3.value != null) { setMarket("dilutedSharesMM", r3.value); got.diluted = true; }
    } finally {
      const missing = [];
      if (!got.price) missing.push("share price");
      if (!got.basic) missing.push("basic shares");
      if (!got.diluted) missing.push("diluted shares");
      setSt("market", missing.length === 0 ? "All market data fetched — verify each citation." : `Fetched with gaps — missing: ${missing.join(", ")}. Enter manually, or click again to retry.`, missing.length > 0, missing.length === 0);
      setBusyFlag("market", false);
    }
  }

  /* ---------------- AI: net debt ---------------- */
  async function fetchNetDebtData() {
    if (!state.company.name) { alert("Enter a company name on the Company Setup tab first."); return; }
    if (!requireKey()) return;
    setBusyFlag("netdebt", true);
    const fields = [
      ["current portion of long-term debt.", "currentDebt", "current portion of long-term debt"],
      ["long-term debt, net of current portion.", "ltDebt", "long-term debt (non-current)"],
      ["cash & cash equivalents.", "cash", "cash & equivalents"],
      ["non-current pension/OPB (other post-employment benefit) plan liabilities.", "pensionLiab", "pension/OPB liabilities"],
      ["non-current pension/OPB plan assets.", "pensionAsset", "pension/OPB assets"],
      ["noncontrolling interests.", "nci", "noncontrolling interests"],
    ];
    const missing = [];
    for (const [instruction, field, label] of fields) {
      setSt("netdebt", `Fetching ${label}…`);
      const asOf = asOfDateLabel(state.company);
      const prompt = `Company: ${state.company.name} (Ticker: ${state.company.ticker}). Fiscal period: ${state.company.fy}. Data as-of date: ${asOf}.
From the most recently filed consolidated balance sheet as of ${asOf} — use the latest quarterly filing if one postdates the last annual report, otherwise the annual report.
Find only this ONE figure: ${instruction} Give it as a positive number in ${state.company.currency} millions (0 if the line item isn't presented separately). Try at most 2 searches — if not found, set it to null. Return JSON only, schema: {"value":number|null,"source":string,"url":string,"as_of":string}`;
      const r = await callAI(sourceRuleText(state.company), prompt, { useWebSearch: true, maxTokens: 1000 }).catch(() => null);
      if (r && r.value != null) setNetDebtField(field, r.value);
      else missing.push(label);
    }
    setSt("netdebt", missing.length === 0 ? "All balance-sheet data fetched — verify each citation." : `Fetched with gaps — missing: ${missing.join(", ")}. Enter manually, or click again to retry.`, missing.length > 0, missing.length === 0);
    setBusyFlag("netdebt", false);
  }

  /* ---------------- AI: segment detection + financials ---------------- */
  function looksLikeDefaultSegments() {
    if (state.segments.length === 0) return true;
    return state.segments.every((s) => /^Segment \d+$/.test(s.name) && s.priorSales == null && s.currentSales == null && s.currentOI == null);
  }
  async function detectSegments() {
    if (!state.company.name) { alert("Enter a company name on the Company Setup tab first."); return; }
    if (!requireKey()) return;
    const hasData = state.segments.some((s) => s.priorSales != null || s.currentSales != null || s.currentOI != null);
    if (hasData && !window.confirm("This will replace your current segment list with the segments found in the filing. Any data already entered will be lost. Continue?")) return;
    setBusyFlag("segments", true);
    setSt("segments", "Identifying reportable segments from the latest annual filing…");
    const prompt = `Company: ${state.company.name} (Ticker: ${state.company.ticker}). Data as-of date: ${asOfDateLabel(state.company)}. List this company's current reportable business/operating segments exactly as named and ordered in the segment-reporting footnote of its MOST RECENT ANNUAL filing filed with ${effectiveJurisdiction(state.company) || "its home market's regulator"} as of that date. Do not include "Corporate"/"Eliminations"/"Unallocated" unless the filing itself presents it as a reportable segment. Return JSON only, schema: {"segments":["string"],"source":"string","url":"string","as_of":"string"}`;
    const result = await callAI(sourceRuleText(state.company), prompt, { useWebSearch: true, maxTokens: 1000 }).catch(() => null);
    const names = (result && Array.isArray(result.segments)) ? result.segments.map((x) => (typeof x === "string" ? x : x && x.name)).filter(Boolean) : [];
    if (names.length === 0) {
      setSt("segments", "Could not detect segment names from a permitted source — add them manually with \"+ Add Segment\" instead.", true);
      setBusyFlag("segments", false);
      return;
    }
    replaceSegments(names);
    const srcNote = result.source ? `${result.source}${result.as_of ? " · " + result.as_of : ""}` : "";
    setSt("segments", `Detected ${names.length} segment(s)${srcNote ? " from " + srcNote : ""} — verify names against the filing, then fetch financials.`, false, true);
    setBusyFlag("segments", false);
  }
  async function fetchAllSegmentFinancials() {
    if (!state.company.name) { alert("Enter a company name on the Company Setup tab first."); return; }
    if (state.segments.length === 0) { alert("Add at least one segment first."); return; }
    if (!requireKey()) return;
    setBusyFlag("segments", true);
    const pm = state.profitMetric;
    const metricInstruction = pm === "EBITDA"
      ? "current-year segment EBITDA (segment operating income plus segment depreciation & amortization, as disclosed or directly derivable from the same annual filing's segment footnote — if D&A is not broken out by segment there, return null rather than estimating)"
      : "current-year segment operating income (the CODM profitability measure disclosed in the segment footnote, not consolidated GAAP operating income)";
    const annualOnlyRule = `Use ONLY the segment-reporting footnote table in the company's MOST RECENT ANNUAL filing as of ${asOfDateLabel(state.company)} — do NOT cross-reference quarterly releases and do NOT derive the annual figure by adding up quarters. If the exact annual figures aren't directly visible, set that value to null.`;
    const missing = [];
    for (const s of state.segments) {
      const needsSales = s.priorSales == null || s.currentSales == null;
      const needsMetric = s.currentOI == null;
      if (!needsSales && !needsMetric) continue;
      if (needsSales) {
        setSt("segments", `Fetching "${s.name}" segment sales…`);
        const promptA = `Company: ${state.company.name} (Ticker: ${state.company.ticker}). Business segment name: "${s.name}". Fiscal period: ${state.company.fy} (current year) vs. prior year.
${annualOnlyRule}
Find only: this segment's prior-year sales/revenue and current-year sales/revenue, both from that one annual filing's segment table. Values in ${state.company.currency} millions. Return JSON only, schema: {"prior_year_sales":{"value":number|null,"source":string,"url":string,"as_of":string},"current_year_sales":{"value":number|null,"source":string,"url":string,"as_of":string}}`;
        const rA = await callAI(sourceRuleText(state.company), promptA, { useWebSearch: true, maxTokens: 1000 }).catch(() => null);
        if (rA) {
          if (rA.prior_year_sales && rA.prior_year_sales.value != null) { updateSegment(s.id, "priorSales", rA.prior_year_sales.value); setSegSrc(s.id, "priorSales", rA.prior_year_sales); }
          if (rA.current_year_sales && rA.current_year_sales.value != null) { updateSegment(s.id, "currentSales", rA.current_year_sales.value); setSegSrc(s.id, "currentSales", rA.current_year_sales); }
        }
      }
      if (needsMetric) {
        setSt("segments", `Fetching "${s.name}" ${metricAbbr(pm)}…`);
        const metricKey = pm === "EBITDA" ? "current_year_ebitda" : "current_year_operating_income";
        const promptB = `Company: ${state.company.name} (Ticker: ${state.company.ticker}). Business segment name: "${s.name}". Fiscal period: ${state.company.fy}.
${annualOnlyRule}
Find only this segment's ${metricInstruction}, from that same annual filing's segment table. Values in ${state.company.currency} millions. Return JSON only, schema: {"${metricKey}":{"value":number|null,"source":string,"url":string,"as_of":string}}`;
        const rB = await callAI(sourceRuleText(state.company), promptB, { useWebSearch: true, maxTokens: 1000 }).catch(() => null);
        if (rB && rB[metricKey] && rB[metricKey].value != null) { updateSegment(s.id, "currentOI", rB[metricKey].value); setSegSrc(s.id, "currentOI", rB[metricKey]); }
      }
    }
    setState((p) => {
      p.segments.forEach((s) => {
        const gaps = [];
        if (s.priorSales == null) gaps.push("prior sales");
        if (s.currentSales == null) gaps.push("current sales");
        if (s.currentOI == null) gaps.push(metricAbbr(pm));
        if (gaps.length) missing.push(`${s.name} (${gaps.join(", ")})`);
      });
      return p;
    });
    setSt("segments", missing.length === 0 ? "All segments fully fetched — verify each citation." : `Fetched with gaps — missing: ${missing.join("; ")}. Fill in manually or retry.`, missing.length > 0, missing.length === 0);
    setBusyFlag("segments", false);
  }

  /* ---------------- AI: peer multiples ---------------- */
  async function fetchPeerMultiples(segId) {
    const s = state.segments.find((x) => x.id === segId);
    const tickers = (peerTickers[segId] || "").split(",").map((t) => t.trim()).filter(Boolean);
    if (tickers.length === 0) { alert("Enter at least one peer ticker first."); return; }
    if (!requireKey()) return;
    setBusyFlag("peer_" + segId, true);
    const pm = state.profitMetric;
    const metricKey = pm === "EBITDA" ? "ebitda_ttm_or_fy" : "operating_income_ttm_or_fy";
    const metricPhrase = pm === "EBITDA" ? "trailing-twelve-month or FY EBITDA (operating income + D&A)" : "trailing-twelve-month or FY operating income";
    const peerResults = [];
    for (const t of tickers) {
      setPeerStatus((p) => ({ ...p, [segId]: { text: `Sourcing ${t} — market data…` } }));
      const promptA = `Peer company ticker: ${t}. This is a comparable company for peer trading-multiple purposes (industry peer of ${state.company.name}).
Only use this peer's own official investor-relations site and its home-market official regulator/exchange filing system.
Find only these four figures: current share price, diluted shares outstanding (mm), total debt, and cash & equivalents, in the peer's own reporting currency.
${sharePriceSourcingHint("this peer company")}
Return JSON only, schema: {"share_price":number|null,"shares_out_mm":number|null,"total_debt":number|null,"cash":number|null,"source":string,"url":string,"as_of":string}`;
      const rA = await callAI(sourceRuleText(state.company), promptA, { useWebSearch: true, maxTokens: 1000 }).catch(() => null);

      setPeerStatus((p) => ({ ...p, [segId]: { text: `Sourcing ${t} — income statement…` } }));
      const promptB = `Peer company ticker: ${t}. Same sourcing restrictions as before (this peer's own IR site + home-market official filing system only).
Find only these two figures: most recent full-year or trailing-twelve-month revenue, and ${metricPhrase}, in the peer's own reporting currency. Return JSON only, schema: {"revenue_ttm_or_fy":number|null,"${metricKey}":number|null,"source":string,"url":string,"as_of":string}`;
      const rB = await callAI(sourceRuleText(state.company), promptB, { useWebSearch: true, maxTokens: 1000 }).catch(() => null);

      if (rA && rA.share_price != null) {
        const ev = rA.share_price * (rA.shares_out_mm || 0) + (rA.total_debt || 0) - (rA.cash || 0);
        const rev = rB ? rB.revenue_ttm_or_fy : null;
        const metricVal = rB ? rB[metricKey] : null;
        const evSales = rev ? ev / rev : null;
        const evOI = metricVal ? ev / metricVal : null;
        const combinedSource = [rA.source, rB && rB.source].filter(Boolean).join(" · ");
        peerResults.push({ ticker: t, ev, evSales, evOI, source: combinedSource || rA.source, url: rA.url, as_of: rA.as_of });
      } else {
        peerResults.push({ ticker: t, ev: null, evSales: null, evOI: null, source: "not found from permitted sources", url: "", as_of: "" });
      }
    }
    updateMultiple(segId, "peers", peerResults);
    const validSales = peerResults.map((p) => p.evSales).filter((v) => v != null).sort((a, b) => a - b);
    const validOI = peerResults.map((p) => p.evOI).filter((v) => v != null).sort((a, b) => a - b);
    if (validSales.length) {
      updateMultiple(segId, "evSalesLow", +percentile(validSales, 25).toFixed(2));
      updateMultiple(segId, "evSalesHigh", +percentile(validSales, 75).toFixed(2));
    }
    if (validOI.length) {
      updateMultiple(segId, "evOILow", +percentile(validOI, 25).toFixed(1));
      updateMultiple(segId, "evOIHigh", +percentile(validOI, 75).toFixed(1));
    }
    setPeerStatus((p) => ({ ...p, [segId]: { text: "Peer multiples sourced — verify each citation before relying on them.", ok: true } }));
    setBusyFlag("peer_" + segId, false);
  }

  /* ---------------- one-click extraction ---------------- */
  async function extractEverything() {
    if (!state.company.name) { alert("Enter a company name on the Company Setup tab first."); return; }
    if (!requireKey()) return;
    setBusyFlag("master", true);
    const log = [];
    const push = (msg) => { log.push(msg); setMasterLog([...log]); };
    setSt("master", "Step 1 of 4 — market data…");
    push("▸ Fetching market data (share price, shares outstanding)…");
    await fetchMarketData();
    push("✓ Market data step complete.");

    setSt("master", "Step 2 of 4 — net debt / balance sheet…");
    push("▸ Fetching net debt / balance-sheet data…");
    await fetchNetDebtData();
    push("✓ Net debt step complete.");

    if (looksLikeDefaultSegments()) {
      setSt("master", "Step 3 of 4 — detecting segments…");
      push("▸ Detecting reportable segments from the latest annual filing…");
      await detectSegments();
      push("✓ Segment names detected.");
    } else {
      push("▸ Keeping your existing segment list (already has custom names or data) — skipped auto-detection.");
    }

    if (state.segments.length > 0) {
      setSt("master", "Step 4 of 4 — segment financials…");
      push(`▸ Fetching segment financials for ${state.segments.length} segment(s)…`);
      await fetchAllSegmentFinancials();
      push("✓ Segment financials step complete.");
    }

    setSt("master", "Done — review each tab and verify citations.", false, true);
    push("<b>All done.</b> Peer trading multiples (Multiples tab) still need peer tickers from you per segment before you Calculate — that step needs your judgment on which peers to use.");
    setBusyFlag("master", false);
  }

  /* ---------------- calculate / export ---------------- */
  function calculate() {
    if (state.segments.length === 0) { alert("Add segments and populate data first."); return; }
    const snapshot = JSON.parse(JSON.stringify(state));
    const sotp = computeSOTP(snapshot);
    setDashboard({ state: snapshot, sotp });
    setTab("results");
  }
  function exportCSV() {
    if (!dashboard) return;
    const { state: s } = dashboard;
    const lines = [`Sum-of-the-Parts Valuation — ${s.company.name} (${s.company.ticker})`, ""];
    lines.push(`Segment,Sales,Segment ${metricAbbr(s.profitMetric)},EV/Sales Low,EV/Sales High,EV/${metricAbbr(s.profitMetric)} Low,EV/${metricAbbr(s.profitMetric)} High`);
    s.segments.forEach((seg) => {
      const m = s.multiples[seg.id] || {};
      lines.push(`${seg.name},${seg.currentSales || ""},${seg.currentOI || ""},${m.evSalesLow || ""},${m.evSalesHigh || ""},${m.evOILow || ""},${m.evOIHigh || ""}`);
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${s.company.ticker || "SOTP"}_sotp_inputs.csv`.replace(/[^a-z0-9._-]/gi, "_");
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function exportExcel() {
    if (!dashboard) return;
    try {
      setExportError("");
      const bytes = buildSotpWorkbook({ ...dashboard.state, sotp: dashboard.sotp });
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `SOTP-${dashboard.state.company.name || "Valuation"}.xlsx`.replace(/[^a-z0-9.-]/gi, "_");
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError("The workbook could not be built: " + ((e && e.message) || String(e)));
    }
  }

  const c = state.company;
  const pm = state.profitMetric;
  const bridgePreview = computeBridge(state.market, state.netDebt);

  const TABS = [
    ["setup", "1 · Company Setup"],
    ["market", "2 · Market & Net Debt"],
    ["segments", "3 · Segment Financials"],
    ["multiples", "4 · Peer Multiples"],
    ["results", "5 · SOTP Results"],
  ];

  return (
    <div style={{ background: INK, minHeight: "100vh", color: TEXT, fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif" }}>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "36px 22px 90px" }}>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginBottom: 22 }}>
          <div>
            <Eyebrow color={AMBER}>Corporate valuation desk</Eyebrow>
            <h1 style={{ ...serif, fontWeight: 700, fontSize: 34, margin: "8px 0 6px", lineHeight: 1.05, letterSpacing: -0.5 }}>
              SOTP <span style={{ color: AMBER, fontStyle: "italic" }}>Valuation Builder</span>
            </h1>
            <p style={{ color: MUTED, fontSize: 14.5, maxWidth: 620, margin: 0, lineHeight: 1.55 }}>
              Segment-level EV/Sales &amp; EV/{metricAbbr(pm)} build → bridge to implied equity value per share. AI sourcing is restricted to the company's own IR site and its official regulator/exchange filing system.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ border: `1px solid ${LINE}`, borderRadius: 20, padding: "6px 13px", ...mono, fontSize: 10, letterSpacing: 1, color: MUTED, whiteSpace: "nowrap" }}>
              {c.name ? (c.ticker ? `${c.name} (${c.ticker})` : c.name).toUpperCase() : "NO COMPANY SET"}
            </div>
            <button onClick={() => setShowKeyPanel(true)} style={ghostBtn}>
              <KeyRound size={13} /> {hasKey ? `${PROVIDERS[provider].short} key set` : "Add AI key"}
            </button>
          </div>
        </div>

        {showKeyPanel && <ApiKeyPanel onChange={refreshKeyState} onClose={() => setShowKeyPanel(false)} />}

        <div style={{ display: "flex", gap: 6, marginBottom: 24, flexWrap: "wrap" }}>
          {TABS.map(([id, label]) => {
            const on = tab === id;
            return (
              <button key={id} onClick={() => setTab(id)} style={{
                ...mono, fontSize: 11.5, fontWeight: 700, padding: "8px 15px", borderRadius: 20, cursor: "pointer",
                background: on ? AMBER : "transparent", color: on ? "#fff" : MUTED, border: `1px solid ${on ? AMBER : LINE}`,
              }}>{label}</button>
            );
          })}
        </div>

        {tab === "setup" && (
          <>
            <Panel style={{ marginBottom: 24 }}>
              <Eyebrow color={AMBER}>Company &amp; jurisdiction</Eyebrow>
              <div style={{ fontSize: 12.5, color: MUTED, margin: "6px 0 16px" }}>This determines which primary filing system the AI sourcing assistant is restricted to.</div>
              <div className="sotp-grid4">
                <TextField label="Company Name" help="Enter the company's full legal or commonly-used name, as it appears on its own investor-relations site — this is what the AI searches with to find the right IR site and filings." value={c.name} onChange={(v) => setCompany("name", v)} placeholder="e.g. Example Industries Inc." />
                <TextField label="Ticker" help="Enter the stock ticker symbol, e.g. NOC, AAPL. Helps the AI (and you) confirm it has the right company and exchange listing." value={c.ticker} onChange={(v) => setCompany("ticker", v)} placeholder="e.g. EXI" />
                <TextField label="Primary Exchange" help="Enter where the shares are listed, e.g. NYSE, NASDAQ, LSE, NSE, BSE. Used for the share-price fallback source." value={c.exchange} onChange={(v) => setCompany("exchange", v)} placeholder="e.g. NYSE" />
                <TextField label="Currency" help="Enter the company's reporting currency code, e.g. USD, INR, GBP, EUR. Every dollar figure you enter anywhere in this tool should be in this currency." value={c.currency} onChange={(v) => setCompany("currency", v)} placeholder="USD, INR, GBP…" />
                <TextField label="Fiscal Year End Being Valued" help="Enter the fiscal year you're valuing, e.g. FY2025. Tells the AI which annual filing's segment table to use as the &quot;current year&quot; for segment data." value={c.fy} onChange={(v) => setCompany("fy", v)} placeholder="e.g. FY2025" />
                <TextField label="Data As-Of Date" value={c.asOfDate} onChange={(v) => setCompany("asOfDate", v)} type="date" />
                <SelectField label="Jurisdiction (primary filing system)" help="Select the country/market where the company primarily files financial reports. This restricts AI sourcing to that jurisdiction's official regulator or exchange filing system — never third-party aggregators." value={c.jurisdiction} onChange={(v) => setCompany("jurisdiction", v)} options={JURISDICTIONS} />
                {c.jurisdiction === "OTHER" && (
                  <TextField label="Other filing system" value={c.otherJur} onChange={(v) => setCompany("otherJur", v)} placeholder="Name the official regulator/exchange filing portal" />
                )}
              </div>
              <div style={{ fontSize: 11.5, color: MUTED, background: INK, border: `1px dashed ${LINE}`, padding: "10px 12px", borderRadius: 7, marginTop: 16, lineHeight: 1.5 }}>
                AI sourcing is instructed to use only the company's own investor-relations site plus this official regulator/exchange filing system — never aggregators, screeners, broker notes, or news articles.
              </div>
              <div style={{ marginTop: 16 }}>
                <button onClick={() => { if (state.segments.length === 0) { addSegment(); addSegment(); } setTab("market"); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, background: GOLD, color: "#fff", border: "none", borderRadius: 8, padding: "11px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                  Save &amp; Continue →
                </button>
              </div>
            </Panel>

            <Panel style={{ marginBottom: 24, borderColor: TEAL }}>
              <Eyebrow color={TEAL}>One-click AI extraction</Eyebrow>
              <div style={{ fontSize: 12.5, color: MUTED, margin: "6px 0 14px" }}>Runs market data, net debt, segment detection, and segment financials in sequence. (Peer trading multiples still need peer tickers from you on the Multiples tab.)</div>
              <button onClick={extractEverything} disabled={busy.master} style={{ display: "flex", alignItems: "center", gap: 8, background: busy.master ? PANEL2 : GOLD, color: busy.master ? MUTED : "#fff", border: "none", borderRadius: 8, padding: "11px 18px", fontSize: 13, fontWeight: 700, cursor: busy.master ? "wait" : "pointer" }}>
                {busy.master ? <Loader2 size={14} className="spin" /> : <Rocket size={14} />} Extract Everything with AI
              </button>
              <StatusMsg status={status.master} />
              {masterLog.length > 0 && (
                <div style={{ fontSize: 11.5, color: MUTED, marginTop: 10, lineHeight: 1.8 }}>
                  {masterLog.map((l, i) => <div key={i} dangerouslySetInnerHTML={{ __html: l }} />)}
                </div>
              )}
            </Panel>

            <Panel>
              <Eyebrow color={AMBER}>How this tool works</Eyebrow>
              <div style={{ fontSize: 12.5, color: MUTED, margin: "6px 0 12px" }}>Every numeric input across this tool can be filled in two ways, toggled independently per section:</div>
              <div className="sotp-grid2">
                <div><b style={{ color: AMBER }}>AI-assisted</b><p style={{ color: MUTED, fontSize: 12.5, lineHeight: 1.5 }}>The AI runs live web searches restricted to your company's IR site and the official exchange/regulator filing system you selected. Every value returned comes with a source name, URL, and as-of date so you can verify it before relying on it.</p></div>
                <div><b style={{ color: AMBER }}>Manual</b><p style={{ color: MUTED, fontSize: 12.5, lineHeight: 1.5 }}>Type the figures in yourself from a filing you already have open.</p></div>
              </div>
            </Panel>
          </>
        )}

        {tab === "market" && (
          <>
            <Panel style={{ marginBottom: 24 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
                <div><Eyebrow color={AMBER}>Market data</Eyebrow><div style={{ fontSize: 12.5, color: MUTED, marginTop: 4 }}>Current share price, shares outstanding, resulting market capitalization.</div></div>
                <ModeToggle mode={modes.market} onChange={(m) => setModes((mm) => ({ ...mm, market: m }))} />
              </div>
              {modes.market === "ai" && (
                <div style={{ marginBottom: 14 }}>
                  <button onClick={fetchMarketData} disabled={busy.market} style={{ display: "flex", alignItems: "center", gap: 8, background: busy.market ? PANEL2 : AMBER, color: "#fff", border: "none", borderRadius: 8, padding: "10px 16px", fontSize: 12.5, fontWeight: 700, cursor: busy.market ? "wait" : "pointer" }}>
                    {busy.market ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />} Fetch market data
                  </button>
                  <StatusMsg status={status.market} />
                </div>
              )}
              <div className="sotp-grid3">
                <div>
                  <NumField label="Current Share Price" help="Enter the most recent closing share price. Find it on the company's IR &quot;Stock Quote&quot; page, the primary exchange's own quote page, or a recent insider-transaction filing." value={state.market.sharePrice} onChange={(v) => setMarket("sharePrice", v)} suffix={c.currency} />
                  <SrcNote src={state.market.src && state.market.src.sharePrice} />
                </div>
                <NumField label="Basic Shares O/S (mm)" help="Enter basic (undiluted) shares outstanding, in millions. Find it on the cover page of the most recent 10-Q/10-K or annual report." value={state.market.basicSharesMM} onChange={(v) => setMarket("basicSharesMM", v)} />
                <NumField label="Diluted Shares O/S (mm)" help="Enter weighted-average diluted shares outstanding, in millions. Find it in the EPS footnote or the most recent earnings release." value={state.market.dilutedSharesMM} onChange={(v) => setMarket("dilutedSharesMM", v)} />
              </div>
            </Panel>

            <Panel style={{ marginBottom: 24 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
                <div><Eyebrow color={AMBER}>Net debt / (net cash) bridge</Eyebrow><div style={{ fontSize: 12.5, color: MUTED, marginTop: 4 }}>From the most recently filed consolidated balance sheet.</div></div>
                <ModeToggle mode={modes.netdebt} onChange={(m) => setModes((mm) => ({ ...mm, netdebt: m }))} />
              </div>
              {modes.netdebt === "ai" && (
                <div style={{ marginBottom: 14 }}>
                  <button onClick={fetchNetDebtData} disabled={busy.netdebt} style={{ display: "flex", alignItems: "center", gap: 8, background: busy.netdebt ? PANEL2 : AMBER, color: "#fff", border: "none", borderRadius: 8, padding: "10px 16px", fontSize: 12.5, fontWeight: 700, cursor: busy.netdebt ? "wait" : "pointer" }}>
                    {busy.netdebt ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />} Fetch balance-sheet data
                  </button>
                  <StatusMsg status={status.netdebt} />
                </div>
              )}
              <div className="sotp-grid3">
                <NumField label="Current Portion LT Debt" help="Enter from the balance sheet's &quot;Current portion of long-term debt&quot; line, in millions. Enter 0 if not presented separately." value={state.netDebt.currentDebt} onChange={(v) => setNetDebtField("currentDebt", v)} />
                <NumField label="LT Debt, Net of Current" help="Enter from the balance sheet's non-current &quot;Long-term debt&quot; line, in millions." value={state.netDebt.ltDebt} onChange={(v) => setNetDebtField("ltDebt", v)} />
                <NumField label="Cash & Equivalents" help="Enter from the balance sheet's &quot;Cash and cash equivalents&quot; line, in millions." value={state.netDebt.cash} onChange={(v) => setNetDebtField("cash", v)} />
                <NumField label="Pension/OPB Liabilities" help="Enter non-current pension and other post-employment benefit plan liabilities, in millions. Enter 0 if none." value={state.netDebt.pensionLiab} onChange={(v) => setNetDebtField("pensionLiab", v)} />
                <NumField label="Pension/OPB Assets" help="Enter non-current pension/OPB plan assets (overfunded plans), in millions. Enter 0 if none." value={state.netDebt.pensionAsset} onChange={(v) => setNetDebtField("pensionAsset", v)} />
                <NumField label="Noncontrolling Interests" help="Enter noncontrolling (minority) interests from the equity section, in millions. Enter 0 if not applicable." value={state.netDebt.nci} onChange={(v) => setNetDebtField("nci", v)} />
                <NumField label="Other Adjustments (+/-)" help="Manual only — any other item to add to or subtract from net debt, e.g. capitalized operating leases. Positive adds to net debt, negative reduces it." value={state.netDebt.other} onChange={(v) => setNetDebtField("other", v)} />
              </div>
              <div style={{ marginTop: 16 }}>
                <KV k="Total Debt" v={fmt(computeNetDebt(state.netDebt).totalDebt, c.currency)} />
                <KV k="Net Debt / (Net Cash)" v={fmt(computeNetDebt(state.netDebt).netDebt, c.currency)} />
                <KV k="Current Market Capitalization" v={fmt(bridgePreview.mktCap, c.currency)} />
                <KV k="Implied Current Enterprise Value" v={fmt(bridgePreview.currentEV, c.currency)} total />
              </div>
            </Panel>
          </>
        )}

        {tab === "segments" && (
          <Panel style={{ marginBottom: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 6 }}>
              <div><Eyebrow color={AMBER}>Business segments</Eyebrow><div style={{ fontSize: 12.5, color: MUTED, marginTop: 4 }}>Segment sales &amp; segment {metricLabel(pm)}, per the segment-reporting footnote.</div></div>
              <ModeToggle mode={modes.segments} onChange={(m) => setModes((mm) => ({ ...mm, segments: m }))} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "10px 0 4px" }}>
              <span style={{ fontSize: 12, color: MUTED }}>Profitability metric:</span>
              <div style={{ display: "flex", border: `1px solid ${LINE}`, borderRadius: 20, overflow: "hidden" }}>
                {["OI", "EBITDA"].map((m) => (
                  <button key={m} onClick={() => setState((p) => ({ ...p, profitMetric: m }))} style={{
                    border: "none", background: pm === m ? TEAL : "transparent", color: pm === m ? "#fff" : MUTED,
                    padding: "6px 13px", fontSize: 11.5, fontWeight: 700, cursor: "pointer",
                  }}>{m === "OI" ? "Operating Income" : "EBITDA"}</button>
                ))}
              </div>
            </div>
            <div style={{ fontSize: 11, color: FAINT, margin: "6px 0 14px" }}>EBITDA = segment operating income + segment depreciation &amp; amortization. If not disclosed by segment, the AI returns null rather than estimate.</div>
            {modes.segments === "ai" && (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
                <button onClick={detectSegments} disabled={busy.segments} style={ghostBtn}><Wand2 size={13} /> Detect segment names</button>
                <button onClick={fetchAllSegmentFinancials} disabled={busy.segments} style={{ display: "flex", alignItems: "center", gap: 8, background: busy.segments ? PANEL2 : AMBER, color: "#fff", border: "none", borderRadius: 8, padding: "9px 16px", fontSize: 12.5, fontWeight: 700, cursor: busy.segments ? "wait" : "pointer" }}>
                  {busy.segments ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />} Fetch financials for all segments
                </button>
              </div>
            )}
            <StatusMsg status={status.segments} />
            <div style={{ marginTop: 12 }}>
              {state.segments.map((s) => (
                <div key={s.id} style={{ background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, padding: 16, marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <input value={s.name} onChange={(e) => updateSegment(s.id, "name", e.target.value)}
                      style={{ ...serif, fontWeight: 600, fontSize: 15, border: "none", borderBottom: `2px solid ${LINE}`, padding: "2px 0", background: "transparent", color: TEXT, minWidth: 180 }} />
                    <button onClick={() => removeSegment(s.id)} title="Remove segment" style={{ background: "none", border: "none", color: RED, fontSize: 16, cursor: "pointer" }}><Trash2 size={15} /></button>
                  </div>
                  <div className="sotp-grid5">
                    <div>
                      <NumField label="Prior-Year Sales" help={`This segment's prior fiscal year sales/revenue, from the segment footnote, in ${c.currency || "reporting currency"} millions.`} value={s.priorSales} onChange={(v) => updateSegment(s.id, "priorSales", v)} />
                      <SrcNote src={s.src.priorSales} />
                    </div>
                    <div>
                      <NumField label="Current-Year Sales" help={`This segment's current fiscal year sales/revenue, in ${c.currency || "reporting currency"} millions.`} value={s.currentSales} onChange={(v) => updateSegment(s.id, "currentSales", v)} />
                      <SrcNote src={s.src.currentSales} />
                    </div>
                    <div>
                      <NumField label={`Current-Year Segment ${metricAbbr(pm)}`} help={`This segment's current-year ${metricLabel(pm)}, the profitability measure the CODM uses to evaluate this segment, in ${c.currency || "reporting currency"} millions.`} value={s.currentOI} onChange={(v) => updateSegment(s.id, "currentOI", v)} />
                      <SrcNote src={s.src.currentOI} />
                    </div>
                    <NumField label="Next-Yr Guidance (Low)" help="Optional: low end of management's next-year sales guidance for this segment." value={s.guideLow} onChange={(v) => updateSegment(s.id, "guideLow", v)} />
                    <NumField label="Next-Yr Guidance (High)" help="Optional: high end of that same guidance range." value={s.guideHigh} onChange={(v) => updateSegment(s.id, "guideHigh", v)} />
                  </div>
                </div>
              ))}
            </div>
            <button onClick={() => addSegment()} style={{ border: `1px dashed ${TEAL}`, background: "none", color: TEAL, fontWeight: 700, padding: "9px 16px", borderRadius: 7, cursor: "pointer", fontSize: 12.5, display: "flex", alignItems: "center", gap: 6 }}>
              <Plus size={14} /> Add Segment
            </button>
          </Panel>
        )}

        {tab === "multiples" && (
          <Panel style={{ marginBottom: 24 }}>
            <Eyebrow color={AMBER}>Peer trading-multiple assumptions</Eyebrow>
            <div style={{ fontSize: 12.5, color: MUTED, margin: "6px 0 14px" }}>25th–75th percentile EV/Sales and EV/{metricLabel(pm)} multiples per segment, from a peer trading-comps set. AI sourcing fetches each named peer's own filings + exchange price — not a screener's pre-built multiple.</div>
            <div style={{ background: "linear-gradient(135deg,#F6F2E7,#EFE6C8)", borderRadius: 7, padding: "12px 16px", fontSize: 12.5, marginBottom: 18, color: "#4a3f1a" }}>
              <b>Tip:</b> for a fully rigorous peer set, pair this with a dedicated comps workflow. This AI helper is a fast, sourced first pass — always sanity-check before relying on it.
            </div>
            {state.segments.map((s) => {
              const m = state.multiples[s.id] || {};
              return (
                <div key={s.id} style={{ background: PANEL2, border: `1px solid ${LINE}`, borderRadius: 8, padding: 16, marginBottom: 14 }}>
                  <div style={{ ...serif, fontWeight: 600, fontSize: 15, color: AMBER, marginBottom: 10 }}>{s.name}</div>
                  <div className="sotp-grid4">
                    <NumField label="25th %ile EV/Sales" help="Low (25th percentile) EV/Sales trading multiple from a peer set, e.g. 1.6x." value={m.evSalesLow} onChange={(v) => updateMultiple(s.id, "evSalesLow", v)} suffix="x" />
                    <NumField label="75th %ile EV/Sales" help="High (75th percentile) EV/Sales multiple from the same peer set, e.g. 2.2x." value={m.evSalesHigh} onChange={(v) => updateMultiple(s.id, "evSalesHigh", v)} suffix="x" />
                    <NumField label={`25th %ile EV/${metricAbbr(pm)}`} help={`Low (25th percentile) EV/${metricLabel(pm)} multiple from the same peer set.`} value={m.evOILow} onChange={(v) => updateMultiple(s.id, "evOILow", v)} suffix="x" />
                    <NumField label={`75th %ile EV/${metricAbbr(pm)}`} help={`High (75th percentile) EV/${metricLabel(pm)} multiple from the same peer set.`} value={m.evOIHigh} onChange={(v) => updateMultiple(s.id, "evOIHigh", v)} suffix="x" />
                  </div>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
                    <input value={peerTickers[s.id] || ""} onChange={(e) => setPeerTickers((p) => ({ ...p, [s.id]: e.target.value }))}
                      placeholder="Peer tickers, comma-separated (e.g. PEER1, PEER2)"
                      style={{ maxWidth: 380, flex: 1, background: INK, border: `1px solid ${LINE}`, borderRadius: 7, padding: "8px 10px", color: TEXT, fontSize: 12.5, outline: "none" }} />
                    <button onClick={() => fetchPeerMultiples(s.id)} disabled={busy["peer_" + s.id]} style={ghostBtn}>
                      {busy["peer_" + s.id] ? <Loader2 size={13} className="spin" /> : <Wand2 size={13} />} AI: source peer multiples
                    </button>
                  </div>
                  <StatusMsg status={peerStatus[s.id]} />
                  {(m.peers || []).length > 0 && (
                    <div style={{ overflowX: "auto", marginTop: 10 }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                        <thead><tr>
                          {["Peer", "Implied EV", "EV/Sales", `EV/${metricAbbr(pm)}`, "Source"].map((h) => (
                            <th key={h} style={{ textAlign: h === "Source" ? "left" : "right", padding: "6px 8px", borderBottom: `1px solid ${TEXT}`, color: MUTED, fontSize: 10.5, textTransform: "uppercase" }}>{h}</th>
                          ))}
                        </tr></thead>
                        <tbody>
                          {m.peers.map((p, i) => (
                            <tr key={i}>
                              <td style={{ padding: "6px 8px", borderBottom: `1px solid ${LINE}`, fontWeight: 600 }}>{p.ticker}</td>
                              <td style={{ padding: "6px 8px", borderBottom: `1px solid ${LINE}`, textAlign: "right", ...mono }}>{p.ev != null ? fmtNum(p.ev) : "—"}</td>
                              <td style={{ padding: "6px 8px", borderBottom: `1px solid ${LINE}`, textAlign: "right", ...mono }}>{p.evSales != null ? p.evSales.toFixed(2) + "x" : "—"}</td>
                              <td style={{ padding: "6px 8px", borderBottom: `1px solid ${LINE}`, textAlign: "right", ...mono }}>{p.evOI != null ? p.evOI.toFixed(1) + "x" : "—"}</td>
                              <td style={{ padding: "6px 8px", borderBottom: `1px solid ${LINE}`, fontSize: 10.5, color: FAINT }}>{p.source || ""} {p.url && <a href={p.url} target="_blank" rel="noopener noreferrer" style={{ color: TEAL }}>↗</a>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div style={{ fontSize: 10.5, color: FAINT, marginTop: 6 }}>25th/75th percentile computed locally from the peers above and written into the multiple fields — review and adjust as needed.</div>
                    </div>
                  )}
                </div>
              );
            })}
          </Panel>
        )}

        {tab === "results" && (
          <>
            <Panel style={{ marginBottom: 24 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
                <Eyebrow color={AMBER}>Sum-of-the-parts valuation</Eyebrow>
                <button onClick={calculate} style={{ display: "flex", alignItems: "center", gap: 8, background: AMBER, color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                  <Play size={14} /> {dashboard ? "Recalculate" : "Calculate"}
                </button>
              </div>
              <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>Run this after populating the Market, Segments, and Multiples tabs.</div>
            </Panel>

            {!dashboard && (
              <Panel><div style={{ fontSize: 13, color: MUTED, display: "flex", alignItems: "center", gap: 8 }}><AlertTriangle size={15} color={GOLD} /> Nothing calculated yet — click Calculate above.</div></Panel>
            )}

            {dashboard && (() => {
              const { state: ds, sotp } = dashboard;
              const midPrice = (sotp.priceLow != null && sotp.priceHigh != null) ? (sotp.priceLow + sotp.priceHigh) / 2 : null;
              const midPrem = (sotp.premLow != null && sotp.premHigh != null) ? (sotp.premLow + sotp.premHigh) / 2 : null;
              return (
                <>
                  <div className="sotp-hero" style={{ background: AMBER, color: "#fff", borderRadius: 10, padding: "24px 28px", marginBottom: 20, display: "flex", flexWrap: "wrap", gap: 28, justifyContent: "space-between" }}>
                    <div>
                      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, opacity: 0.8, marginBottom: 6 }}>Implied SOTP Share Price (Low–High)</div>
                      <div style={{ ...serif, fontSize: 26, fontWeight: 700 }}>{fmt(sotp.priceLow, ds.company.currency, 2)} – {fmt(sotp.priceHigh, ds.company.currency, 2)}</div>
                      {midPrem != null && (
                        <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 700, marginTop: 6, background: "rgba(255,255,255,0.18)" }}>
                          {midPrem >= 0 ? "+" : ""}{pctStr(midPrem)} vs. current
                        </span>
                      )}
                    </div>
                    <div><div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, opacity: 0.8, marginBottom: 6 }}>Current Share Price</div><div style={{ ...serif, fontSize: 26, fontWeight: 700 }}>{fmt(sotp.currentPrice, ds.company.currency, 2)}</div></div>
                    <div><div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, opacity: 0.8, marginBottom: 6 }}>Total SOTP Enterprise Value</div><div style={{ ...serif, fontSize: 26, fontWeight: 700 }}>{fmt(sotp.sotpEVLow, ds.company.currency)} – {fmt(sotp.sotpEVHigh, ds.company.currency)}</div></div>
                    <div><div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, opacity: 0.8, marginBottom: 6 }}>Current Market-Implied EV</div><div style={{ ...serif, fontSize: 26, fontWeight: 700 }}>{fmt(sotp.bridge.currentEV, ds.company.currency)}</div></div>
                  </div>

                  <Panel style={{ marginBottom: 24 }}>
                    <Eyebrow color={TEAL}>Implied segment enterprise value range</Eyebrow>
                    <div style={{ overflowX: "auto", marginTop: 10 }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 720 }}>
                        <thead><tr>
                          {["Segment", "Sales", metricShort(ds.profitMetric), "EV@Sales(25th)", "EV@Sales(75th)", `EV@${metricAbbr(ds.profitMetric)}(25th)`, `EV@${metricAbbr(ds.profitMetric)}(75th)`, "Blended EV Low", "Blended EV High"].map((h, i) => (
                            <th key={h} style={{ textAlign: i === 0 ? "left" : "right", padding: "6px 8px", borderBottom: `1px solid ${TEXT}`, color: MUTED, fontSize: 10, textTransform: "uppercase" }}>{h}</th>
                          ))}
                        </tr></thead>
                        <tbody>
                          {sotp.rows.map((r) => (
                            <tr key={r.id}>
                              <td style={{ padding: "6px 8px", borderBottom: `1px solid ${LINE}`, fontWeight: 600 }}>{r.name}</td>
                              <td style={{ padding: "6px 8px", borderBottom: `1px solid ${LINE}`, textAlign: "right", ...mono }}>{fmtNum(r.sales)}</td>
                              <td style={{ padding: "6px 8px", borderBottom: `1px solid ${LINE}`, textAlign: "right", ...mono }}>{fmtNum(r.oi)}</td>
                              <td style={{ padding: "6px 8px", borderBottom: `1px solid ${LINE}`, textAlign: "right", ...mono }}>{fmtNum(r.evSalesLow)}</td>
                              <td style={{ padding: "6px 8px", borderBottom: `1px solid ${LINE}`, textAlign: "right", ...mono }}>{fmtNum(r.evSalesHigh)}</td>
                              <td style={{ padding: "6px 8px", borderBottom: `1px solid ${LINE}`, textAlign: "right", ...mono }}>{fmtNum(r.evOILow)}</td>
                              <td style={{ padding: "6px 8px", borderBottom: `1px solid ${LINE}`, textAlign: "right", ...mono }}>{fmtNum(r.evOIHigh)}</td>
                              <td style={{ padding: "6px 8px", borderBottom: `1px solid ${LINE}`, textAlign: "right", ...mono, fontWeight: 700, color: AMBER }}>{fmtNum(r.blendLow)}</td>
                              <td style={{ padding: "6px 8px", borderBottom: `1px solid ${LINE}`, textAlign: "right", ...mono, fontWeight: 700, color: AMBER }}>{fmtNum(r.blendHigh)}</td>
                            </tr>
                          ))}
                          <tr style={{ borderTop: `2px solid ${TEXT}` }}>
                            <td style={{ padding: "8px", fontWeight: 700 }}>Total</td>
                            <td style={{ padding: "8px", textAlign: "right", ...mono, fontWeight: 700 }}>{fmtNum(sotp.totCurrentSales)}</td>
                            <td style={{ padding: "8px", textAlign: "right", ...mono, fontWeight: 700 }}>{fmtNum(sotp.totCurrentOI)}</td>
                            <td colSpan={4}></td>
                            <td style={{ padding: "8px", textAlign: "right", ...mono, fontWeight: 700, color: AMBER }}>{fmtNum(sotp.sotpEVLow)}</td>
                            <td style={{ padding: "8px", textAlign: "right", ...mono, fontWeight: 700, color: AMBER }}>{fmtNum(sotp.sotpEVHigh)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </Panel>

                  <Panel style={{ marginBottom: 24 }}>
                    <Eyebrow color={TEAL}>Bridge to implied equity value &amp; share price</Eyebrow>
                    <div style={{ marginTop: 10 }}>
                      <KV k="Total Segment Enterprise Value" v={`${fmt(sotp.sotpEVLow, ds.company.currency)}  –  ${fmt(sotp.sotpEVHigh, ds.company.currency)}`} />
                      <KV k="(-) Net Debt / (+) Net Cash" v={fmt(-sotp.bridge.netDebt, ds.company.currency)} />
                      <KV k="Implied SOTP Equity Value" v={`${fmt(sotp.equityLow, ds.company.currency)}  –  ${fmt(sotp.equityHigh, ds.company.currency)}`} total />
                      <KV k="÷ Diluted Shares Outstanding (mm)" v={fmtNum(sotp.dilutedShares, 1)} />
                      <KV k="Implied Share Price (SOTP)" v={`${fmt(sotp.priceLow, ds.company.currency, 2)}  –  ${fmt(sotp.priceHigh, ds.company.currency, 2)}`} total />
                      <KV k="Current Share Price" v={fmt(sotp.currentPrice, ds.company.currency, 2)} />
                      <KV k="Implied Premium / (Discount) to Current" v={`${pctStr(sotp.premLow)}  –  ${pctStr(sotp.premHigh)}`} />
                    </div>
                  </Panel>

                  <Panel style={{ marginBottom: 24 }}>
                    <Eyebrow color={TEAL}>Cross-check — SOTP EV vs. current market-implied EV</Eyebrow>
                    <div style={{ marginTop: 10 }}>
                      <KV k="Current Market-Implied Enterprise Value" v={fmt(sotp.bridge.currentEV, ds.company.currency)} />
                      <KV k="Total SOTP Enterprise Value" v={`${fmt(sotp.sotpEVLow, ds.company.currency)}  –  ${fmt(sotp.sotpEVHigh, ds.company.currency)}`} />
                      <KV k="Implied Conglomerate Discount / (Premium)" v={`${pctStr(sotp.discLow)}  –  ${pctStr(sotp.discHigh)}`} total />
                    </div>
                  </Panel>

                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
                    <button onClick={exportCSV} style={ghostBtn}><Download size={14} /> Export CSV</button>
                    <button onClick={exportExcel} style={{ display: "flex", alignItems: "center", gap: 8, background: AMBER, color: "#fff", border: "none", borderRadius: 8, padding: "11px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                      <FileSpreadsheet size={15} /> Download styled Excel workbook
                    </button>
                  </div>
                  {exportError && <div style={{ color: RED, fontSize: 12.5, marginTop: 10, textAlign: "right" }}>{exportError}</div>}
                </>
              );
            })()}
          </>
        )}

        <div style={{ textAlign: "center", paddingTop: 30, marginTop: 20, borderTop: `1px solid ${LINE}` }}>
          <div style={{ fontSize: 11.5, color: FAINT, lineHeight: 1.6, maxWidth: 660, margin: "0 auto 14px" }}>
            Built for iterative, per-company reuse. AI-sourced figures are informational and must be independently verified against the cited primary filing before use in any investment decision.
          </div>
          <span style={{ ...serif, fontSize: 15 }}>Build it. Stress it. <span style={{ color: AMBER, fontStyle: "italic" }}>Then decide.</span></span>
        </div>
      </div>

      <style>{`
        .sotp-grid4 { display:grid; grid-template-columns:repeat(4,1fr); gap:12px 16px; }
        .sotp-grid3 { display:grid; grid-template-columns:repeat(3,1fr); gap:12px 16px; }
        .sotp-grid5 { display:grid; grid-template-columns:repeat(5,1fr); gap:12px 16px; }
        .sotp-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
        @media (max-width:900px) { .sotp-grid4, .sotp-grid5 { grid-template-columns:repeat(2,1fr); } }
        @media (max-width:760px) { .sotp-grid3, .sotp-grid2 { grid-template-columns:1fr; } .sotp-hero{flex-direction:column;} }
        .spin { animation: sotp-spin 1s linear infinite; }
        @keyframes sotp-spin { to { transform: rotate(360deg); } }
        input::placeholder { color: ${FAINT}; }
        input[type=number]::-webkit-inner-spin-button { opacity: 0.25; }
        button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid ${AMBER}; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
      `}</style>
    </div>
  );
}

function KV({ k, v, total }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12,
      padding: total ? "10px 0 7px" : "7px 0",
      borderTop: total ? `1px solid ${LINE}` : "none",
      borderBottom: total ? "none" : `1px dashed ${LINE}`,
      marginTop: total ? 4 : 0,
    }}>
      <span style={{ fontSize: total ? 13.5 : 12.5, color: TEXT, fontWeight: total ? 600 : 400 }}>{k}</span>
      <span style={{ ...mono, fontSize: total ? 14.5 : 12.5, fontWeight: total ? 700 : 500, color: total ? AMBER : TEXT, whiteSpace: "nowrap" }}>{v}</span>
    </div>
  );
}
