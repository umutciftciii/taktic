import type { ReactNode } from 'react';

type SectionCardProps = {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  padded?: boolean;
  className?: string;
  /** Anchor target, so an action can send the operator back to this card. */
  id?: string;
};

export function SectionCard({
  title,
  subtitle,
  actions,
  children,
  padded = true,
  className,
  id,
}: SectionCardProps) {
  const rootClass = ['section-card', padded ? 'is-padded' : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <section className={rootClass} id={id}>
      {title || actions ? (
        <header className="section-card-header">
          <div className="section-card-text">
            {title ? <h2 className="section-card-title">{title}</h2> : null}
            {subtitle ? <p className="section-card-subtitle">{subtitle}</p> : null}
          </div>
          {actions ? <div className="section-card-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="section-card-body">{children}</div>
    </section>
  );
}
