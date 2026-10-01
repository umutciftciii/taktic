import { formatCount } from '../../../../lib/pagination';

/**
 * What "Kredi ekle" does, said before it happens
 * (ADMIN-DESTRUCTIVE-CONFIRMATION-001). The figures are the form's own — the
 * one parsed amount and the balance the page read — so the dialog cannot
 * describe a different grant from the one the form sends.
 *
 * The ledger behaviour it describes is `CreditsService.grant`: one ADMIN_GRANT
 * row carrying the amount, the reason and the operator, no edit and no delete.
 */
export function CreditGrantConsequence({
  businessName,
  amount,
  balanceBefore,
  balanceAfter,
  reason,
}: {
  businessName: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  reason: string;
}) {
  return (
    <>
      <p data-testid="credit-grant-impact">
        <strong>{businessName}</strong> bakiyesine <strong>{formatCount(amount)} kredi</strong> eklenir: bakiye{' '}
        {formatCount(balanceBefore)} → {formatCount(balanceAfter)}. İşletme bu krediyi hemen teklif vermek için
        harcayabilir.
      </p>
      <p data-testid="credit-grant-reason">Sebep: “{reason.trim()}”</p>
      <p>
        Hareket, bu sebep ve sizin adınızla kredi hareketlerine kalıcı bir kayıt olarak yazılır; düzenlenemez ve
        silinemez. Yanlış bir ekleme ancak ayrı bir kredi düşme işlemiyle dengelenebilir — işletme krediyi harcadıysa o
        kısım geri alınamaz.
      </p>
    </>
  );
}
