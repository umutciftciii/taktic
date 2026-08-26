import type { ComponentType, ReactElement, SVGProps } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Boxes,
  Check,
  ChevronDown,
  ClipboardList,
  CircleHelp,
  Droplet,
  Flame,
  LayoutGrid,
  type LucideIcon,
  Mail,
  Menu,
  MessageSquare,
  Paintbrush,
  Phone,
  Plus,
  Search,
  Send,
  Settings,
  Shield,
  Snowflake,
  Sparkles,
  SquareUser,
  Coins,
  Compass,
  ScrollText,
  MapPin,
  Star,
  ThumbsUp,
  TrendingUp,
  Truck,
  User,
  Users,
  Wallet,
  Wrench,
  X,
} from 'lucide-react';

/**
 * The design's icon set is Lucide. The prototype drew arrows and marks with
 * text characters (→ ← ✓ ✕); production uses the Lucide equivalents, which is
 * what this module exists to provide.
 *
 * The exported names are the ones the screens already import, so swapping the
 * drawing layer never rippled through the markup.
 */
export type IconProps = SVGProps<SVGSVGElement> & { size?: number };
export type IconComponent = ComponentType<IconProps>;
export type IconRenderer = (props: IconProps) => ReactElement;

function wrap(Glyph: LucideIcon, defaultSize: number): IconComponent {
  function Wrapped({ size = defaultSize, ...rest }: IconProps) {
    return <Glyph size={size} strokeWidth={2} aria-hidden="true" {...rest} />;
  }

  Wrapped.displayName = `Icon(${Glyph.displayName ?? 'Lucide'})`;
  return Wrapped;
}

export const IconSearch = wrap(Search, 18);
export const IconCheck = wrap(Check, 14);
export const IconX = wrap(X, 12);
export const IconPlus = wrap(Plus, 14);
export const IconArrowRight = wrap(ArrowRight, 14);
export const IconArrowLeft = wrap(ArrowLeft, 14);
export const IconChevronDown = wrap(ChevronDown, 14);
export const IconPin = wrap(MapPin, 14);
export const IconPhone = wrap(Phone, 14);
export const IconMail = wrap(Mail, 14);
export const IconWallet = wrap(Wallet, 16);
export const IconShield = wrap(Shield, 18);
export const IconClipList = wrap(ClipboardList, 18);
export const IconUsers = wrap(Users, 18);
export const IconUser = wrap(User, 16);
export const IconTrendingUp = wrap(TrendingUp, 12);
export const IconMenu = wrap(Menu, 20);
export const IconEdit = wrap(ScrollText, 20);
export const IconCompare = wrap(LayoutGrid, 20);
export const IconThumbsUp = wrap(ThumbsUp, 20);
export const IconSnowflake = wrap(Snowflake, 20);
export const IconWrench = wrap(Wrench, 20);
export const IconFlame = wrap(Flame, 20);
export const IconBolt = wrap(Sparkles, 20);
export const IconDrop = wrap(Droplet, 20);
export const IconBrush = wrap(Paintbrush, 20);
export const IconSparkles = wrap(Sparkles, 20);
export const IconTruck = wrap(Truck, 20);
export const IconBox = wrap(Boxes, 20);
export const IconBook = wrap(ScrollText, 20);
export const IconTool = wrap(Wrench, 20);
export const IconGrid = wrap(LayoutGrid, 18);
export const IconCompass = wrap(Compass, 18);
export const IconSend = wrap(Send, 18);
export const IconCoins = wrap(Coins, 18);
export const IconPackage = wrap(Boxes, 18);
export const IconProfile = wrap(SquareUser, 18);
export const IconMessage = wrap(MessageSquare, 18);
export const IconSettings = wrap(Settings, 18);
export const IconBell = wrap(Bell, 16);
export const IconHelp = wrap(CircleHelp, 16);
export const IconStar = wrap(Star, 14);

/** Slug/name fragment → illustration stand-in, used when a category has no image. */
const categoryIconSet: ReadonlyArray<readonly [string, IconComponent]> = [
  ['klima', IconSnowflake],
  ['kombi', IconFlame],
  ['elektrik', IconBolt],
  ['tesisat', IconDrop],
  ['su', IconDrop],
  ['boya', IconBrush],
  ['badana', IconBrush],
  ['temiz', IconSparkles],
  ['nakli', IconTruck],
  ['taşı', IconTruck],
  ['tadilat', IconTool],
  ['montaj', IconWrench],
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

const iconByKeyMap: Record<string, IconComponent> = {
  snowflake: IconSnowflake,
  flame: IconFlame,
  bolt: IconBolt,
  drop: IconDrop,
  brush: IconBrush,
  sparkles: IconSparkles,
  truck: IconTruck,
  box: IconBox,
  wrench: IconWrench,
  tool: IconTool,
  book: IconBook,
};

export function iconByKey(key: string | null | undefined): IconComponent | null {
  if (!key) return null;
  const normalized = key.trim().toLowerCase();
  if (!normalized) return null;
  return iconByKeyMap[normalized] ?? null;
}
