import { useLayoutEffect, useRef, useState } from "react";
import { nf } from "../lib/format";

/* Validated categorical slots (dataviz validator: CVD ΔE 23, normal 24).
 * Color follows the entity everywhere in the app:
 *   AI replies = aqua-green, manager replies = blue, customer messages = violet. */
export const SERIES = {
  ai: { name: "AI-агент", color: "#1baf7a" },
  operator: { name: "Менеджеры", color: "#2a78d6" },
  incoming: { name: "Сообщения клиентов", color: "#6250d6" },
} as const;

export interface Column {
  key: string;
  label: string;
  tooltip: string;
  values: number[];
}

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * pow >= v) return m * pow;
  }
  return 10 * pow;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(([e]) => e && setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Bar top rounded (4px), square at the baseline. */
function barPath(x: number, y: number, w: number, h: number, round: boolean): string {
  if (h <= 0) return "";
  const r = round ? Math.min(4, h, w / 2) : 0;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * Stacked (or single) column chart with one y-axis, hairline grid, a per-
 * column hover tooltip and a legend with totals (visible labels, so the
 * low-contrast green is never the only carrier of meaning).
 */
export function ColumnChart({
  data,
  series,
  height = 220,
  labelEvery = 1,
  showLegend = true,
}: {
  data: Column[];
  series: { name: string; color: string }[];
  height?: number;
  labelEvery?: number;
  showLegend?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const padL = 34;
  const padB = 24;
  const padT = 8;
  const plotW = Math.max(40, width - padL - 4);
  const plotH = height - padB - padT;
  const totals = data.map((d) => d.values.reduce((a, b) => a + b, 0));
  const max = niceMax(Math.max(0, ...totals));
  const ticks = [0, max / 2, max];
  const band = plotW / Math.max(1, data.length);
  const barW = Math.max(3, Math.min(24, band * 0.62));
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const sums = series.map((_, i) => data.reduce((n, d) => n + (d.values[i] ?? 0), 0));
  const h = hover !== null ? data[hover] : null;

  return (
    <div className="chart" ref={ref}>
      {showLegend && series.length > 1 && (
        <div className="legend">
          {series.map((s, i) => (
            <span key={s.name}>
              <i style={{ background: s.color }} />
              {s.name} <b>{nf(sums[i] ?? 0)}</b>
            </span>
          ))}
        </div>
      )}
      <svg width={width} height={height} role="img" aria-label="График по дням">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={width} y1={y(t)} y2={y(t)} className="grid" />
            <text x={padL - 8} y={y(t) + 4} textAnchor="end" className="tick">
              {nf(Math.round(t))}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = padL + band * i + band / 2;
          let acc = 0;
          const top = d.values.reduce((last, v, si) => (v > 0 ? si : last), -1);
          return (
            <g key={d.key}>
              {hover === i && (
                <rect x={padL + band * i} y={padT} width={band} height={plotH} className="hover-band" />
              )}
              {d.values.map((v, si) => {
                if (v <= 0) return null;
                const y0 = y(acc);
                acc += v;
                const y1 = y(acc);
                // 2px surface gap between stacked segments.
                const gap = si > 0 && acc - v > 0 ? 2 : 0;
                return (
                  <path
                    key={si}
                    d={barPath(cx - barW / 2, y1, barW, Math.max(0, y0 - y1 - gap), si === top)}
                    fill={series[si]?.color}
                  />
                );
              })}
              {i % labelEvery === 0 && (
                <text x={cx} y={height - 6} textAnchor="middle" className="tick">
                  {d.label}
                </text>
              )}
              <rect
                x={padL + band * i}
                y={padT}
                width={band}
                height={plotH + padB}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          );
        })}
        <line x1={padL} x2={width} y1={y(0)} y2={y(0)} className="axis" />
      </svg>
      {h && hover !== null && (
        <div
          className="tooltip"
          style={{ left: Math.min(Math.max(padL + band * hover + band / 2, 80), width - 80), top: 0 }}
        >
          <div className="t-head">{h.tooltip}</div>
          {series.map((s, i) => (
            <div key={s.name} className="t-row">
              <i style={{ background: s.color }} />
              {s.name}
              <b>{nf(h.values[i] ?? 0)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Thin segmented bar: one whole split into two parts, with labels. */
export function ShareBar({ parts }: { parts: { name: string; value: number; color: string }[] }) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  if (total === 0) return <div className="share-bar empty" />;
  return (
    <div className="share">
      <div className="share-bar">
        {parts.map((p) =>
          p.value > 0 ? (
            <span key={p.name} style={{ flexGrow: p.value, background: p.color }} title={`${p.name}: ${nf(p.value)}`} />
          ) : null,
        )}
      </div>
      <div className="legend">
        {parts.map((p) => (
          <span key={p.name}>
            <i style={{ background: p.color }} />
            {p.name} <b>{Math.round((p.value / total) * 100)}%</b>
          </span>
        ))}
      </div>
    </div>
  );
}
