"use client";
import { useEffect, useRef, useState } from "react";
import type { Core, ElementDefinition, LayoutOptions, StylesheetJson } from "cytoscape";
import type { GraphData } from "./types";

/** Reads the design tokens so the graph follows light/dark mode. */
function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    fg: v("--fg", "#16202c"), bg: v("--bg", "#f6f7f9"), muted: v("--muted", "#5a6574"), line: v("--line", "#d5dbe2"),
    accent: v("--accent", "#2f6f5e"), inferred: v("--inferred", "#6b5aa6"),
    type: (t: string) => v(`--t-${t}`, v("--muted", "#5a6574")),
  };
}

function stylesheet(): StylesheetJson {
  const t = tokens();
  const types = ["person", "place", "event", "topic", "document", "source"];
  return [
    {
      selector: "node",
      style: {
        "background-color": t.muted, label: "data(label)", color: t.fg, "font-size": 11, "font-family": "Inter Tight, system-ui, sans-serif",
        "text-valign": "bottom", "text-margin-y": 4, "text-outline-color": t.bg, "text-outline-width": 2,
        width: 18, height: 18, "min-zoomed-font-size": 7, "text-max-width": "120px", "text-wrap": "ellipsis",
      },
    },
    ...types.map((ty) => ({ selector: `node[type = "${ty}"]`, style: { "background-color": t.type(ty) } })),
    { selector: 'node[type = "person"]', style: { width: 24, height: 24 } },
    { selector: 'node[type = "event"]', style: { shape: "round-diamond" as const } },
    { selector: 'node[type = "place"]', style: { shape: "round-rectangle" as const } },
    { selector: 'node[type = "document"], node[type = "source"]', style: { shape: "round-tag" as const } },
    {
      selector: "edge",
      style: {
        width: 1.5, "curve-style": "bezier", "line-color": t.muted, "target-arrow-color": t.muted, "target-arrow-shape": "triangle",
        "arrow-scale": 0.8, label: "data(relation)", "font-size": 9, color: t.muted, "text-rotation": "autorotate",
        "text-outline-color": t.bg, "text-outline-width": 2, "min-zoomed-font-size": 9,
      },
    },
    { selector: 'edge[status = "unconfirmed"]', style: { "line-color": t.line, "target-arrow-color": t.line } },
    { selector: 'edge[status = "inferred"]', style: { "line-style": "dashed", "line-color": t.inferred, "target-arrow-color": t.inferred } },
    { selector: ".hidden", style: { display: "none" } },
    { selector: ".dim", style: { opacity: 0.15 } },
    { selector: "node.match", style: { "border-width": 2, "border-color": t.accent } },
    { selector: "node:selected", style: { "border-width": 3, "border-color": t.accent, "font-weight": "bold" } },
    { selector: "edge.near", style: { width: 2.5, opacity: 1 } },
  ] as StylesheetJson;
}

export default function GraphCanvas({
  data, hiddenTypes, query, matchIds, selectedId, onSelect, label,
}: {
  data: GraphData;
  hiddenTypes: Set<string>;
  query: string;
  matchIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  label: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const onSelectRef = useRef(onSelect);
  const [ready, setReady] = useState(0);
  useEffect(() => { onSelectRef.current = onSelect; });

  // Build once per data set.
  useEffect(() => {
    let cancelled = false;
    let media: MediaQueryList | null = null;
    const restyle = () => cyRef.current?.style(stylesheet());
    (async () => {
      const cytoscape = (await import("cytoscape")).default;
      if (cancelled || !el.current) return;
      const ids = new Set(data.nodes.map((n) => n.id));
      const elements: ElementDefinition[] = [
        ...data.nodes.map((n) => ({ group: "nodes" as const, data: { id: n.id, label: n.label, type: n.type } })),
        ...data.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({
          group: "edges" as const,
          data: { id: e.id, source: e.from, target: e.to, relation: e.relation.replace(/_/g, " "), status: e.status },
        })),
      ];
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const cy = cytoscape({
        container: el.current, elements, style: stylesheet(), minZoom: 0.2, maxZoom: 3, wheelSensitivity: 0.3,
        boxSelectionEnabled: false, selectionType: "single",
        layout: { name: "cose", animate: !reduceMotion && elements.length < 400, nodeRepulsion: () => 9000, idealEdgeLength: () => 80, padding: 24 } as LayoutOptions,
      });
      cy.on("tap", "node", (evt) => onSelectRef.current(evt.target.id()));
      cy.on("tap", (evt) => { if (evt.target === cy) onSelectRef.current(null); });
      cyRef.current = cy;
      setReady((r) => r + 1);
      media = window.matchMedia("(prefers-color-scheme: dark)");
      media.addEventListener("change", restyle);
    })();
    return () => {
      cancelled = true;
      media?.removeEventListener("change", restyle);
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, [data]);

  // Filters, search highlighting and selection.
  useEffect(() => {
    void ready;
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        n.toggleClass("hidden", hiddenTypes.has(n.data("type")));
        n.toggleClass("match", !!query && matchIds.has(n.id()));
        n.toggleClass("dim", !!query && !matchIds.has(n.id()));
      });
      cy.edges().forEach((e) => {
        e.toggleClass("dim", !!query && !(matchIds.has(e.source().id()) || matchIds.has(e.target().id())));
        e.toggleClass("near", !!selectedId && (e.source().id() === selectedId || e.target().id() === selectedId));
      });
      cy.nodes(":selected").unselect();
      if (selectedId) cy.getElementById(selectedId).select();
    });
    if (selectedId) {
      const n = cy.getElementById(selectedId);
      if (n.nonempty() && !n.hasClass("hidden")) cy.animate({ center: { eles: n } }, { duration: 250 });
    }
  }, [ready, hiddenTypes, query, matchIds, selectedId]);

  return <div ref={el} role="img" aria-label={label} className="h-full w-full" />;
}
