"use client";
import { useEffect, useRef, useState } from "react";
import type { Core, ElementDefinition, LayoutOptions, NodeSingular, StylesheetJson } from "cytoscape";
import { Maximize2, Minus, Plus } from "lucide-react";
import { personHue } from "@/lib/ui/person-color";
import { useT } from "@/lib/i18n/client";
import { typeColor } from "@/components/mention/colors";
import type { GraphData } from "./types";

/** Reads the design tokens from CSS so the graph follows light and dark mode. Re-read on every theme change. */
function tokens() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    fg: v("--fg", "#17201c"), surface: v("--surface", "#ffffff"), muted: v("--muted", "#5b6660"), line: v("--line", "#dce0da"),
    accent: v("--accent", "#2f4bb0"), inferred: v("--inferred", "#7a4fa0"),
    personS: v("--person-s", "62%"), personL: v("--person-l", "42%"),
    font: getComputedStyle(document.body).fontFamily || "system-ui, sans-serif",
    type: (t: string) => v(`--t-${t}`, typeColor(t).match(/#[0-9a-f]{6}/i)?.[0] ?? v("--muted", "#5b6660")),
  };
}

function stylesheet(): StylesheetJson {
  const t = tokens();
  const person = (n: NodeSingular) => `hsl(${n.data("hue")}, ${t.personS}, ${t.personL})`;
  return [
    {
      selector: "node",
      style: {
        "background-color": (n: NodeSingular) => t.type(n.data("type")),
        label: "data(label)", color: t.muted, "font-size": 11, "font-family": t.font, "font-weight": 450,
        "text-valign": "bottom", "text-margin-y": 5, "text-outline-color": t.surface, "text-outline-width": 2.5, "text-outline-opacity": 1,
        width: 11, height: 11, "border-width": 2, "border-color": t.surface, "min-zoomed-font-size": 8,
        "text-max-width": "130px", "text-wrap": "ellipsis",
        "transition-property": "opacity, border-color, border-width, width, height", "transition-duration": 0.18,
      },
    },
    {
      selector: 'node[type = "person"]',
      style: { "background-color": person, width: 22, height: 22, "border-width": 3, color: t.fg, "font-size": 12.5, "font-weight": 600, "text-margin-y": 6, "min-zoomed-font-size": 4 },
    },
    { selector: 'node[type = "event"]', style: { shape: "round-diamond" as const, width: 13, height: 13 } },
    { selector: 'node[type = "place"]', style: { shape: "round-rectangle" as const } },
    { selector: 'node[type = "document"], node[type = "source"]', style: { shape: "round-rectangle" as const, width: 9, height: 11 } },
    {
      selector: "edge",
      style: {
        width: 1, "curve-style": "bezier", "line-color": t.muted, "line-opacity": 0.32,
        "target-arrow-color": t.muted, "target-arrow-shape": "triangle", "arrow-scale": 0.55,
        label: "data(label)", "font-size": 10, "font-family": t.font, color: t.muted, "text-opacity": 0,
        "text-rotation": "autorotate", "text-outline-color": t.surface, "text-outline-width": 2.5, "min-zoomed-font-size": 9,
        "transition-property": "opacity, line-opacity, width, text-opacity", "transition-duration": 0.18,
      },
    },
    { selector: 'edge[status = "unconfirmed"]', style: { "line-style": "dashed", "line-dash-pattern": [2, 3], "line-opacity": 0.45 } },
    { selector: 'edge[status = "inferred"]', style: { "line-style": "dashed", "line-dash-pattern": [5, 4], "line-color": t.inferred, "target-arrow-color": t.inferred, "line-opacity": 0.7, color: t.inferred } },
    { selector: ".hidden", style: { display: "none" } },
    { selector: ".dim", style: { opacity: 0.18 } },
    { selector: ".faded", style: { opacity: 0.14 } },
    { selector: "node.lit", style: { color: t.fg } },
    { selector: "edge.lit", style: { width: 1.6, "line-opacity": 0.85 } },
    { selector: "edge.named", style: { "text-opacity": 1 } },
    { selector: "node.match", style: { "border-color": t.accent, "border-width": 2.5 } },
    { selector: "node:selected", style: { "border-color": t.accent, "border-width": 3, color: t.fg, "font-weight": 600 } },
    { selector: 'node[type = "person"]:selected', style: { width: 26, height: 26 } },
  ] as StylesheetJson;
}

/** Fade everything except a node and its neighbours, and show the labels on its lines. */
function spotlight(cy: Core, id: string | null, named = false) {
  cy.batch(() => {
    cy.elements().removeClass("faded lit named");
    if (!id) return;
    const n = cy.getElementById(id);
    if (n.empty() || n.hasClass("hidden")) return;
    const hood = n.closedNeighborhood();
    cy.elements().not(hood).addClass("faded");
    hood.addClass("lit");
    if (named) hood.edges().addClass("named");
  });
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
  const selectedRef = useRef(selectedId);
  const [ready, setReady] = useState(0);
  useEffect(() => { onSelectRef.current = onSelect; selectedRef.current = selectedId; });

  // Build once per data set.
  useEffect(() => {
    let cancelled = false;
    let media: MediaQueryList | null = null;
    let observer: MutationObserver | null = null;
    const restyle = () => cyRef.current?.style(stylesheet());
    (async () => {
      const cytoscape = (await import("cytoscape")).default;
      if (cancelled || !el.current) return;
      const ids = new Set(data.nodes.map((n) => n.id));
      const elements: ElementDefinition[] = [
        ...data.nodes.map((n) => ({
          group: "nodes" as const,
          data: { id: n.id, label: n.label, type: n.type, hue: n.type === "person" ? personHue(n.id) : 0 },
        })),
        ...data.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({
          group: "edges" as const,
          data: { id: e.id, source: e.from, target: e.to, label: e.label ?? e.relation.replace(/_/g, " "), status: e.status },
        })),
      ];
      const cy = cytoscape({
        container: el.current, elements, style: stylesheet(), minZoom: 0.25, maxZoom: 2.5, wheelSensitivity: 0.25,
        boxSelectionEnabled: false, selectionType: "single", autoungrabify: false,
        layout: {
          name: "cose", animate: false, randomize: true, padding: 48, componentSpacing: 40, nodeOverlap: 30,
          nodeRepulsion: () => 7000, idealEdgeLength: () => 64, edgeElasticity: () => 90, gravity: 1.4, nestingFactor: 1.2, numIter: 2000,
        } as LayoutOptions,
      });
      // Fit, but never so far out that names become unreadable.
      if (cy.zoom() > 1.4) cy.zoom({ level: 1.4, position: { x: cy.width() / 2, y: cy.height() / 2 } });
      cy.center();
      cy.on("tap", "node", (evt) => onSelectRef.current(evt.target.id()));
      cy.on("tap", (evt) => { if (evt.target === cy) onSelectRef.current(null); });
      cy.on("mouseover", "node", (evt) => {
        spotlight(cy, evt.target.id(), true);
        if (el.current) el.current.style.cursor = "pointer";
      });
      cy.on("mouseout", "node", () => {
        spotlight(cy, selectedRef.current);
        if (el.current) el.current.style.cursor = "";
      });
      cyRef.current = cy;
      setReady((r) => r + 1);
      // Colours and the font come from CSS: follow the theme, and redraw once the web font has loaded.
      media = window.matchMedia("(prefers-color-scheme: dark)");
      media.addEventListener("change", restyle);
      observer = new MutationObserver(restyle);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
      void document.fonts?.ready.then(() => { if (!cancelled) restyle(); });
    })();
    return () => {
      cancelled = true;
      media?.removeEventListener("change", restyle);
      observer?.disconnect();
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
      });
      cy.nodes(":selected").unselect();
      if (selectedId) cy.getElementById(selectedId).select();
    });
    spotlight(cy, selectedId);
    if (selectedId) {
      const n = cy.getElementById(selectedId);
      if (n.nonempty() && !n.hasClass("hidden")) cy.animate({ center: { eles: n }, zoom: Math.max(cy.zoom(), 1) }, { duration: 260, easing: "ease-out-cubic" });
    }
  }, [ready, hiddenTypes, query, matchIds, selectedId]);

  const zoomBy = (f: number) => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.animate({ zoom: { level: cy.zoom() * f, position: { x: cy.width() / 2, y: cy.height() / 2 } } }, { duration: 180, easing: "ease-out-cubic" });
  };
  const fit = () => cyRef.current?.animate({ fit: { eles: cyRef.current.elements(":visible"), padding: 56 } }, { duration: 220, easing: "ease-out-cubic" });

  const t = useT();
  return (
    <>
      <div ref={el} role="img" aria-label={label} className="h-full w-full" />
      <div className="absolute bottom-3 right-3 flex flex-col rounded-md bg-surface-2/90 p-0.5" role="group" aria-label={t("graph.explorer.zoom")}>
        <CanvasButton label={t("graph.explorer.zoomIn")} onClick={() => zoomBy(1.3)}><Plus className="size-4" /></CanvasButton>
        <CanvasButton label={t("graph.explorer.zoomOut")} onClick={() => zoomBy(1 / 1.3)}><Minus className="size-4" /></CanvasButton>
        <CanvasButton label={t("graph.explorer.fit")} onClick={fit}><Maximize2 className="size-3.5" /></CanvasButton>
      </div>
    </>
  );
}

function CanvasButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick}
      className="inline-flex size-8 items-center justify-center rounded-[5px] text-muted transition-colors hover:bg-surface hover:text-fg active:scale-[0.96]">
      {children}
    </button>
  );
}
