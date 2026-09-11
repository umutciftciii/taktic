'use client';

import { useRef } from 'react';
import { archiveShowcaseCardAction } from './actions';

/**
 * The card's dangerous action, behind a menu and a dialog. The wording is the
 * product rule: a card that never went live is *deleted* and gives its right
 * back; a live card is *archived* and its paid days keep running.
 *
 * `<details>` rather than a scripted popover, so the menu opens with no
 * JavaScript and its summary is a native, keyboard-reachable button. The
 * dialog is the one place a script is needed — `showModal()` — and the form
 * inside it posts the server action the ordinary way; a `method="dialog"`
 * would close the dialog instead of submitting.
 */
export function CardMenu({
  providerId,
  cardId,
  published,
}: {
  providerId: string;
  cardId: string;
  published: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const label = published ? 'Kartı arşivle' : 'Kartı sil ve yayın hakkını serbest bırak';

  return (
    <>
      <details className="vitrin-menu">
        <summary className="pdash-btn pdash-btn-ghost pdash-btn-sm" aria-label="Diğer işlemler">
          ⋯
        </summary>
        <div className="vitrin-menu-list" role="menu">
          <button
            type="button"
            role="menuitem"
            className="vitrin-menu-danger"
            onClick={() => dialog.current?.showModal()}
            data-testid="showcase-card-danger"
          >
            {label}
          </button>
        </div>
      </details>

      <dialog ref={dialog} className="vitrin-dialog" aria-labelledby="vitrin-danger-title">
        <form action={archiveShowcaseCardAction}>
          <input type="hidden" name="providerId" value={providerId} />
          <input type="hidden" name="cardId" value={cardId} />
          <input type="hidden" name="deleted" value={published ? '0' : '1'} />
          <h2 id="vitrin-danger-title">{label}</h2>
          <p>
            {published
              ? 'Kart yayından kalkar ve yeni talep almaz. Satın aldığınız vitrin süresi arşivdeyken de işlemeye devam eder; arşivde geçen günler süreye eklenmez.'
              : 'Kart kaldırılır. Bu karta bağlı vitrin hakkınız yeniden kullanılabilir olur; yeni bir kart için kullanabilirsiniz.'}
          </p>
          <div className="vitrin-form-foot" style={{ paddingBottom: 0 }}>
            <button
              type="button"
              className="pdash-btn pdash-btn-ghost"
              onClick={() => dialog.current?.close()}
            >
              Vazgeç
            </button>
            <button
              type="submit"
              className="pdash-btn pdash-btn-danger"
              data-testid="showcase-card-danger-confirm"
            >
              {published ? 'Arşivle' : 'Sil ve hakkı serbest bırak'}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
