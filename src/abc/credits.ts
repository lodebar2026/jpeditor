// Port of download_score.py `post_process_xml_metadata` (~/proj/zanmeigepu/download_score.py):
// zanmeigepu's post-processing that turns raw abc2xml output into the published MusicXML —
// it removes the <creator> tags from <identification> and adds page-aligned <credit> elements
// for 作词/作曲/词曲/编曲. Composer names are derived from the ABC `C:` header fields
// (abc2xml concatenates them into metadata['composer']); the download pipeline had them as
// structured sdata fields, here we recover them from those prefixed lines.

import { E, Element } from "./eltree";

export interface Composers {
  comp1: string; // 作词 (lyricist)
  comp2: string; // 作曲 (composer)
  comp3: string; // 编曲 (arranger)
}

// Recover 作词/作曲/词曲/编曲 from the concatenated C: creator text.
export function deriveComposers(creatorText: string): Composers {
  let comp1 = "", comp2 = "", comp3 = "";
  for (const raw of creatorText.split("\n")) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^词曲[：:]\s*(.+)$/))) { comp1 = m[1].trim(); comp2 = m[1].trim(); }
    else if ((m = line.match(/^作词[：:]\s*(.+)$/))) comp1 = m[1].trim();
    else if ((m = line.match(/^作曲[：:]\s*(.+)$/))) comp2 = m[1].trim();
    else if ((m = line.match(/^编曲[：:]\s*(.+)$/))) comp3 = m[1].trim();
  }
  return { comp1, comp2, comp3 };
}

function f2(x: number): string { return x.toFixed(2); }

function mkCredit(text: string, justify: string, x: number, y: number): Element {
  const c = E("credit", { page: "1" });
  const cw = E("credit-words", {
    justify,
    valign: "top",
    "default-x": f2(x),
    "default-y": f2(y),
    "font-size": "10",
  });
  cw.text = text;
  c.append(cw);
  return c;
}

// Add page-aligned credits and remove <creator> tags from <identification>.
// Mirrors post_process_xml_metadata; only runs meaningfully when composer names are present.
export function addPageCredits(score: Element, comps: Composers): void {
  const { comp1, comp2, comp3 } = comps;
  if (!comp1 && !comp2 && !comp3) return; // nothing to do (non-zanmeigepu ABC) -> leave as-is

  // Default layout measurements (fallback for A4 page), overridden by <defaults> if present.
  let page_width = 1190.55, right_margin = 95.5, page_height = 1683.78, top_margin = 95.5;
  let left_margin = 95.5;
  const defaults = score.find("defaults");
  const page_layout = defaults ? defaults.find("page-layout") : null;
  if (page_layout) {
    const pw = page_layout.find("page-width"); if (pw && pw.text) page_width = parseFloat(pw.text);
    const ph = page_layout.find("page-height"); if (ph && ph.text) page_height = parseFloat(ph.text);
    const margins = page_layout.find("page-margins");
    if (margins) {
      const lm = margins.find("left-margin"); if (lm && lm.text) left_margin = parseFloat(lm.text);
      const rm = margins.find("right-margin"); if (rm && rm.text) right_margin = parseFloat(rm.text);
      const tm = margins.find("top-margin"); if (tm && tm.text) top_margin = parseFloat(tm.text);
    }
  }
  const x_left = left_margin;
  const x_right = page_width - right_margin;
  const y_pos = page_height - top_margin - 130;

  // Remove creator tags from identification.
  const ident = score.find("identification");
  if (ident) for (const cr of ident.findall("creator")) ident.remove(cr);

  // Remove any existing credit tags (idempotency).
  for (const cr of score.findall("credit")) score.remove(cr);

  const credits: Element[] = [];
  if (comp1 && comp2) {
    if (comp1 === comp2) credits.push(mkCredit(`词曲：${comp1}`, "right", x_right, y_pos));
    else {
      credits.push(mkCredit(`作词：${comp1}`, "left", x_left, y_pos));
      credits.push(mkCredit(`作曲：${comp2}`, "right", x_right, y_pos));
    }
  } else if (comp1) credits.push(mkCredit(`作词：${comp1}`, "left", x_left, y_pos));
  else if (comp2) credits.push(mkCredit(`作曲：${comp2}`, "right", x_right, y_pos));

  if (comp3) credits.push(mkCredit(`编曲：${comp3}`, "right", x_right, y_pos - 30));

  // Insert credits right before <part-list>.
  const children = (score as any)._children as Element[];
  let idx = children.findIndex((c) => c.tag === "part-list");
  if (idx < 0) idx = children.length;
  for (let i = credits.length - 1; i >= 0; i--) score.insert(idx, credits[i]);
}
