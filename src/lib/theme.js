/* ------------------------------------------------------------------ *
 * Shared design tokens — mirrors the palette LBOModel.jsx uses locally,
 * so the Merger Model reads as the same app rather than a bolt-on.
 * ------------------------------------------------------------------ */
export const INK = "#E6E7ED";
export const PANEL = "#ffffff";
export const PANEL2 = "#F6F2E7";
export const LINE = "#DACB9D";
export const AMBER = "#1E319E";
export const AMBER_DIM = "rgba(30,49,158,0.08)";
export const TEAL = "#6D7BC7";
export const GREEN = "#6D7BC7";
export const RED = "#9C3B3B";
export const GOLD = "#B89B47";
export const TEXT = "#1A1D2E";
export const MUTED = "#5B6178";
export const FAINT = "#8F93A3";

export const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontVariantNumeric: "tabular-nums" };
export const serif = { fontFamily: "Georgia, 'Times New Roman', serif" };

export const ghostBtn = {
  display: "flex", alignItems: "center", gap: 7, background: "transparent",
  border: `1px solid ${LINE}`, color: MUTED, borderRadius: 8,
  padding: "9px 14px", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
};
