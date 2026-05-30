import Link from 'next/link';
import type { ReactNode } from 'react';

export type BreadcrumbItem = {
  label: ReactNode;
  href?: string;
};

type BreadcrumbsProps = {
  items: BreadcrumbItem[];
  className?: string;
};

export function Breadcrumbs({ items, className }: BreadcrumbsProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <nav aria-label="Sayfa konumu" className={className ? `breadcrumbs ${className}` : 'breadcrumbs'}>
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        return (
          <span className="breadcrumbs-item" key={`${index}-${typeof item.label === 'string' ? item.label : index}`}>
            {item.href && !isLast ? (
              <Link href={item.href}>{item.label}</Link>
            ) : (
              <span aria-current={isLast ? 'page' : undefined}>{item.label}</span>
            )}
            {!isLast ? (
              <span className="breadcrumbs-sep" aria-hidden="true">
                /
              </span>
            ) : null}
          </span>
        );
      })}
    </nav>
  );
}
