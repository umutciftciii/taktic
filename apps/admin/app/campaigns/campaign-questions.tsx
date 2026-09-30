import { InfoPopover } from '../../components/info-popover';

/**
 * The design's "Bir kampanya üç sorudan oluşur" card (ADMIN-DESIGN-001 Faz 3E).
 *
 * Static text, no data: it names the three parts of every definition the way
 * the builder groups them — who it covers (trigger, channel, conditions),
 * what it gives (the benefit) and when it stops (limits, budget, window).
 * Every sentence is written against what the engine actually does; the
 * design's own examples ("30 gündür teklif vermeyenler", "sınır dolunca
 * kendiliğinden durur") are not conditions or behaviours this engine has.
 */
export const CAMPAIGN_QUESTIONS = [
  {
    key: 'covers',
    step: '1 · Kimi kapsıyor',
    title: 'Hangi olayda, hangi hizmet verenler',
    body: 'Tetikleyici olay (hizmet veren onayı, paket ödemesi ya da uygunluk geçişi), kanal ve koşullar. Koşulları sağlamayan hizmet veren o olayda hak ediş almaz.',
  },
  {
    key: 'gives',
    step: '2 · Ne veriyor',
    title: 'Kaç promosyon kredisi, kaç gün geçerli',
    body: 'Hak ediş süreli promosyon kredisi olarak yazılır ve kredi hareketlerinde kampanya adıyla görünür; satın alınmış kredi sayılmaz.',
  },
  {
    key: 'stops',
    step: '3 · Ne zaman duruyor',
    title: 'Limitler, bütçe ve zaman penceresi',
    body: 'Limit ya da bütçe dolunca yeni hak ediş üretilmez; günlük geri alma eşiği aşılırsa kampanya kendini duraklatır. Elle duraklatılabilir ya da sonlandırılabilir.',
  },
] as const;

export function CampaignQuestions() {
  return (
    <section className="campaign-questions" aria-labelledby="campaign-questions-title" data-testid="campaign-questions">
      <header className="campaign-questions-head">
        <h2 id="campaign-questions-title">Bir kampanya üç sorudan oluşur</h2>
        <InfoPopover label="Kampanya nasıl çalışır?" size="sm">
          Kaydetmek hiçbir kampanyayı çalıştırmaz: her kayıt değiştirilemez yeni bir sürümdür. Bir sürüm yalnız kampanya
          ayrıntısındaki yaşam döngüsü panelinden, kampanya motoru açıkken etkinleştirilir; motor geçmiş olaylar için hak
          ediş üretmez.
        </InfoPopover>
      </header>
      <ol className="campaign-questions-list">
        {CAMPAIGN_QUESTIONS.map((question) => (
          <li key={question.key} className="campaign-question">
            <p className="campaign-question-step">{question.step}</p>
            <h3 className="campaign-question-title">{question.title}</h3>
            <p className="campaign-question-body">{question.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
