import type { ReactNode } from 'react';
import { Breadcrumbs, type BreadcrumbItem } from './breadcrumbs';
import { InfoPopover } from './info-popover';

type PageHeaderProps = {
  title: ReactNode;
  /** The one-line summary under the title ("148 talep · en son 4 dakika önce geldi"). */
  subtitle?: ReactNode;
  breadcrumbs?: BreadcrumbItem[];
  actions?: ReactNode;
  /**
   * What the ⓘ beside the title explains: what this screen is and what it
   * will not do. Omitted, the header renders exactly as it did before the ⓘ
   * existed, so screens that do not pass it are unchanged.
   */
  info?: ReactNode;
  /** The ⓘ trigger's accessible name. */
  infoLabel?: string;
};

export function PageHeader({
  title,
  subtitle,
  breadcrumbs,
  actions,
  info,
  infoLabel = 'Bu ekran ne işe yarar?',
}: PageHeaderProps) {
  const heading = <h1 className="page-title">{title}</h1>;

  return (
    <header className="page-header">
      {breadcrumbs && breadcrumbs.length > 0 ? <Breadcrumbs items={breadcrumbs} /> : null}
      <div className="page-header-row">
        <div className="page-header-text">
          {info ? (
            <div className="page-title-row">
              {heading}
              <InfoPopover label={infoLabel} testId="page-info">
                {info}
              </InfoPopover>
            </div>
          ) : (
            heading
          )}
          {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="page-header-actions">{actions}</div> : null}
      </div>
    </header>
  );
}
