export type FinanceSparklinePoint = {
  key: string;
  value: number;
  label?: string;
};

type Tone = 'success' | 'primary' | 'warning';

const TONE_COLORS: Record<Tone, { stroke: string; fill: string }> = {
  success: { stroke: '#16a34a', fill: 'rgba(22, 163, 74, 0.16)' },
  primary: { stroke: '#2563eb', fill: 'rgba(37, 99, 235, 0.16)' },
  warning: { stroke: '#d97706', fill: 'rgba(217, 119, 6, 0.16)' },
};

const VIEW_WIDTH = 240;
const VIEW_HEIGHT = 64;
const PADDING_Y = 6;

type FinanceMiniSparklineProps = {
  data: FinanceSparklinePoint[];
  tone?: Tone;
  ariaLabel?: string;
};

export function FinanceMiniSparkline({
  data,
  tone = 'primary',
  ariaLabel = 'Mini trend',
}: FinanceMiniSparklineProps) {
  const max = data.reduce((acc, p) => Math.max(acc, p.value), 0);
  if (data.length === 0 || max === 0) {
    return <div className="finance-mini-sparkline finance-mini-sparkline-empty">—</div>;
  }

  const colors = TONE_COLORS[tone];
  const innerH = VIEW_HEIGHT - PADDING_Y * 2;
  const xFor = (i: number) =>
    data.length > 1 ? (i / (data.length - 1)) * VIEW_WIDTH : VIEW_WIDTH / 2;
  const yFor = (value: number) => PADDING_Y + innerH - (value / max) * innerH;

  const points = data.map((d, i) => ({ x: xFor(i), y: yFor(d.value) }));
  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ');
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const areaPath =
    `M ${first.x.toFixed(2)} ${VIEW_HEIGHT} ` +
    points.map((p) => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ') +
    ` L ${last.x.toFixed(2)} ${VIEW_HEIGHT} Z`;

  return (
    <svg
      className="finance-mini-sparkline"
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
    >
      <path d={areaPath} fill={colors.fill} />
      <path
        d={linePath}
        fill="none"
        stroke={colors.stroke}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
