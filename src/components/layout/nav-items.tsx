import type { ReactNode } from "react";

export interface NavItem {
  href: string;
  label: string;
  /** Shown as a tooltip, and as the subtitle in the mobile drawer. */
  hint: string;
  icon: ReactNode;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      className="h-[18px] w-[18px] shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/**
 * Grouped so the daily drivers sit above the things consulted occasionally.
 * One source of truth — the desktop rail, the mobile drawer and the tablet bar
 * all render from this.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Daily",
    items: [
      {
        href: "/",
        label: "Today",
        hint: "Daily operating view",
        icon: <Icon><path d="M3 12h3l2.5-7 4 14 2.5-7H21" /></Icon>,
      },
      {
        href: "/backlog",
        label: "Backlog",
        hint: "All tasks with filters and edits",
        icon: <Icon><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></Icon>,
      },
      {
        href: "/sprints",
        label: "Sprints",
        hint: "Week-level planning and sprint snapshots",
        icon: <Icon><path d="M5 21V4m0 0 9 2.5L5 9" /><path d="M5 9h9l5 4-5 4H5" /></Icon>,
      },
    ],
  },
  {
    label: "Portfolio",
    items: [
      {
        href: "/applications",
        label: "Applications",
        hint: "Portfolio health and updates",
        icon: <Icon><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /></Icon>,
      },
      {
        href: "/projects",
        label: "Projects",
        hint: "Track work within applications",
        icon: <Icon><path d="M3 7a2 2 0 0 1 2-2h3.5l2 2.5H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></Icon>,
      },
      {
        href: "/stakeholders",
        label: "Stakeholders",
        hint: "People and commitments",
        icon: <Icon><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16 5.5a3 3 0 0 1 0 5.8M17.5 20a5.5 5.5 0 0 0-2-4.3" /></Icon>,
      },
    ],
  },
  {
    label: "Review",
    items: [
      {
        href: "/weekly-review",
        label: "Weekly Review",
        hint: "What shipped, what stalled, what needs attention",
        icon: <Icon><path d="M4 19V5" /><path d="M4 19h16" /><path d="m7.5 15 3.5-4 3 2.5L20 7" /></Icon>,
      },
      {
        href: "/calendar",
        label: "Calendar",
        hint: "Imported schedule metadata",
        icon: <Icon><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></Icon>,
      },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

export function isActive(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === href;
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
