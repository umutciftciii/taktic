'use client';

import Link from 'next/link';
import { useId, useState } from 'react';

type FooterGroupProps = {
  title: string;
  links: Array<{ label: string; href: string }>;
};

/**
 * One column of the site footer: a heading over a list of links on a desktop,
 * a collapsible group on a phone.
 *
 * The desktop footer is four columns beside the brand, and a phone used to get
 * the same four lists stacked one under another — a 1,100px footer under every
 * public page, longer than most of the pages it closed. Below 640px each group
 * folds to its title; the list opens on demand.
 *
 * Both controls are in the markup and CSS decides which one exists: the <h2>
 * on a desktop, the button on a phone. `display: none` takes the other out of
 * the accessibility tree as well as out of sight, so neither width announces a
 * heading and a button for the same group. The list itself is the same element
 * on both — no link is rendered twice.
 *
 * A client component for one boolean. Collapsed is the server's answer too, so
 * hydration changes nothing on screen; the legal links that must never be one
 * tap away are also in the footer's bottom row, which does not fold.
 */
export function FooterGroup({ title, links }: FooterGroupProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();

  return (
    <div className={open ? 'lp-footer-col is-open' : 'lp-footer-col'}>
      <h2 className="lp-footer-col-title">{title}</h2>
      <button
        type="button"
        className="lp-footer-col-toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{title}</span>
        <span className="lp-footer-col-caret" aria-hidden="true">
          {open ? '−' : '+'}
        </span>
      </button>
      <ul id={listId}>
        {links.map((link) => (
          <li key={link.label}>
            <Link href={link.href}>{link.label}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
