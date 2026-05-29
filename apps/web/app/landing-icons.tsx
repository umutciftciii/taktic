// Inline icon set for the landing page. No external dependencies.
import type { ComponentType, ReactElement, SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };
export type IconComponent = ComponentType<IconProps>;
export type IconRenderer = (props: IconProps) => ReactElement;

function base({ size = 18, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...rest,
  };
}

export function IconSearch(props: IconProps) {
  return (
    <svg {...base(props)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function IconCheck({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...base({ size, strokeWidth: 3, ...rest })}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function IconX({ size = 12, ...rest }: IconProps) {
  return (
    <svg {...base({ size, strokeWidth: 2.5, ...rest })}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function IconPlus({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...base({ size, strokeWidth: 2.5, ...rest })}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}

export function IconArrowRight({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}

export function IconPin({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <path d="M20 10c0 7-8 12-8 12s-8-5-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

export function IconPhone({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

export function IconWallet({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2" />
      <path d="M21 11h-6a2 2 0 0 0 0 4h6v-4Z" />
    </svg>
  );
}

export function IconShield({ size = 18, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </svg>
  );
}

export function IconClipList({ size = 18, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M9 12h6" />
      <path d="M9 16h4" />
    </svg>
  );
}

export function IconUsers({ size = 18, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

export function IconTrendingUp({ size = 12, ...rest }: IconProps) {
  return (
    <svg {...base({ size, strokeWidth: 2.5, ...rest })}>
      <path d="M22 7 13.5 15.5 8.5 10.5 2 17" />
      <path d="M16 7h6v6" />
    </svg>
  );
}

export function IconMenu({ size = 20, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <path d="M4 12h16" />
      <path d="M4 6h16" />
      <path d="M4 18h16" />
    </svg>
  );
}

export function IconEdit({ size = 20, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    </svg>
  );
}

export function IconCompare({ size = 20, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <path d="M16 3h5v5" />
      <path d="M8 3H3v5" />
      <path d="M21 16v5h-5" />
      <path d="M3 16v5h5" />
      <path d="M21 3 14 10" />
      <path d="m3 21 7-7" />
    </svg>
  );
}

export function IconThumbsUp({ size = 20, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <path d="M7 10v12" />
      <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H7" />
    </svg>
  );
}

export function IconSnowflake({ size = 20, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <path d="M2 12h20" />
      <path d="M12 2v20" />
      <path d="m20 16-4-4 4-4" />
      <path d="m4 8 4 4-4 4" />
      <path d="m16 4-4 4-4-4" />
      <path d="m8 20 4-4 4 4" />
    </svg>
  );
}

export function IconWrench({ size = 20, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

export function IconFlame({ size = 20, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
}

export function IconBolt({ size = 20, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
    </svg>
  );
}

export function IconDrop({ size = 20, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z" />
    </svg>
  );
}

export function IconBrush({ size = 20, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" />
      <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" />
    </svg>
  );
}

export function IconSparkles({ size = 20, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
    </svg>
  );
}

export function IconTruck({ size = 20, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
      <path d="M15 18H9" />
      <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
      <circle cx="17" cy="18" r="2" />
      <circle cx="7" cy="18" r="2" />
    </svg>
  );
}

export function IconBox({ size = 20, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  );
}

export function IconBook({ size = 20, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
    </svg>
  );
}

export function IconTool({ size = 20, ...rest }: IconProps) {
  return (
    <svg {...base({ size, ...rest })}>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

const categoryIconSet: Array<[string, IconComponent]> = [
  ['klima', IconSnowflake],
  ['kombi', IconFlame],
  ['elektrik', IconBolt],
  ['su tesisat', IconDrop],
  ['tesisat', IconDrop],
  ['boya', IconBrush],
  ['badana', IconBrush],
  ['temiz', IconSparkles],
  ['nakli', IconTruck],
  ['mobilya', IconBox],
  ['montaj', IconWrench],
  ['servis', IconTool],
  ['ders', IconBook],
];

export function iconForCategory(name: string): IconComponent {
  const lower = name.toLocaleLowerCase('tr');
  for (const [key, Icon] of categoryIconSet) {
    if (lower.includes(key)) {
      return Icon;
    }
  }
  return IconSparkles;
}
