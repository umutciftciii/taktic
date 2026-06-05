import type { ReactNode } from 'react';

export type FinanceTrendPoint = {
  key: string;
  label: string;
  longLabel?: string;
  value: number;
  displayValue?: string;
};

type Tone = 'success' | 'primary';

const TONE_COLORS: Record<Tone, { stroke: string; fill: string }> = {
  success: { stroke: '#16a34a', fill: 'rgba(22, 163, 74, 0.12)' },
  primary: { stroke: '#2563eb', fill: 'rgba(37, 99, 235, 0.12)' },
};

const VIEW_WIDTH = 720;
const VIEW_HEIGHT = 220;
const PADDING_X = 16;
const PADDING_TOP = 16;
const PADDING_BOTTOM = 16;

type FinanceTrendPanelProps = {
  title: string;
  total?: ReactNode;
  subtitle?: ReactNode;
  data: FinanceTrendPoint[];
  emptyMessage?: string;
  tone?: Tone;
  footer?: ReactNode;
};

export function FinanceTrendPanel({
  title,
  total,
  subtitle,
  data,
  emptyMessage = 'Bu dönem için veri yok.',
  tone = 'success',
  footer,
}: FinanceTrendPanelProps) {
  const max = data.reduce((acc, p) => Math.max(acc, p.value), 0);
  const isEmpty = data.length === 0 || max === 0;

  return (
    <div className="finance-trend-panel">
      <div className="finance-trend-panel-header">
        <div className="finance-trend-panel-headline">
          <div className="finance-trend-panel-title">{title}</div>
          {subtitle ? (
            <div className="finance-trend-panel-subtitle">{subtitle}</div>
          ) : null}
        </div>
        {total !== undefined ? (
          <div className="finance-trend-panel-total">{total}</div>
        ) : null}
      </div>

      {isEmpty ? (
        <div className="finance-trend-panel-empty">{emptyMessage}</div>
      ) : (
        <FinanceTrendChart data={data} max={max} tone={tone} />
      )}

      {footer ? <div className="finance-trend-panel-footer">{footer}</div> : null}
    </div>
  );
}

function FinanceTrendChart({
  data,
  max,
  tone,
}: {
  data: FinanceTrendPoint[];
  max: number;
  tone: Tone;
}) {
  const colors = TONE_COLORS[tone];
  const innerW = VIEW_WIDTH - PADDING_X * 2;
  const innerH = VIEW_HEIGHT - PADDING_TOP - PADDING_BOTTOM;

  const xFor = (i: number) =>
    data.length > 1 ? PADDING_X + (i / (data.length - 1)) * innerW : PADDING_X + innerW / 2;
  const yFor = (value: number) =>
    PADDING_TOP + innerH - (value / max) * innerH;

  const points = data.map((d, i) => ({ x: xFor(i), y: yFor(d.value), datum: d }));

  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ');

  const baselineY = PADDING_TOP + innerH;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const areaPath = `M ${first.x.toFixed(2)} ${baselineY.toFixed(2)} ${points
    .map((p) => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ')} L ${last.x.toFixed(2)} ${baselineY.toFixed(2)} Z`;

  let peakIndex = 0;
  for (let i = 1; i < data.length; i++) {
    if (data[i]!.value > data[peakIndex]!.value) peakIndex = i;
  }
  const peak = points[peakIndex]!;
  const peakLeftPct = (peak.x / VIEW_WIDTH) * 100;
  const peakTopPct = (peak.y / VIEW_HEIGHT) * 100;

  const axisLabelIndexes = pickAxisIndexes(data.length, peakIndex);

  return (
    <div className="finance-trend-chart">
      <div className="finance-trend-chart-canvas">
        <svg
          className="finance-trend-chart-svg"
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Tahsilat trend grafiği"
        >
          {[0.25, 0.5, 0.75].map((ratio) => (
            <line
              key={ratio}
              x1={PADDING_X}
              x2={VIEW_WIDTH - PADDING_X}
              y1={PADDING_TOP + innerH * ratio}
              y2={PADDING_TOP + innerH * ratio}
              stroke="#e5e7eb"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              strokeDasharray="3 5"
            />
          ))}
          <line
            x1={PADDING_X}
            x2={VIEW_WIDTH - PADDING_X}
            y1={baselineY}
            y2={baselineY}
            stroke="#cbd5e1"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          <path d={areaPath} fill={colors.fill} />
          <path
            d={linePath}
            fill="none"
            stroke={colors.stroke}
            strokeWidth={2.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {data[peakIndex]!.value > 0 ? (
          <div
            className="finance-trend-chart-peak"
            style={{ left: `${peakLeftPct}%`, top: `${peakTopPct}%` }}
            title={`${data[peakIndex]!.longLabel ?? data[peakIndex]!.label}: ${
              data[peakIndex]!.displayValue ?? String(data[peakIndex]!.value)
            }`}
          >
            <span
              className="finance-trend-chart-peak-dot"
              style={{ borderColor: colors.stroke }}
            />
          </div>
        ) : null}
      </div>

      <div className="finance-trend-chart-axis">
        {axisLabelIndexes.map((i) => {
          const p = points[i]!;
          const leftPct = (p.x / VIEW_WIDTH) * 100;
          return (
            <span
              key={p.datum.key}
              className="finance-trend-chart-axis-label"
              style={{ left: `${leftPct}%` }}
            >
              {p.datum.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function pickAxisIndexes(length: number, peakIndex: number): number[] {
  if (length === 0) return [];
  if (length === 1) return [0];
  const set = new Set<number>();
  set.add(0);
  set.add(length - 1);
  if (length >= 5) {
    set.add(Math.floor((length - 1) / 2));
  }
  if (length >= 3 && peakIndex !== 0 && peakIndex !== length - 1) {
    set.add(peakIndex);
  }
  return Array.from(set).sort((a, b) => a - b);
}
