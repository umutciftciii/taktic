# STG-003B — Müşteri adresini serbest bırakma

Bir talep tarafından oluşturulmuş, kimsenin sahiplenmediği bir müşteri
hesabının e-posta adresini başka bir hesabın alabilmesi için serbest bırakma.
İlk kullanım: süper yönetici devrinde hedef adres
([super-admin-transition.md](super-admin-transition.md)) böyle bir hesapta
duruyorsa (`inspect` → `refused`).

Araç: `apps/api/src/scripts/release-customer-email.ts` (image içinde
`dist/scripts/release-customer-email.js`).

## Ne yapar, ne yapmaz

- **Yalnız sahipsiz hesap:** `CUSTOMER`, `customerOrigin = AUTO_CREATED_REQUEST`,
  parolası yok, adresi kanıtlanmamış (`emailVerifiedAt` NULL), esnaf profili ve
  personel rolü yok. Diğer her durumda araç reddeder.
- **Hesap iki kez adlandırılır:** `--user-id` ve hesabın şu an tuttuğu adres
  (`--email`, `--confirm-email` ile tekrar). Biri yanlışsa hiçbir şey olmaz.
- **Değişen tek alan:** `User.email` → `released-<id>@account.invalid`
  (RFC 2606 `.invalid`: teslim edilemez; benzersiz; `User_email_normalized_check`
  ile uyumlu). `emailVerifiedAt` NULL kalır.
- **Aynı transaction'da:** hesabın açık aktivasyon, şifre sıfırlama ve e-posta
  doğrulama bağlantıları kullanılmış sayılır, tüm oturumları kapanır. Eski
  adrese gitmiş bir aktivasyon bağlantısı artık hesabı açamaz.
- **Hiç değişmeyen:** hesap, rolü, kökeni; talepleri, teklifleri, kredileri,
  mesajları ve hesaba işaret eden her satır. Transaction, hesaba bağlı her
  yabancı anahtar sütununu (katalogdan okunur) ve taleplerin özetini önce ve
  sonra sayar; fark varsa geri alınır.
- **`ServiceRequest.customerEmail` dokunulmaz** — tarihsel snapshot.
- **Yeni bildirim gitmez:** dispatcher, gönderimden hemen önce audit satırının
  hesabına bakar; hesap serbest bırakılmışsa mail transport'a verilmez, satır
  `FAILED` + `RECIPIENT_RELEASED` olur. İlk gönderim, outbox teslimi ve admin
  yeniden gönderimi aynı kuraldan geçer. Adresi yeni alan hesaba (ör. süper
  yönetici) giden mailler etkilenmez. Geçmiş `NotificationLog` satırları
  değişmez.
- Hesap silinmez, birleştirilmez, SUPER_ADMIN yapılmaz.

Her komut `--apply` olmadan kuru çalışır (READ ONLY transaction). `--apply`
tek SERIALIZABLE transaction'dır; yazım, planın okuduğu durumu koşul olarak
tekrarlar ve tam bir satırı değiştirmelidir. Eşzamanlı bir değişiklik
(sahiplenme, ikinci çalıştırma) adımı geri alır; çıkış kodu 2 = red,
3 = serileştirme çakışması (kuru çalıştırmayı tekrarla).

## Ortak hazırlık

```bash
# Hedef ortamda, repo kökünde (deploy sonrası image). Komut kısaltması:
rce() {
  docker compose -f docker-compose.prod.yml run --rm --no-deps -T \
    -e TAKTIC_OPS_OUTPUT_DIR=/out -v "$HOME/Backups/taktic/ops:/out" \
    api node dist/scripts/release-customer-email.js "$@"
}
```

1. Yedek al: `scripts/ops/backup-db.sh --label pre-customer-email-release`.
2. Hesabın id'sini maskeli çıktıdan al: `sat inspect --to <adres>` (hedef
   hesap satırı).

## Adımlar

```bash
rce inspect --user-id <id> --email <adres>
rce release --user-id <id> --email <adres> --confirm-email <adres>            # kuru
rce release --user-id <id> --email <adres> --confirm-email <adres> --apply
```

`inspect` maskeli adresi, açık bağlantı ve oturum sayılarını, hesaba bağlı
satır sayılarını ve red nedenlerini gösterir; hiçbir şey yazmaz.

`--apply` sonrası manifest:
`$HOME/Backups/taktic/ops/release-customer-email-<zaman>-release.json`
(0600). İçeriği: hesap id'si, eski ve yeni adres, kapatılan bağlantı/oturum
sayıları, ilişki parmak izi. Parola, hash veya token içermez; tam eski adres
geri alma için gereklidir, bu yüzden dosya repoya girmez.

Sonra süper yönetici devrinin Yol B'si (`sat rename …`).

## Doğrulama

- `rce inspect --user-id <id> --email <adres>` → `the account does not hold
  --email` (adres artık hesapta değil).
- `sat inspect --to <adres>` → `path: B-rename`.
- `NotificationLog`'da hesabın yeni satırları varsa `RECIPIENT_RELEASED`.

## Geri alma

```bash
rce rollback --manifest /out/release-customer-email-<zaman>-release.json
rce rollback --manifest /out/release-customer-email-<zaman>-release.json --apply
```

Hesaba eski adresi geri verir. Reddedildiği durumlar: adres artık başka bir
hesapta (ör. rename uygulandı — önce `sat rollback` ile rename geri alınır),
hesap yer tutucu adreste değil, hesap bu arada parola veya kanıt kazanmış.
Kapatılan bağlantılar ve oturumlar geri gelmez; adres kanıtsız kalır.
