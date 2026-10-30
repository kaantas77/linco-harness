# Linco Commerce — satış öncesi kurulum

**Durum: PRELAUNCH.** Bu dal bir Shopify mağazasına bağlanmadı ve hiçbir gerçek kampanya/ödeme/sipariş başlatmadı.

## Bağlanacak servisler (zorunlu değil, minimumdan başla)
| İş | İlk tercihler | Şimdi yapılabilecek |
|---|---|---|
| Mağaza | Shopify | Tema, menü, ürünleri draft olarak hazırlama |
| Tedarik/sipariş | AutoDS veya CJ + gerçek tedarikçi doğrulaması | Teslimat ve iade araştırması, en fazla sandbox |
| İç otomasyon | Shopify Flow (Basic planında HTTP Request action yok) | Sipariş/risk/etiket akışlarını tasarlama |
| Reklam | Meta Business + Ads Manager | Meta hesabını ve taslak kreatifleri hazırla. Shopify-Meta satış kanalı mağazanın açık olmasını gerektirebilir; bağlamayı lansmana bırak |
| Destek | Chatwoot + resmî WhatsApp Business Platform | Onaylı ürün-politika SSS taslakları |
| Yönetim | Linco Harness | Ajan skill ve `src/commerce/prelaunch.ts` emniyet kapısı |

## Sıra
1. Mağazanın bağlı olduğundan emin ol; Shopify OAuth erişimini uygulama içinden ver. **Token/şifreleri sohbete ya da GitHub'a yazma.**
2. Mağazayı parola korumalı tut. Henüz gerçek ödeme yöntemi etkinleştirme, kamuya reklam verme veya sipariş alma.
3. Ürün araştırma: kaynaklı 10 aday → teslimat ve marj doğrulaması → 1 test ürün; trend/rekabet verisini tahmin olarak işaretle.
4. Ürün sayfası, SSS, teslimat/iade taslakları, üç reklam açısı ve 5 kreatif taslağı hazırla. Yanıltıcı/kanıtsız sertifika, sağlık etkisi ve sahte yorum üretme.
5. Shopify Flow'da taslak iş akışları ve tetikleyiciler: stok azalması, sipariş riski, kargo gecikmesi, müşteri destek yönlendirmesi. Dış API çağrısını Shopify planına göre ayrı servisle gerçekleştir.
6. Ölçüm planı: UTM, Meta Pixel/CAPI (test event), dönüşüm olaylarında çift sayımı önleme, gerçek ürün maliyeti ve masraflarla katkı marjı.
7. Devreye alma kapısı: yasal işletme, uygun ödeme kuruluşu ve banka hesabı, tedarik ve iade testleri, tüketici politikaları, test checkout, reklam harcama limiti, yazılı kullanıcı onayı.

## Güvenlik / veri
- PRELAUNCH yetkili: araştırma, analiz, içerik taslağı ve gerçek ödeme işlemeyen test simülasyonu.
- PRELAUNCH yasak: canlı ürün yayınlama, reklam harcaması, müşteri mesajı, ödeme, sipariş yönlendirme, iade, ücretli entegrasyon satın alma.
- Şifre/erişim anahtarı dosyaya veya GitHub'a kaydedilmez. API token kullanımı sunucu ortam değişkeni/gizli yönetimi ile yapılır.
- Yayın/ads/para işlemleri sadece sağlayıcı izni, denetlenebilir log, onay ve anlık yetki denetiminden sonra.
- `authorizeCommerceAction` kodu bir ilk güvenlik kapısıdır; henüz herhangi bir canlı Shopify/Meta/WhatsApp bağlantısına takılı değildir. Bağlandığında her mutasyonun önüne koy.

## Bir sonraki teknik görev
- Shopify OAuth ve erişim kapsamlarını doğrula.
- Read-only shop/products adapter ve `draft` ürün oluşturma adapter'ını yalnızca PRELAUNCH kurallarıyla, mock testlerle tamamla.
- Meta / AutoDS / Chatwoot bağlantılarını ayrı izinlerle ekle; önce test ortamında uçtan uca doğrula.
