/**
 * The one sentence every campaign screen carries (CMP-002 S1, S2B2).
 *
 * Read from the database on each render — `engineEnabled` is the
 * OperationsSettings column, fail-closed — so the badge says what is true
 * rather than what this slice assumes. No admin screen can turn the engine
 * on; while it is off, activation and resumption are refused by the API and
 * the screen says so before the operator tries.
 */
export function CampaignEngineNotice({ engineEnabled }: { engineEnabled: boolean }) {
  if (engineEnabled) {
    return (
      <div className="notice notice-info" role="status" data-testid="campaign-engine-state" data-engine="on">
        <strong>Kampanya motoru açık.</strong> Etkin kampanyalar gerçek olaylarda (onay, kanıt, ödeme) değerlendirilir ve
        hak ediş promosyon kredisi olarak yazılır. Bu ekran motoru kapatamaz.
      </div>
    );
  }
  return (
    <div className="notice notice-warning" role="status" data-testid="campaign-engine-state" data-engine="off">
      <strong>Kampanya motoru kapalı — etkinleştirme yapılamaz.</strong> Kampanyalar tanımlanır ve saklanır; hiçbir olay
      değerlendirilmez, hiçbir hizmet verene kredi verilmez. Etkinleştir ve devam ettir motor açılana kadar reddedilir;
      bu ekranda motoru açan bir düğme yoktur.
    </div>
  );
}
