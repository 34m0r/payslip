import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Globe, { type GlobeMethods } from "react-globe.gl";
import { MeshLambertMaterial } from "three";
import { polygonToCells } from "h3-js";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import countries110 from "world-atlas/countries-110m.json";
import { EMPLOYEES, HUBS, hubOf, treasury, type Employee } from "./data";
import { FLIGHT_MS, type Transfer } from "./payroll";

const topo = countries110 as unknown as Topology<{ countries: GeometryCollection }>;
// h3 rejects a few degenerate rings of the 110m atlas (North Korea's main polygon), and globe.gl
// would throw on them mid-render: keep only the polygons h3 can fill at the resolution we draw.
const fillable = (rings: number[][][]) => { try { polygonToCells(rings, 3, true); return true; } catch { return false; } };
const LAND = feature(topo, topo.objects.countries).features
  .filter((f) => f.id !== "010") // drop Antarctica
  .map((f) => (f.geometry.type === "MultiPolygon" ? { ...f, geometry: { ...f.geometry, coordinates: f.geometry.coordinates.filter(fillable) } } : f))
  .filter((f) => f.geometry.type !== "Polygon" || fillable(f.geometry.coordinates));

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// WebGL colours must be hex/rgb (three.js cannot parse oklch or color-mix): the globe has
// its own hex tokens in styles.css, alpha variants are built here.
interface Theme { sphere: string; dot: string; atmo: string; flow: string; flowFaint: string; person: string; personDone: string; ink: string }
export function rgba(hex: string, a: number) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function readTheme(): Theme {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string, fallback: string) => css.getPropertyValue(n).trim() || fallback;
  const flow = v("--g-flow", "#1f6f5c");
  return {
    sphere: v("--g-sphere", "#e6ece8"), dot: v("--g-dot", "#8e9bab"), atmo: v("--g-atmo", "#b9c7d6"),
    flow, flowFaint: rgba(flow, 0.22), person: v("--g-person", "#40506b"), personDone: flow, ink: v("--g-ink", "#18233f"),
  };
}
function useTheme() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setTheme(readTheme());
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return theme;
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

interface ArcDatum { id: string; startLat: number; startLng: number; endLat: number; endLng: number; live: boolean }
interface RingDatum { lat: number; lng: number }

const EMPLOYEE_BY_ID = new Map(EMPLOYEES.map((e) => [e.id, e]));
// Arrival pulse: two rings, each RING_RADIUS / RING_SPEED = 0.8 s, the second leaving at
// RING_PERIOD_MS; the datum is dropped just after it ends, before a third would start.
const RING_RADIUS = 3.2; // deg
const RING_SPEED = 4; // deg/s
const RING_PERIOD_MS = 900;
const RING_LIFE_MS = RING_PERIOD_MS + (RING_RADIUS / RING_SPEED) * 1000 + 50;

export function GlobeView({ employees, transfers, focusId, selectedId, onSelect, running, openFlights = false }: {
  employees: Employee[]; transfers: Transfer[]; focusId: string | null; selectedId: string | null;
  onSelect: (id: string) => void; running: boolean;
  /** Flight time unknown in advance (real network): packets stream until the transfer lands. */
  openFlights?: boolean;
}) {
  const globe = useRef<GlobeMethods | undefined>(undefined);
  const [wrap, { w, h }] = useSize<HTMLDivElement>();
  const theme = useTheme();

  const material = useMemo(
    // Matte, like paper: Lambert has no specular hotspot.
    () => new MeshLambertMaterial({ color: theme.sphere, emissive: theme.sphere, emissiveIntensity: 0.42 }),
    [theme.sphere],
  );

  // Hub labels: built once per theme, positioned by globe.gl.
  const hubEls = useMemo(() => {
    const counts = new Map<string, number>();
    employees.forEach((e) => counts.set(e.hub, (counts.get(e.hub) ?? 0) + 1));
    return HUBS.filter((hub) => hub.isHQ || counts.has(hub.id)).map((hub) => {
      const el = document.createElement("div");
      el.className = `hub${hub.isHQ ? " hub--hq" : ""}`;
      el.innerHTML = `<span class="hub__pin"></span><span class="hub__label"><strong>${hub.city}</strong><em>${
        hub.isHQ ? "HQ and treasury" : `${counts.get(hub.id)} employee${counts.get(hub.id)! > 1 ? "s" : ""}`
      }</em></span>`;
      return { ...hub, el };
    });
  }, [employees]);

  const byId = useMemo(() => new Map(transfers.map((t) => [t.employeeId, t])), [transfers]);
  const hq = treasury();

  // globe.gl joins arcs and rings to their data by object identity: a new object tears the
  // old one down and restarts its animation. So each datum is created once, when its state
  // begins, and reused on every render after that.
  const arcCache = useRef(new Map<string, ArcDatum>());
  const arcs = useMemo(() => {
    const next = new Map<string, ArcDatum>();
    for (const t of transfers) {
      if (t.status !== "sending" && t.status !== "received") continue;
      const live = t.status === "sending";
      const prev = arcCache.current.get(t.employeeId);
      if (prev && prev.live === live) { next.set(t.employeeId, prev); continue; }
      const e = EMPLOYEE_BY_ID.get(t.employeeId)!;
      next.set(t.employeeId, { id: e.id, startLat: hq.lat, startLng: hq.lng, endLat: e.lat, endLng: e.lng, live });
    }
    arcCache.current = next;
    return [...next.values()];
  }, [transfers, hq.lat, hq.lng]);

  // One arrival pulse per received transfer, removed once its last ring has finished.
  const [rings, setRings] = useState<RingDatum[]>([]);
  const pulsed = useRef(new Set<string>());
  useEffect(() => {
    if (transfers.every((t) => !t.receivedAt)) pulsed.current.clear(); // new run
    const fresh: RingDatum[] = [];
    for (const t of transfers) {
      const key = `${t.employeeId}:${t.receivedAt}`;
      if (!t.receivedAt || pulsed.current.has(key)) continue;
      pulsed.current.add(key);
      const e = EMPLOYEE_BY_ID.get(t.employeeId)!;
      fresh.push({ lat: e.lat, lng: e.lng });
    }
    if (!fresh.length) return;
    setRings((r) => [...r, ...fresh]);
    setTimeout(() => setRings((r) => r.filter((x) => !fresh.includes(x))), RING_LIFE_MS);
  }, [transfers]);

  // Camera: idle slow rotation; during a run, follow the money.
  useEffect(() => {
    const g = globe.current;
    if (!g) return;
    const c = g.controls();
    c.autoRotate = !running && !focusId && !reducedMotion();
    c.autoRotateSpeed = 0.35;
    c.enableDamping = true;
    c.minDistance = 160;
    c.maxDistance = 520;
  }, [running, focusId]);

  // During a run a transfer leaves every ~0.7 s, faster than a camera move: chasing each one
  // restarted the move before it settled. Follow the hub instead, which changes 5 times a run.
  const framed = useRef<string | null>(null);
  useEffect(() => {
    const g = globe.current;
    if (!g || !focusId) { framed.current = null; return; }
    const e = EMPLOYEE_BY_ID.get(focusId);
    if (!e) return;
    const target = running ? hubOf(e.hub) : e;
    const key = running ? `hub:${e.hub}` : e.id;
    if (key === framed.current) return;
    framed.current = key;
    const ms = reducedMotion() ? 0 : 1600;
    g.pointOfView({ lat: (hq.lat + target.lat) / 2, lng: (hq.lng + target.lng) / 2, altitude: w < 600 ? 2.4 : 1.75 }, ms);
  }, [focusId, running, hq.lat, hq.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  // Overview: initial framing, and back to it when a run ends or the selection clears.
  useEffect(() => {
    if (focusId) return;
    globe.current?.pointOfView({ lat: 16, lng: -22, altitude: w < 600 ? 2.7 : 1.95 }, reducedMotion() ? 0 : 1400);
  }, [focusId, w < 600]); // eslint-disable-line react-hooks/exhaustive-deps

  const still = reducedMotion();

  // Stable accessors: react-globe.gl re-applies a layer whenever one of its accessor props
  // changes identity, and re-applying the land layer means thousands of dots.
  const dotColor = useCallback(() => theme.dot, [theme.dot]);
  const pointColor = useCallback((d: object) => {
    const e = d as Employee;
    return e.id === selectedId ? theme.ink : byId.get(e.id)?.status === "received" ? theme.personDone : theme.person;
  }, [selectedId, byId, theme]);
  const pointAltitude = useCallback((d: object) => ((d as Employee).id === selectedId ? 0.06 : 0.015), [selectedId]);
  const pointRadius = useCallback((d: object) => ((d as Employee).id === selectedId ? 0.75 : 0.55), [selectedId]);
  const pointLabel = useCallback((d: object) => {
    const e = d as Employee;
    return `<div class="tip"><strong>${e.name}</strong><span>${e.role}, ${e.city}</span></div>`;
  }, []);
  const onPointClick = useCallback((d: object) => onSelect((d as Employee).id), [onSelect]);
  const htmlElement = useCallback((d: object) => (d as (typeof hubEls)[number]).el, []);
  const arcStyle = useMemo(() => {
    const animated = (d: object) => (d as ArcDatum).live && !still;
    return {
      color: (d: object) => ((d as ArcDatum).live ? [rgba(theme.flow, 0.35), theme.flow] : [theme.flowFaint, rgba(theme.flow, 0.45)]),
      stroke: (d: object) => ((d as ArcDatum).live ? 1.15 : 0.5),
      // live: one packet leaves the treasury and its head lands as the flight ends (1 arc
      // length per FLIGHT_MS), or with open flights a packet every FLIGHT_MS until it lands;
      // received: the established route, drawn solid.
      dashLength: (d: object) => (animated(d) ? 0.42 : 1),
      dashGap: (d: object) => (animated(d) ? (openFlights ? 0.58 : 2) : 0),
      dashInitialGap: (d: object) => (animated(d) ? 1 : 0),
      dashAnimateTime: (d: object) => (animated(d) ? FLIGHT_MS : 0),
    };
  }, [theme.flow, theme.flowFaint, still, openFlights]);
  const ringColor = useCallback(() => (t: number) => rgba(theme.flow, Math.max(0, 1 - t)), [theme.flow]);

  return (
    <div ref={wrap} className="globe" role="img" aria-label="Globe of Atlântica Labs' offices and payroll transfers">
      <Globe
        ref={globe}
        width={w}
        height={h}
        backgroundColor="rgba(0,0,0,0)"
        globeMaterial={material}
        showAtmosphere
        atmosphereColor={theme.atmo}
        atmosphereAltitude={0.14}
        hexPolygonsData={LAND}
        hexPolygonResolution={3}
        hexPolygonMargin={0.55}
        hexPolygonUseDots
        hexPolygonColor={dotColor}
        pointsData={employees}
        pointLat="lat"
        pointLng="lng"
        pointAltitude={pointAltitude}
        pointRadius={pointRadius}
        pointColor={pointColor}
        pointsTransitionDuration={still ? 0 : 400}
        pointLabel={pointLabel}
        onPointClick={onPointClick}
        htmlElementsData={hubEls}
        htmlLat="lat"
        htmlLng="lng"
        htmlAltitude={0.01}
        htmlElement={htmlElement}
        arcsData={arcs}
        arcColor={arcStyle.color}
        arcStroke={arcStyle.stroke}
        arcAltitudeAutoScale={0.4}
        arcDashLength={arcStyle.dashLength}
        arcDashGap={arcStyle.dashGap}
        arcDashInitialGap={arcStyle.dashInitialGap}
        arcDashAnimateTime={arcStyle.dashAnimateTime}
        arcsTransitionDuration={0}
        ringsData={rings}
        ringColor={ringColor}
        ringMaxRadius={RING_RADIUS}
        ringPropagationSpeed={RING_SPEED}
        ringRepeatPeriod={still ? 0 : RING_PERIOD_MS}
      />
    </div>
  );
}
