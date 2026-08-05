/* ------------------------------------------------------------------ *
 * Shared design tokens — mirrors the palette LBOModel.jsx uses locally,
 * so the Merger Model reads as the same app rather than a bolt-on.
 * ------------------------------------------------------------------ */
export const INK = "#0B0C0F";
export const PANEL = "#14161B";
export const PANEL2 = "#1B1E25";
export const LINE = "#262A33";
export const AMBER = "#E8823C";
export const AMBER_DIM = "rgba(232,130,60,0.13)";
export const TEAL = "#4CC9C0";
export const GREEN = "#5BD98A";
export const RED = "#F2645A";
export const GOLD = "#E5B94E";
export const TEXT = "#E9E6DF";
export const MUTED = "#8A8F9A";
export const FAINT = "#565C68";

export const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontVariantNumeric: "tabular-nums" };
export const serif = { fontFamily: "Georgia, 'Times New Roman', serif" };

export const ghostBtn = {
  display: "flex", alignItems: "center", gap: 7, background: "transparent",
  border: `1px solid ${LINE}`, color: MUTED, borderRadius: 8,
  padding: "9px 14px", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
};
