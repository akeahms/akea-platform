import React, { useEffect, useRef, useState } from "react";

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  const depKey = useRef<string>("");
  useEffect(() => {
    let live = true;
    // a different selection (hotel, date…) clears the old data so it can't be shown or saved under the new one;
    // a plain refresh keeps it on screen while reloading
    let key = "";
    try { key = JSON.stringify(deps); } catch { key = String(Math.random()); }
    const changed = key !== depKey.current;
    depKey.current = key;
    setState((s) => (changed ? { loading: true } : { ...s, loading: true, error: undefined }));
    fn().then(
      (data) => live && setState({ data, loading: false }),
      (e) => live && setState({ error: e?.message || String(e), loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

export const PageHead = (p: { eyebrow: string; title: string; desc?: React.ReactNode; actions?: React.ReactNode }) => (
  <div className="ph">
    <div>
      <div className="eyebrow">{p.eyebrow}</div>
      <h1>{p.title}</h1>
      {p.desc && <p>{p.desc}</p>}
    </div>
    {p.actions && <div className="acts">{p.actions}</div>}
  </div>
);

export const Card = (p: { title?: React.ReactNode; note?: React.ReactNode; actions?: React.ReactNode; flush?: boolean; children: React.ReactNode }) => (
  <section className="card">
    {(p.title || p.note || p.actions) && (
      <div className="hd">
        <h3>{p.title}</h3>
        {p.note && <span className="note">{p.note}</span>}
        {p.actions}
      </div>
    )}
    <div className={"bd" + (p.flush ? " flush" : "")}>{p.children}</div>
  </section>
);

export function Delta(p: { cur: number; prev: number; fmt: (v: number) => string; label: string; goodUp?: boolean }) {
  if (!p.prev) return null;
  const d = p.cur - p.prev;
  const good = (d >= 0) === (p.goodUp ?? true);
  const cls = Math.abs(d) < 1e-9 ? "flat" : good ? "up" : "dn";
  return (
    <span className={"d " + cls}>
      {d >= 0 ? "↑" : "↓"} {p.fmt(Math.abs(d))} {p.label}
    </span>
  );
}

export const Kpi = (p: { label: string; value: React.ReactNode; delta?: React.ReactNode }) => (
  <div className="kpi">
    <span className="l">{p.label}</span>
    <span className="v">{p.value}</span>
    {p.delta}
  </div>
);

export const Pill = (p: { kind: "good" | "warn" | "bad" | "info" | "mute"; children: React.ReactNode }) => (
  <span className={"pill p-" + p.kind}>{p.children}</span>
);

export function Seg<T extends string>(p: { value: T; options: readonly T[] | [T, string][]; onChange: (v: T) => void; label: string }) {
  const opts = (p.options as any[]).map((o) => (Array.isArray(o) ? o : [o, o])) as [T, string][];
  return (
    <div className="seg" role="group" aria-label={p.label}>
      {opts.map(([v, l]) => (
        <button key={v} className={p.value === v ? "on" : ""} onClick={() => p.onChange(v)} type="button">
          {l}
        </button>
      ))}
    </div>
  );
}

export const Loading = () => <div className="loading" role="status">Loading…</div>;
export const ErrorBox = (p: { error: string; retry?: () => void }) => (
  <div className="banner bad" role="alert">
    <span>{p.error}</span>
    {p.retry && (
      <button className="btn sm" onClick={p.retry}>
        Try again
      </button>
    )}
  </div>
);
export const Empty = (p: { title: string; children?: React.ReactNode }) => (
  <div className="empty">
    <b>{p.title}</b>
    {p.children && <span>{p.children}</span>}
  </div>
);

// ---------------- charts (hand-drawn SVG, one scale per chart) ----------------
function niceScale(min: number, max: number, ticks = 4) {
  const span = max - min || 1;
  const step0 = span / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0)!;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const t: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) t.push(+v.toFixed(6));
  return { lo, hi, t };
}

export function LineChart(p: {
  labels: string[];
  series: { name: string; values: number[]; color: string; dash?: boolean }[];
  fmt: (v: number) => string;
  height?: number;
  min?: number;
  max?: number;
  refLine?: number;
}) {
  const W = 640, H = p.height || 220, P = { l: 56, r: 16, t: 14, b: 28 };
  const all = p.series.flatMap((s) => s.values).concat(p.refLine != null ? [p.refLine] : []);
  if (!all.length) return <Empty title="No data for this period" />;
  const sc = niceScale(p.min ?? Math.min(...all), p.max ?? Math.max(...all));
  const iw = W - P.l - P.r, ih = H - P.t - P.b, n = p.labels.length;
  const x = (i: number) => P.l + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
  const y = (v: number) => P.t + ih - ((v - sc.lo) / (sc.hi - sc.lo)) * ih;
  const every = Math.ceil(n / 8);
  return (
    <div>
      {p.series.length > 1 && (
        <div className="legend">
          {p.series.map((s) => (
            <span key={s.name}>
              <i style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={p.series.map((s) => s.name).join(", ")}>
        {sc.t.map((t) => (
          <g key={t}>
            <line className="gl" x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} />
            <text x={P.l - 8} y={y(t) + 4} textAnchor="end">{p.fmt(t)}</text>
          </g>
        ))}
        {p.labels.map((l, i) =>
          i % every === 0 || i === n - 1 ? (
            <text key={i} x={x(i)} y={H - 8} textAnchor="middle">{l}</text>
          ) : null,
        )}
        {p.refLine != null && (
          <line x1={P.l} x2={W - P.r} y1={y(p.refLine)} y2={y(p.refLine)} stroke="var(--fg-3)" strokeDasharray="4 4" />
        )}
        {p.series.map((s, si) => {
          const d = s.values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
          const li = s.values.length - 1;
          return (
            <g key={s.name}>
              {si === 0 && <path d={`${d}L${x(li)},${P.t + ih}L${x(0)},${P.t + ih}Z`} fill={s.color} opacity={0.08} />}
              <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dash ? "5 4" : undefined} strokeLinejoin="round" />
              <circle cx={x(li)} cy={y(s.values[li])} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
            </g>
          );
        })}
        {p.labels.map((l, i) => (
          <rect key={"h" + i} x={x(i) - iw / n / 2} y={P.t} width={iw / n} height={ih} fill="transparent">
            <title>{`${l}: ${p.series.map((s) => `${s.name} ${p.fmt(s.values[i])}`).join(" · ")}`}</title>
          </rect>
        ))}
      </svg>
    </div>
  );
}

export function HBars(p: { rows: { label: string; value: number; color?: string }[]; fmt: (v: number) => string; ref?: number }) {
  const max = Math.max(...p.rows.map((r) => r.value), p.ref || 0) * 1.08 || 1;
  return (
    <div className="list">
      {p.rows.map((r) => (
        <div className="li" key={r.label} style={{ alignItems: "center" }}>
          <div className="small" style={{ width: "40%", minWidth: 0 }}>{r.label}</div>
          <div className="bar" style={{ flex: 1, position: "relative" }}>
            <span style={{ width: `${(r.value / max) * 100}%`, background: r.color || "var(--accent)" }} />
            {p.ref != null && <i className="barref" style={{ left: `${(p.ref / max) * 100}%` }} />}
          </div>
          <div className="small num" style={{ width: 70, textAlign: "right" }}>{p.fmt(r.value)}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------- shared building blocks ----------------
export function Modal(p: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode; onSubmit?: (e: React.FormEvent) => void | Promise<void>; footer?: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  const scrim = useRef<HTMLDivElement>(null);
  const close = useRef(p.onClose);
  close.current = p.onClose;
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  useEffect(() => {
    // Escape closes only the top-most dialog
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const all = document.querySelectorAll(".modal-scrim");
      if (all[all.length - 1] === scrim.current) close.current();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  // one save at a time: while it runs the dialog's controls are disabled and further submits are ignored
  async function submit(e: React.FormEvent) {
    if (busy) { e.preventDefault(); return; }
    setBusy(true);
    try { await p.onSubmit!(e); } finally { if (live.current) setBusy(false); }
  }
  const body = (
    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} aria-busy={busy}>
      <h3>{p.title}</h3>
      {p.children}
      {p.footer && <div className="acts" style={{ marginTop: 18, justifyContent: "flex-end" }}>{p.footer}</div>}
    </fieldset>
  );
  // a click that starts inside the dialog and ends on the backdrop (e.g. selecting text) doesn't close it
  let downOnScrim = false;
  return (
    <div className="modal-scrim" ref={scrim} onMouseDown={(e) => { downOnScrim = e.target === e.currentTarget; }}
      onMouseUp={(e) => { if (downOnScrim && e.target === e.currentTarget && !busy) p.onClose(); downOnScrim = false; }}>
      {p.onSubmit ? (
        <form className={"modal" + (p.wide ? " wide" : "")} role="dialog" aria-modal="true" aria-label={p.title} onSubmit={submit}>{body}</form>
      ) : (
        <div className={"modal" + (p.wide ? " wide" : "")} role="dialog" aria-modal="true" aria-label={p.title}>{body}</div>
      )}
    </div>
  );
}

export function Field(p: { label: string; id: string; children: React.ReactNode; hint?: string; span?: boolean }) {
  return (
    <div className="field" style={p.span ? { gridColumn: "1 / -1" } : undefined}>
      <label htmlFor={p.id}>{p.label}</label>
      {p.children}
      {p.hint && <span className="hint">{p.hint}</span>}
    </div>
  );
}

export function HotelSelect(p: { hotels: { id: string; name: string; city: string | null }[]; value: string; onChange: (v: string) => void; all?: boolean; id?: string; label?: string }) {
  return (
    <select id={p.id || "hotelSel"} aria-label={p.label || "Hotel"} value={p.value} onChange={(e) => p.onChange(e.target.value)}>
      {p.all && <option value="">All hotels</option>}
      {p.hotels.map((h) => <option key={h.id} value={h.id}>{h.name}{h.city ? ` · ${h.city}` : ""}</option>)}
    </select>
  );
}

export function Notice(p: { kind: "info" | "bad" | "good"; children: React.ReactNode; onClose?: () => void }) {
  return (
    <div className={"banner " + (p.kind === "good" ? "good" : p.kind)} role={p.kind === "bad" ? "alert" : "status"}>
      <span>{p.children}</span>
      {p.onClose && <button className="btn sm" onClick={p.onClose} type="button">Dismiss</button>}
    </div>
  );
}

export function SampleBadge({ show }: { show: boolean }) {
  return show ? <span className="chip" title="Sample data for review — replaced as real data arrives">Sample</span> : null;
}

export function downloadFile(name: string, content: BlobPart, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export function toCsv(rows: (string | number | null | undefined)[][]) {
  return rows.map((r) => r.map((c) => {
    let s = c == null ? "" : String(c);
    // text starting with = + - @ (or a tab/return) would run as a formula in Excel: make it plain text. Real numbers are left alone.
    if (typeof c === "string" && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\r\n");
}

export function Tabs<T extends string>(p: { value: T; tabs: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {p.tabs.map(([v, l]) => (
        <button key={v} role="tab" aria-selected={p.value === v} className={p.value === v ? "on" : ""} onClick={() => p.onChange(v)} type="button">{l}</button>
      ))}
    </div>
  );
}
