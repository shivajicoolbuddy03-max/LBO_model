/* ================================================================== *
 * SOTP VALUATION BUILDER — deterministic calc engine.
 * Segment-level EV/Sales & EV/OI (or EV/EBITDA) build, blended, then
 * bridged to implied equity value and share price against a net-debt
 * bridge computed from the balance sheet. No AI involved here — pure
 * arithmetic on whatever the state object holds, whether it came from
 * manual entry or the AI research step.
 * ================================================================== */
export const JURISDICTIONS = [
  { value: "US SEC EDGAR (10-K / 8-K earnings releases)", label: "United States — SEC EDGAR" },
  { value: "Canada SEDAR+", label: "Canada — SEDAR+" },
  { value: "India BSE/NSE (Ind AS Annual Report)", label: "India — BSE / NSE" },
  { value: "United Kingdom LSE RNS", label: "United Kingdom — LSE RNS" },
  { value: "Japan EDINET", label: "Japan — EDINET" },
  { value: "Hong Kong HKEXnews", label: "Hong Kong — HKEXnews" },
  { value: "Australia ASX", label: "Australia — ASX" },
  { value: "Singapore SGXNet", label: "Singapore — SGXNet" },
  { value: "South Korea DART", label: "South Korea — DART" },
  { value: "Brazil CVM/B3", label: "Brazil — CVM / B3" },
  { value: "South Africa JSE SENS", label: "South Africa — JSE SENS" },
  { value: "OTHER", label: "Other (specify)" },
];

export function makeSegment(id, name) {
  return { id, name: name || `Segment ${id}`, priorSales: null, currentSales: null, currentOI: null, guideLow: null, guideHigh: null, src: {} };
}
export function makeMultiple() {
  return { evSalesLow: null, evSalesHigh: null, evOILow: null, evOIHigh: null, peers: [] };
}

export function defaultSotpState() {
  return {
    company: {
      name: "", ticker: "", exchange: "", currency: "USD", fy: "",
      asOfDate: new Date().toISOString().slice(0, 10),
      jurisdiction: JURISDICTIONS[0].value, otherJur: "",
    },
    profitMetric: "OI", // "OI" | "EBITDA"
    market: { sharePrice: null, basicSharesMM: null, dilutedSharesMM: null, src: {} },
    netDebt: { currentDebt: null, ltDebt: null, cash: null, pensionLiab: null, pensionAsset: null, nci: null, other: 0, src: {} },
    segments: [makeSegment(1), makeSegment(2)],
    multiples: {},
  };
}

export function num(v) { return typeof v === "number" && isFinite(v) ? v : 0; }

export function computeNetDebt(netDebt) {
  const totalDebt = num(netDebt.currentDebt) + num(netDebt.ltDebt);
  const nd = totalDebt - num(netDebt.cash) + num(netDebt.pensionLiab) - num(netDebt.pensionAsset) + num(netDebt.nci) + num(netDebt.other);
  return { totalDebt, netDebt: nd };
}
export function computeBridge(market, netDebt) {
  const { totalDebt, netDebt: nd } = computeNetDebt(netDebt);
  const mktCap = num(market.sharePrice) * num(market.dilutedSharesMM);
  return { totalDebt, netDebt: nd, mktCap, currentEV: mktCap + nd };
}

export function percentile(sortedArr, p) {
  if (!sortedArr || sortedArr.length === 0) return null;
  if (sortedArr.length === 1) return sortedArr[0];
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

export function computeSOTP({ segments, multiples, market, netDebt }) {
  const bridge = computeBridge(market, netDebt);
  const rows = [];
  let totCurrentSales = 0, totCurrentOI = 0, totLow = 0, totHigh = 0;
  segments.forEach((s) => {
    const m = multiples[s.id] || {};
    const evSalesLow = num(s.currentSales) * num(m.evSalesLow);
    const evSalesHigh = num(s.currentSales) * num(m.evSalesHigh);
    const evOILow = num(s.currentOI) * num(m.evOILow);
    const evOIHigh = num(s.currentOI) * num(m.evOIHigh);
    const blendLow = (evSalesLow + evOILow) / 2;
    const blendHigh = (evSalesHigh + evOIHigh) / 2;
    rows.push({ id: s.id, name: s.name, sales: num(s.currentSales), oi: num(s.currentOI), evSalesLow, evSalesHigh, evOILow, evOIHigh, blendLow, blendHigh });
    totCurrentSales += num(s.currentSales);
    totCurrentOI += num(s.currentOI);
    totLow += blendLow;
    totHigh += blendHigh;
  });
  const sotpEVLow = totLow, sotpEVHigh = totHigh;
  const equityLow = sotpEVLow - bridge.netDebt;
  const equityHigh = sotpEVHigh - bridge.netDebt;
  const dilutedShares = num(market.dilutedSharesMM);
  const priceLow = dilutedShares ? equityLow / dilutedShares : null;
  const priceHigh = dilutedShares ? equityHigh / dilutedShares : null;
  const currentPrice = num(market.sharePrice);
  const premLow = (currentPrice && priceLow != null) ? (priceLow / currentPrice - 1) : null;
  const premHigh = (currentPrice && priceHigh != null) ? (priceHigh / currentPrice - 1) : null;
  const discLow = sotpEVLow ? (1 - bridge.currentEV / sotpEVLow) : null;
  const discHigh = sotpEVHigh ? (1 - bridge.currentEV / sotpEVHigh) : null;
  return { bridge, rows, totCurrentSales, totCurrentOI, sotpEVLow, sotpEVHigh, equityLow, equityHigh, dilutedShares, priceLow, priceHigh, currentPrice, premLow, premHigh, discLow, discHigh };
}
