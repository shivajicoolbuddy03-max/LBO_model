/* ================================================================== *
 * MERGER MODEL — deterministic calc engine.
 * Mirrors the classic Apple / RIM accretion-dilution template: purchase
 * price allocation, sources of funds, and a two-year pro forma income
 * statement build. No AI involved here — pure arithmetic on the state
 * object produced either by manual entry or the AI research step.
 * ================================================================== */
export function defaultMergerState() {
  return {
    acquirerName: "Apple Inc.", targetName: "Research in Motion Limited",
    offerPrice: 75.0, pctCash: 0.3333333333, pctDebt: 0.3333333333, pctStock: 0.3333333333,
    foregoneCashRate: 0.01, debtInterestRate: 0.09,
    revSynergyPct: 0.10, revSynergyCOGSPct: 0.50, opexSynergyPct: 0.10,
    ppeWriteUpPct: 0.10, deprPeriod: 8, pctAllocIntangibles: 0.20, amortPeriod: 5, dtlWriteDown: 43.265,
    buyer: {
      sharePrice: 192.06, dilutedSharesMktCap: 920525.62, dilutedSharesEPS: 907005.0, taxRate: 0.30,
      jurisdiction: "United States", source: { regulator: "Illustrative template figures — not sourced from a live filing", filingName: "", filingDate: "" },
      years: [
        { label: "FY1E", revenue: 53631.25, cogs: 31655.42, opex: 5495.83, deprPPE: 917.50, amortIntangibles: 40.0, sbc: 887.50, interest: 379.25 },
        { label: "FY2E", revenue: 62748.56, cogs: 37036.84, opex: 6430.13, deprPPE: 1073.48, amortIntangibles: 37.0, sbc: 1038.38, interest: 477.65 },
      ],
    },
    seller: {
      sharePrice: 62.91, dilutedSharesMktCap: 572950.86, dilutedSharesEPS: 560000.0, taxRate: 0.28,
      bookValueEquity: 6986.62, existingGoodwill: 146.557, netPPE: 1737.40,
      jurisdiction: "Canada", source: { regulator: "Illustrative template figures — not sourced from a live filing", filingName: "", filingDate: "" },
      years: [
        { label: "FY1E", revenue: 17231.0, cogs: 9755.0, opex: 2697.53, deprPPE: 430.78, amortIntangibles: 359.0, sbc: 51.69, interest: 25.0 },
        { label: "FY2E", revenue: 20868.0, cogs: 11868.5, opex: 3258.96, deprPPE: 563.44, amortIntangibles: 433.0, sbc: 62.60, interest: 32.5 },
      ],
    },
  };
}

export function computeDeal(s, offerPriceOverride) {
  const offerPrice = offerPriceOverride !== undefined ? offerPriceOverride : s.offerPrice;
  const equityPurchasePrice = offerPrice * s.seller.dilutedSharesMktCap / 1000; // shares in thousands -> $mm
  const cashUsed = equityPurchasePrice * s.pctCash;
  const debtIssued = equityPurchasePrice * s.pctDebt;
  const newSharesIssued = (equityPurchasePrice * s.pctStock) / s.buyer.sharePrice * 1000; // back to thousands

  const totalAllocablePremium = equityPurchasePrice - s.seller.bookValueEquity + s.seller.existingGoodwill;
  const ppeWriteUpAmount = s.ppeWriteUpPct * s.seller.netPPE;
  const purchasePriceToAllocate = totalAllocablePremium;
  const intangiblesWriteUpAmount = s.pctAllocIntangibles * purchasePriceToAllocate;
  const newDTL = (ppeWriteUpAmount + intangiblesWriteUpAmount) * s.buyer.taxRate;
  const totalGoodwill = totalAllocablePremium - ppeWriteUpAmount - intangiblesWriteUpAmount - s.dtlWriteDown + newDTL;

  const years = [0, 1].map((i) => {
    const b = s.buyer.years[i], t = s.seller.years[i];

    const bGP = b.revenue - b.cogs;
    const bOI = bGP - b.opex - b.deprPPE - b.amortIntangibles - b.sbc;
    const bPT = bOI + b.interest;
    const bTax = bPT * s.buyer.taxRate;
    const bNI = bPT - bTax;
    const bEPS = bNI / s.buyer.dilutedSharesEPS;

    const tGP = t.revenue - t.cogs;
    const tOI = tGP - t.opex - t.deprPPE - t.amortIntangibles - t.sbc;
    const tPT = tOI + t.interest;
    const tTax = tPT * s.seller.taxRate;
    const tNI = tPT - tTax;
    const tEPS = tNI / s.seller.dilutedSharesEPS;

    const combinedRevenue = b.revenue + t.revenue;
    const revSynergies = s.revSynergyPct * t.revenue;
    const combinedCOGS = b.cogs + t.cogs;
    const revSynergyCOGS = s.revSynergyCOGSPct * revSynergies;
    const grossProfit = combinedRevenue + revSynergies - combinedCOGS - revSynergyCOGS;

    const combinedOpex = b.opex + t.opex;
    const opexSynergies = s.opexSynergyPct * t.opex;
    const combinedDeprPPE = b.deprPPE + t.deprPPE;
    const deprPPEWriteUp = ppeWriteUpAmount / s.deprPeriod;
    const combinedAmort = b.amortIntangibles + t.amortIntangibles;
    const amortNewIntangibles = intangiblesWriteUpAmount / s.amortPeriod;
    const combinedSBC = b.sbc + t.sbc;

    const opInc = grossProfit - (combinedOpex - opexSynergies) - combinedDeprPPE - deprPPEWriteUp - combinedAmort - amortNewIntangibles - combinedSBC;

    const combinedInterest = b.interest + t.interest;
    const foregoneInterest = -cashUsed * s.foregoneCashRate;
    const newDebtInterest = -debtIssued * s.debtInterestRate;
    const preTax = opInc + combinedInterest + foregoneInterest + newDebtInterest;
    const tax = preTax * s.buyer.taxRate;
    const netIncome = preTax - tax;

    const combinedDilutedShares = s.buyer.dilutedSharesEPS + newSharesIssued;
    const proFormaEPS = netIncome / combinedDilutedShares;
    const accretionDilution = proFormaEPS - bEPS;
    const accretionPct = accretionDilution / bEPS;

    return {
      label: b.label,
      buyer: { gp: bGP, oi: bOI, pt: bPT, tax: bTax, ni: bNI, eps: bEPS },
      seller: { gp: tGP, oi: tOI, pt: tPT, tax: tTax, ni: tNI, eps: tEPS },
      combined: {
        combinedRevenue, revSynergies, combinedCOGS, revSynergyCOGS, grossProfit,
        combinedOpex, opexSynergies, combinedDeprPPE, deprPPEWriteUp, combinedAmort, amortNewIntangibles, combinedSBC,
        opInc, combinedInterest, foregoneInterest, newDebtInterest, preTax, tax, netIncome, combinedDilutedShares, proFormaEPS,
      },
      accretionDilution, accretionPct,
    };
  });

  return {
    equityPurchasePrice, cashUsed, debtIssued, newSharesIssued,
    totalAllocablePremium, ppeWriteUpAmount, purchasePriceToAllocate, intangiblesWriteUpAmount, newDTL, totalGoodwill,
    years,
  };
}
