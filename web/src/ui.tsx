import React, { useEffect, useState } from "react";

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
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
