import type { ReactNode } from 'react';

/**
 * The band under a detail screen's edit form (ADMIN-DESIGN-001 Faz 3F.1): what
 * saving does and does not touch on the left, Vazgeç and the save button on
 * the right.
 *
 * Vazgeç is a reset button — it puts every field back to the values the page
 * was drawn with and sends nothing — so it needs no route and no script. The
 * save button is the screen's own, passed as a child, with the label its
 * tests already know.
 */
export function DetailFormFooter({ note, children }: { note?: ReactNode; children: ReactNode }) {
  return (
    <div className="detail-form-footer">
      {note ? <p className="detail-form-footer-note">{note}</p> : null}
      <div className="detail-form-footer-actions">
        <button className="btn btn-secondary" type="reset">
          Vazgeç
        </button>
        {children}
      </div>
    </div>
  );
}

/**
 * A value shown in a form's grid that the form does not send: the design's
 * dashed box with "DEĞİŞTİRİLEMEZ". Only for fields that genuinely cannot be
 * edited on this screen — the API refuses them, or they are written once.
 */
export function LockedField({
  label,
  value,
  help,
  className = 'field field-4',
  testId,
}: {
  label: ReactNode;
  value: ReactNode;
  help?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={className}>
      <span>{label}</span>
      <div className="locked-field" data-testid={testId}>
        <span className="locked-field-value">{value}</span>
        <span className="locked-field-tag">Değiştirilemez</span>
      </div>
      {help ? <span className="help-text">{help}</span> : null}
    </div>
  );
}
