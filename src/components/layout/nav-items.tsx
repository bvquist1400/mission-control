import type { ReactNode } from "react";

export interface NavItem {
  href: string;
  label: string;
  /** Shown as a tooltip, and as the line under the name in the More menu. */
  hint: string;
  icon: ReactNode;
  /** Other paths that count as this item for the active marker. */
  also?: string[];
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5 shrink-0"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="square"
    >
      {children}
    </svg>
  );
}

/**
 * The top bar (redesign S1, menu B): Today · Tasks · Portfolio · Launch · More.
 * One source of truth: the desktop bar, the phone tab bar and the More menu all
 * render from these two lists, and the `g` shortcuts in ShortcutsDialog point
 * at them. Never link a page from only one of them.
 */
export const PRIMARY_NAV: NavItem[] = [
  {
    href: "/",
    label: "Today",
    hint: "Your week, meetings and what to do now",
    icon: (
      <Icon>
        <rect x="3" y="4" width="14" height="13" />
        <path d="M3 8h14M7 2v4M13 2v4" />
      </Icon>
    ),
  },
  {
    href: "/backlog",
    label: "Tasks",
    hint: "Every task, with filters and edits",
    icon: (
      <Icon>
        <path d="M7 5h10M7 10h10M7 15h10" />
        <rect x="2.5" y="3.5" width="2.5" height="2.5" />
        <rect x="2.5" y="8.5" width="2.5" height="2.5" />
        <rect x="2.5" y="13.5" width="2.5" height="2.5" />
      </Icon>
    ),
  },
  {
    href: "/portfolio",
    label: "Portfolio",
    hint: "What needs you, % done and a timeline per app",
    also: ["/r"],
    icon: (
      <Icon>
        <rect x="3" y="3" width="6" height="6" />
        <rect x="11" y="3" width="6" height="6" />
        <rect x="3" y="11" width="6" height="6" />
        <rect x="11" y="11" width="6" height="6" />
      </Icon>
    ),
  },
  {
    href: "/launch",
    label: "Launch",
    hint: "Menu & Market launch numbers",
    icon: (
      <Icon>
        <path d="M3 17V11M8 17V7M13 17V9M18 17V3" />
      </Icon>
    ),
  },
];

/** Under "More". The page-view data (~11/19) may still change what sits here. */
export const MORE_NAV: NavItem[] = [
  {
    href: "/applications",
    label: "Applications",
    hint: "Each app's health and updates",
    also: ["/implementations"],
    icon: (
      <Icon>
        <path d="m10 3 7 4-7 4-7-4 7-4Z" />
        <path d="m3 11 7 4 7-4" />
      </Icon>
    ),
  },
  {
    href: "/projects",
    label: "Projects",
    hint: "Projects, sections and templates",
    icon: (
      <Icon>
        <path d="M3 6h5l2 2h7v9H3z" />
      </Icon>
    ),
  },
  {
    href: "/calendar",
    label: "Calendar",
    hint: "Imported meetings",
    icon: (
      <Icon>
        <rect x="3" y="4" width="14" height="13" />
        <path d="M3 8h14M7 2v4M13 2v4M7 11h2M11 11h2M7 14h2" />
      </Icon>
    ),
  },
];

export const MORE_ICON = (
  <Icon>
    <path d="M3 6h14M3 10h14M3 14h14" />
  </Icon>
);

export const NAV_ITEMS: NavItem[] = [...PRIMARY_NAV, ...MORE_NAV];

function matchesPath(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === href;
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function isActive(pathname: string, item: NavItem | string): boolean {
  if (typeof item === "string") return matchesPath(pathname, item);
  return [item.href, ...(item.also ?? [])].some((href) => matchesPath(pathname, href));
}

/** The More tab is lit when the page is one of its items. */
export function isMoreActive(pathname: string): boolean {
  return MORE_NAV.some((item) => isActive(pathname, item));
}
