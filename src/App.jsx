import React, { useState } from "react";
import LBOModel from "./LBOModel.jsx";
import MergerModel from "./MergerModel.jsx";
import { INK, LINE, AMBER, MUTED, mono } from "./lib/theme.js";

const TOOLS = [
  { id: "lbo", label: "LBO Model" },
  { id: "merger", label: "M&A Merger Model" },
];

export default function App() {
  const [tool, setTool] = useState("lbo");
  return (
    <>
      <div style={{ position: "sticky", top: 0, zIndex: 40, background: INK, borderBottom: `1px solid ${LINE}` }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", padding: "10px 22px", display: "flex", gap: 8 }}>
          {TOOLS.map((t) => {
            const on = tool === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTool(t.id)}
                style={{
                  ...mono, fontSize: 12, fontWeight: 700, letterSpacing: 0.3, padding: "7px 16px", borderRadius: 20,
                  cursor: "pointer", background: on ? AMBER : "transparent", color: on ? "#fff" : MUTED,
                  border: `1px solid ${on ? AMBER : LINE}`,
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>
      {tool === "lbo" ? <LBOModel /> : <MergerModel />}
    </>
  );
}
