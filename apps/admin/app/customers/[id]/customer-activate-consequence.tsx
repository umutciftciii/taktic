/**
 * What `PATCH /customers/:id/status { isActive: true }` does: the flag and
 * nothing else (customers.service.ts `updateStatus`). Asked before since
 * ADMIN-DESTRUCTIVE-CONFIRMATION-001 Faz 2, with no reason to give.
 */
export function CustomerActivateConsequence({ hasPassword }: { hasPassword: boolean }) {
  return (
    <>
      <p>
        {hasPassword
          ? 'Müşteri yeniden giriş yapabilir.'
          : 'Müşterinin hesabı yeniden açılır; henüz şifre belirlemediği için giriş yapabilmesi bir şifre belirleme bağlantısıyla olur.'}{' '}
        Aynı telefon ve e-postayla yeniden yeni talep verebilir.
      </p>
      <p>
        Önceki talepleri, teklifleri ve notları olduğu gibi kalır; geçmiş değişmez. Müşteriye otomatik mesaj gitmez.
        Hesap buradan yeniden pasife alınabilir.
      </p>
    </>
  );
}
