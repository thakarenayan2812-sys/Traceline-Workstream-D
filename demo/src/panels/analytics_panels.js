// D8: draws the analytics view models (analytics_view.js) into the page. Text is set with textContent only.
// Tables sit in a keyboard-focusable scroll region, so wide tables work at phone width without page scroll.
// Status is always written as text, never by colour alone.

const el = (doc, tag, attrs = {}, text = null) => {
  const n = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== null) n.textContent = text;
  return n;
};

/** Builds one section's DOM. Pure apart from the document it is given. */
export function buildPanel(view, doc = document) {
  const hid = `an-${view.id}-h`;
  const sec = el(doc, "section", { class: "an", "aria-labelledby": hid, "data-status": view.status });
  sec.append(el(doc, "h3", { id: hid }, view.title));
  sec.append(el(doc, "p", { class: "badge an-badge" }, view.statusText));

  if (view.status === "not_yet_generated" || view.status === "incomplete") {
    sec.append(el(doc, "p", { class: "muted" }, "C's output for this section is not in the page yet. No numbers are shown."));
    return sec;
  }

  if (view.caveats.length) {
    const ul = el(doc, "ul", { class: "muted caveats" });
    for (const c of view.caveats) ul.append(el(doc, "li", {}, c));
    sec.append(ul);
  }

  if (view.summary.length) {
    const dl = el(doc, "dl", { class: "status" });
    for (const [k, v] of view.summary) { dl.append(el(doc, "dt", {}, k), el(doc, "dd", {}, v)); }
    sec.append(dl);
  }

  view.tables.forEach((t, i) => {
    const capId = `an-${view.id}-cap-${i}`;
    const region = el(doc, "div", { class: "tbl", tabindex: "0", role: "region", "aria-labelledby": capId });
    const table = el(doc, "table", { class: "runs" });
    table.append(el(doc, "caption", { id: capId, class: "muted" }, t.caption));
    const thead = el(doc, "thead"), hr = el(doc, "tr");
    t.headers.forEach((h) => hr.append(el(doc, "th", { scope: "col" }, h)));
    thead.append(hr);
    const tbody = el(doc, "tbody");
    for (const row of t.rows) {
      const tr = el(doc, "tr");
      row.forEach((cell, j) => tr.append(el(doc, j === 0 ? "th" : "td", j === 0 ? { scope: "row" } : {}, cell)));
      tbody.append(tr);
    }
    table.append(thead, tbody);
    region.append(table);
    sec.append(region);
  });

  for (const n of view.notes) {
    const prefix = n.level === "warn" ? "Warning: " : "";
    sec.append(el(doc, "p", { class: "an-note", "data-level": n.level }, prefix + n.text));
  }
  return sec;
}

/** Replaces the container's content with one section per view. */
export function renderAnalyticsPanels(container, views, doc = document) {
  container.replaceChildren(...views.map((v) => buildPanel(v, doc)));
}
