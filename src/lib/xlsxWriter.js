/* ================================================================== *
 * XLSX WRITER
 * The browser build of SheetJS silently drops cell styles, so the
 * workbook is emitted as raw OOXML and packed into a stored-entry ZIP.
 * That buys full control of fonts, fills, borders, number formats,
 * tab colours, frozen panes and merges — no external dependency.
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

export function zipStore(files) {
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

export function xesc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}
export function colName(i) {
  let s = "", n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

export function StyleBook() {
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

export function WSheet(name, opts) {
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

export function writeXlsx(sheets, styles) {
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
