import { IconCompare, IconEdit, IconThumbsUp } from './landing-icons';
import type { IconComponent } from './landing-icons';

export type Step = {
  n: number;
  title: string;
  desc: string;
  Icon: IconComponent;
};

/** The three steps of "3 adımda teklif al", in the order the customer takes them. */
export const steps: Step[] = [
  {
    n: 1,
    Icon: IconEdit,
    title: 'İhtiyacını anlat',
    desc:
      'Kategoriye özel soruları yanıtla, lokasyon ve zaman bilgisini gir. Talebin kalite skoru ile yayına alınır.',
  },
  {
    n: 2,
    Icon: IconCompare,
    title: 'Teklifleri karşılaştır',
    desc:
      'Uygun hizmet verenlerden gelen teklifleri fiyat, deneyim ve açıklamaya göre incele.',
  },
  {
    n: 3,
    Icon: IconThumbsUp,
    title: 'Uygun olanı seç',
    desc:
      'Beğendiğin teklifi kabul et; eşleşme kaydedildiğinde iletişim bilgileri karşılıklı paylaşılır.',
  },
];

/**
 * One step card.
 *
 * The number, the icon and the title are one heading block: the icon in a
 * framed box on the left, the number and the title stacked beside it. Laid
 * out as three loose rows they read as three unrelated things, and across
 * three cards the icons lined up into a strip that belonged to no step.
 */
export function StepCard({ step }: { step: Step }) {
  const { Icon: StepIcon } = step;
  return (
    <article className="lp-step-card">
      <div className="lp-step-head">
        <span className="lp-step-icon">
          <StepIcon size={20} />
        </span>
        <div className="lp-step-head-text">
          <span className="lp-step-num">0{step.n}</span>
          <h3 className="lp-step-title">{step.title}</h3>
        </div>
      </div>
      <p className="lp-step-desc">{step.desc}</p>
    </article>
  );
}
