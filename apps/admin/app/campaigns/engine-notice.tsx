/**
 * The one sentence every campaign screen carries (CMP-002 S1).
 *
 * Read from the database on each render — `engineEnabled` is the
 * OperationsSettings column, fail-closed — so the badge says what is true
 * rather than what this slice assumes. In this slice no screen can turn the
 * engine on; the "on" branch exists so the sentence cannot lie if the column
 * were ever set by hand.
 */
export function CampaignEngineNotice({ engineEnabled }: { engineEnabled: boolean }) {
  if (engineEnabled) {
    return (
      <div className="notice notice-warning" role="status" data-testid="campaign-engine-state" data-engine="on">
        <strong>Kampanya motoru anahtarı açık görünüyor</strong>, ancak bu sürümde motor kodu yok: hiçbir
        kampanya değerlendirilmez, kredi verilmez. Kampanyalar taslak olarak kalır.
      </div>
    );
  }
  return (
    <div className="notice notice-warning" role="status" data-testid="campaign-engine-state" data-engine="off">
      <strong>Kampanya motoru kapalı — yalnız taslak.</strong> Burada tanımlanan kampanyalar saklanır ama
      çalıştırılmaz; hiçbir hizmet verene kredi verilmez, hiçbir olay değerlendirilmez.
    </div>
  );
}
