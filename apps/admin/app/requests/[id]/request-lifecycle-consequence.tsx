import type { ReactNode } from 'react';

/**
 * What the request screen's lifecycle confirmations say
 * (ADMIN-DESTRUCTIVE-CONFIRMATION-001, Faz 2). Plain module (no 'use client'):
 * the server page draws every dialog with it and the unit tests render it.
 *
 * Each text is the API's behaviour, written before it happens
 * (service-requests.service.ts, request-publish-outbox.service.ts,
 * review-invitation-outbox.service.ts). The number of providers an approval
 * would reach is not shown: the panel has no read for it, and a count made up
 * here would be a promise the fan-out does not keep. The sentence stays
 * general instead.
 */

/** The publication window, the same constant the expiry scheduler runs on. */
export const REQUEST_PUBLISH_DAYS = 14;

/** SUBMITTED / IN_REVIEW → APPROVED: `updateServiceRequestStatus` + the publish outbox. */
export function requestApproveConsequence(): ReactNode {
  return (
    <>
      <p>
        Talep yayına çıkar: kategorisi ve bölgesi eşleşen onaylı hizmet verenler talebi görebilir ve teklif
        verebilir.
      </p>
      <p>
        {REQUEST_PUBLISH_DAYS} günlük yayın süresi onay anında başlar; süre dolduğunda talep zamanlayıcı tarafından
        kapatılır.
      </p>
      <p>
        Müşteriye talebinin yayına çıktığı bildirimi gider ve eşleşen hizmet verenlere yeni talep bildirimi
        gönderilir. Vitrin kartıyla tek bir işletmeye ayrılmış talepte bu toplu bildirimler gönderilmez.
      </p>
    </>
  );
}

/** APPROVED → IN_REVIEW: the guarded moderation write; offers are left alone. */
export function requestUnpublishConsequence(): ReactNode {
  return (
    <>
      <p>
        Talep geçici olarak yayından kalkar ve incelemeye döner: hizmet verenler talebi artık eşleşen talepler
        arasında görmez.
      </p>
      <p>Açık teklifler kapanmaz ve kredileri iade edilmez; teklifler olduğu gibi kalır.</p>
      <p>
        Talep yeniden onaylanırsa {REQUEST_PUBLISH_DAYS} günlük yayın süresi baştan başlar ve müşteriye yeniden yayın
        e-postası gidebilir. Daha önce bildirim almış hizmet verenlere ikinci kez bildirim gitmez.
      </p>
    </>
  );
}

/** MATCHED → COMPLETED (SUPER_ADMIN): `completeServiceRequest` + the review invitation outbox. */
export function requestCompleteConsequence(): ReactNode {
  return (
    <>
      <p>Talep “Tamamlandı” durumuna geçer: hizmet verilmiş ve iş kapanmış sayılır. Kredi hareketi olmaz.</p>
      <p>
        Hizmet veren değerlendirmeleri açıksa müşteriye, eşleştiği hizmet vereni değerlendirmesi için davet
        e-postası gider.
      </p>
      <p>
        Bu bir kapanış durumudur: tamamlanan talep mevcut panel ve API ile geri alınamaz, iptal edilemez ve
        reddedilemez.
      </p>
    </>
  );
}

/** REJECTED (report removal) → APPROVED: `reopenAfterRemoval`, i.e. the ordinary approval. */
export function requestReopenConsequence(): ReactNode {
  return (
    <>
      <p>Talep yeniden yayına çıkar ve onaylı duruma geçer; kayıtlı ret gerekçesi silinir.</p>
      <p>Onay zamanı yenilenir: {REQUEST_PUBLISH_DAYS} günlük yayın süresi baştan başlar.</p>
      <p>Kaldırma sırasında kapatılan teklifler geri açılmaz; yapılan kredi iadeleri geri alınmaz.</p>
      <p>
        Müşteriye talebinin yeniden yayına çıktığı bildirimi gider. Eşleşen ve bu talebe daha önce bildirim almamış
        hizmet verenlere yeni talep bildirimi gidebilir; daha önce bildirim almış olanlara ikinci kez gitmez.
      </p>
    </>
  );
}

/** Reports resolved as DISMISSED: every open report closes; nothing else moves. */
export function reportDismissConsequence(openCount: number): ReactNode {
  return (
    <>
      <p>
        {openCount === 1 ? 'Açık bildirim' : `${openCount} açık bildirimin hepsi`} “Uygun bulundu” kararıyla
        kapanır.
      </p>
      <p>Kapanan bildirimleri yeniden açan bir işlem yok; bu karar sonradan geri alınamaz.</p>
      <p>
        Talep, teklifler ve krediler olduğu gibi kalır; kimseye e-posta gönderilmez. Yazdığınız not yalnız
        yöneticilere görünür.
      </p>
    </>
  );
}
