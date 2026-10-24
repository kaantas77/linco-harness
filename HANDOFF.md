# Linco Harness — faz 4 devir notu

Bu metin, 24 Ekim 2026'daki backend'in durumudur. Faz 1 çekirdeği duruyor: Pi Agent döngüsü, warm worker, SQLite, bellek, skill, araçlar ve otomasyon yeniden yazılmadı. Faz 2 ölçüm katmanını ekledi. Faz 3, yeni oturumlara Playwright tarayıcısı ve Jev karar döngüsünü ekledi. Faz 4, ebeveynin worker'ı bırakıp çocuk bitince aynı görevden devam etmesini ekledi. `buildStablePrompt` baytları, araç sırası ve `task_wait` açıklama metni aynı kaldı. `web_fetch` ve eski oturumların araç listesi duruyor.

Kod: `linco-harness/` (bu klasörün yanında Pi, DeepSeek Harness, Hermes ve NeMo duruyor; onlar referans. Yeni depo sadece `linco-harness`).

## Ne kuruldu

Pi Agent (`@earendil-works/pi-agent-core` 1.4.0 ve `@earendil-works/pi-ai` 1.4.0) model döngüsü olarak bağlı. Linco, Pi'nin `Agent` sınıfını her görevde oluşturur. `streamFn` testte sahte, canlıda `createModels().streamSimple`. Varsayılan model `deepseek-flash`. Katalogda `deepseek-v4-pro` da var. `createDeepSeek("deepseek-flash")` bu makinede modeli yükledi. Canlı ölçüm aşağıda. Anahtar rapora, bu dosyaya ve git geçmişine yazılmadı.

Kullanıcı mesajı yeni process açmaz. `Harness.start()` iki worker'ı (varsayılan) süreç yaşadığı sürece açık tutar. Görev `tasks` tablosuna `queued` yazılır. Worker, aynı oturumda `running` iş yoksa görevi alır. Transkript SQLite'tadır. Worker bitince transkripti geri yazar. İptal, çalışan `Agent.abort()` çağrısına gider.

DeepSeek prefix cache'i için system prompt ve araç listesi oturum yaratılırken dondurulur. Bellek, saat ve çalışma alanı yolu system prompt'a girmez. Son kullanıcı mesajının sonundaki `<linco-context>` bloğundadır. Eşleşmeyen bellek bağlama alınmaz. Eşleşme kelime kesişimidir, embedding değildir. Her turun `input`, `output`, `cacheRead`, `cacheWrite` ve `cost.total` değeri `usage_events` tablosundadır. Oran: `cacheRead / (input + cacheRead + cacheWrite)`. Pi, DeepSeek `prompt_cache_hit_tokens` değerini `cacheRead` yapar. Bunu yeniden yazmadık.

Transkript 180.000 karakteri geçerse ortası tek bir kullanıcı özetine iner. İlk system mesajı bayt bayt kalır. Özetten sonrası cache kaçırır. Bu bilinçli.

## Araçlar

Sıra sabit. Değiştirirsen prefix değişir.

`fs_list`, `fs_read`, `fs_write`, `fs_edit`, `fs_delete`, `shell_exec`, `web_fetch`, `code_run`, `skill_list`, `skill_load`, `memory_search`, `memory_save`, `plan_write`, `task_spawn`, `task_wait`.

Dosya yolları `realpath` ile çalışma alanına kilitli. Sembolik link kaçışı reddedilir. Kabuk `cwd` ve `HOME` çalışma alanıdır. Ortamda `DEEPSEEK_API_KEY` yoktur. `..`, alan dışı mutlak yol, `sudo`, `mkfs`, `dd`, kapanma ve `curl|bash` reddedilir. `rm` ve `fs_delete` onay ister. Onay satırı yazılır, görev `waiting_approval` olur, model durur. `POST /v1/tasks/:id/approve` ile `approved` olursa aynı görev, yalnızca o argüman hash'i için devam eder. `denied` görevi başarısız bitirir.

`web_fetch` HTTP gövdesinin metnidir. Script çalıştırmaz. `169.254.169.254` engellidir. `code_run` Node `vm` içinde async JavaScript çalıştırır. `require` ve `process` yoktur. Araçlar `tools.fs_list({ path: "." })` biçiminde çağrılır. İç çağrılar aynı onay kapısından geçer. Bu, DeepSeek code mode'unun Linco aracı olarak ilk hali. PTC runtime kopyası değil. Güvenlik sınırı da değil. Sınır, araç politikası.

`task_spawn` çocuk görevi ayrı oturuma koyar, aynı çalışma alanını kullanır. Çocuk çocuk doğuramaz. Üst sınır 8. Çocuklar ayrı dizin almaz. İki çocuk aynı dosyaya yazarsa sonuç yarışır. `task_wait` çocuk bitmişse raporunu döner. `waitMs` tam 0 ise yalnızca duruma bakar ve ebeveyni park etmez. Değer verilmezse veya pozitifse ve çocuk hâlâ açıksa ebeveyn park eder. Ayrıntı aşağıdaki çocuk görev bölümündedir. Varsayılan worker sayısı 2'dir.

`plan_write` görev üzerinde bir kontrol listesi tutar. Ayrı bir plan modu yok.

Skill'ler `skills/<ad>/SKILL.md`. Katalog system prompt'ta ad ve tek satır açıklama olarak durur. Gövde `skill_load` ile gelir. Şu an `file-ops` ve `web-research`.

Bellek CRUD'su API'de. Kullanıcı görür, değiştirir, siler. Model `memory_save` ile kayıt ekleyebilir.

Otomasyon: cron (`0 8 * * *`, `*/15`, `@hourly`, `@daily`, `@weekly`), heartbeat (`everyMs`), webhook. Saatler UTC. Gün ve ay alanı yalnızca `*`. Kaçırılan tikler yığılmaz. Bir çalışma alanının önceki işi hâlâ kuyruktaysa o otomasyon 30 saniye sonraya ertelenir. Otomasyonun kendi oturumu vardır, böylece ertesi çalıştırma aynı transkriptin üstüne biner. Webhook gövdesi `{{payload}}` yerine ya da mesajın sonuna yazılır.

Bildirimler otomasyon bitişinde ve onay beklerken `notifications` tablosuna düşer. Dışarıya push yok.

İz: her araç çağrısı `traces` tablosunda. `GET /v1/tasks/:id/observe` şeması `linco.observe.v1`. NeMo paketi import edilmedi.

HTTP sunucusu `src/server/http.ts`. Kimlik doğrulaması yok. CLI: `serve`, `task`, `bench`, `bench --live`. `bench` `reports/offline.json` ve `reports/offline.md` yazar. `bench --live` aynı senaryoları Linco ve yalın Pi üzerinde koşar, `reports/live.json` ve `reports/live.md` yazar. Anahtar yoksa canlı rapor `liveExecuted: false` olur, senaryo çalışmaz ve çıkış kodu 0'dır. Canlı senaryo başarısızsa rapor yine yazılır ve çıkış kodu 1'dir.

Veri: `node:sqlite`, dosya `dataDir/linco.sqlite`. Node 22'de bu API hâlâ experimental uyarısı basar. Çalışıyor. Ayrı bir native sqlite paketi eklemedik.

## Test

`npm test`: 39 test geçer, `test/jev-live.test.ts` anahtarsız atlanır. Faz 1'deki 15 test ve faz 2'deki 5 bench testi duruyor. `test/orchestrate.test.ts` park, örtüşme, başarısız çocuk, iptal ve süreç açılışında tek uyanışı kontrol eder. Tarayıcı testleri politikayı, v1/v2/v3 araç sırasını, ref ile form doldurmayı, sekme yönetimini, profil kilidini, iptalde tarayıcının kapanmasını, anahtarsız `jev_run` reddini ve sahte Jev cevabıyla formun kaydını kontrol eder. `test/jev.test.ts` karar döngüsünü sahte TypeSafe cevabıyla kontrol eder. Canlı dosya `LINCO_JEV_LIVE=1` ister.

Kapsananlar: sabit prompt ve kelime belleği, sembolik link kaçışı, kabuk politikası, cron, cache oranı, dosya yazımı, onaylanmadan silmeme ve onaydan sonra silme, iki worker'ın komutları örtüştürmesi, cron'un çift basmaması, webhook, HTTP kullanıcı/bellek/mesaj, yerel sayfanın `web_fetch` ile okunması, üç çevrimdışı bench senaryosu.

`npm run build` geçti. `node dist/cli.js bench` üç senaryoyu da geçti: `write-note`, `code-list`, `delete-needs-approval`. CI dosyası `.github/workflows/ci.yml`. İçinde `npm ci`, `npx playwright install --with-deps chromium`, `npm test` ve `npm run build` var. Canlı API yoktur. Koşu `ubuntu-22.04` üzerindedir.

GitHub Actions hâlâ faturalama kilidi yüzünden runner açmıyor. Bu bir test hatası değil. Yerel 39 test ve build geçti. Canlı Jev testi varsayılan süitte yoktur.

## Canlı ölçüm

22 Ekim 2026, `deepseek-flash`, tek koşu. Rapor `reports/live.json` ve `reports/live.md`. `liveExecuted` true. `performanceClaim` none. Sekiz satırın sekizi de dosya notunu geçti. Bu tablo bir sıralama değildir. Yalın Pi'nin araçları `fs_list`, `fs_read`, `fs_write`, `fs_edit`, `code_run`. Linco tam listeyi, worker'ı ve oturum transkriptini kullanır. Süreler duvar saatidir ve araç yürütmesini içerir. İlk yanıt, ilk assistant `message_start` anıdır.

| Koşucu | Senaryo | Süre ms | İlk yanıt ms | Input | Output | Cache hit | Cache miss | USD |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| linco | session-continue | 4349 | 488 | 2417 | 178 | 5632 | 2417 | 0.000972 |
| pi | session-continue | 4176 | 307 | 1222 | 134 | 1792 | 1222 | 0.000538 |
| linco | file-write | 2013 | 327 | 2078 | 72 | 1664 | 2078 | 0.000720 |
| pi | file-write | 2106 | 378 | 824 | 62 | 512 | 824 | 0.000325 |
| linco | multi-step | 3907 | 311 | 901 | 272 | 7040 | 901 | 0.000639 |
| pi | multi-step | 4430 | 357 | 799 | 244 | 2304 | 799 | 0.000546 |
| linco | code-run | 2186 | 312 | 455 | 95 | 3328 | 455 | 0.000270 |
| pi | code-run | 1911 | 326 | 473 | 85 | 896 | 473 | 0.000249 |

`session-continue` önce koştu. İki koşucuda da ilk model çağrısının `cacheRead` değeri 0'dı. Rapordaki "ikinci çağrı" Linco'da 1792, yalın Pi'de 512'dir. Bu sayı ikinci kullanıcı mesajı değildir. Linco'nun o koşuya ait SQLite dosyasında ilk görev iki çağrı tutuyor: ilki 0, ikincisi 1792. 1792, ilk mesajın araç sonucundan sonraki model çağrısıdır. İkinci kullanıcı görevine ait ilk çağrı 1920'dir. Yalın Pi aynı raporda dört çağrı yazmış, görev sınırı yoktur; o 512'yi ikinci kullanıcı turu diye etiketlemiyoruz. Yeni raporda `secondUserTurnCacheRead` ikinci kullanıcı mesajının ilk model çağrısıdır. Tek mesajlı senaryoda bu alan `n/a` olur. Bu ayrım yeni bir API çağrısı değildir. Eski dosyanın yeniden okunmasıdır.

İki tarafta da system prompt ve araç sırası ikinci turda aynı kaldı. Linco bu senaryoda `thinkingLevel: low` ile bir reasoning bloğu üretti ve ikinci turda duruyordu. Yalın Pi thinking bloğu döndürmedi, bu yüzden onun reasoning satırı `n/a`. Ürünün varsayılan thinking seviyesi hâlâ kapalı. Yalnızca bu senaryo `low` ister.

Sonraki senaryoların ilk çağrılarında cache hit görünmesi, önceki senaryonun prefix'i ısıtmasından gelir. Dört senaryoda da ikinci model çağrısı hit bildirdi. Bu, ikinci kullanıcı turunun ölçümü değildir. `file-write` tek mesajdır ve ikinci çağrı araç dönüşüdür.

Cache miss, Pi'nin önbelleğe girmemiş input token'ıdır. `cacheRead` input'un içine dahil değildir. Daha yüksek hit, bu koşuda daha düşük fatura üretmedi.

Bu tablodaki notlar dosya içeriğine bakar. Araç çağrısını şart koşmaz. `inbox-pick` ve `edit-port` sonradan eklendi. Onlar, `fs_read` sırası ve `fs_edit` argümanı olmadan geçmez. Bu iki senaryo canlı koşulmadı. Anahtar bu turda kullanılmadı. Onlar için başarı, süre veya maliyet yoktur.

## Tarayıcı

Karar döngüsü OpenMaus'taki Jev'dir. `src/browser/jev-run.ts` TypeSafe `https://api.typesafe.ai/v1/systemone` adresine `model: "jev-latest"` ile gider. Sayfa, OpenMaus'un ayrıştırdığı satır formatındadır: `Semantic browser snapshot #N — Başlık: URL` ve `- [b12] button: Save`. Seçim listede yoksa, güven 0.65'in altındaysa veya seçilen olasılık 0.50'nin altındaysa durur. Şifre, captcha, ödeme ve silme etiketleri aday olmaz. Tıklama, doldurma ve native select ref artı `snapshotId` ister. Eski ref reddedilir. Doğrulama taze snapshot'tadır: url, title veya tek bir öğe. Bütçe varsayılan 4, tavan 8 eylemdir. Aynı görevde 6 koşu, 24 eylem veya 90 saniye dolunca escalate olur. Aynı sözleşme ve aynı sayfa ikinci kez escalate olursa gerekçe "unchanged failed delegation" olur.

Anahtar `TYPESAFE_API_KEY` ortam değişkenidir. Depoya yazılmaz. Prompt'a, trace kaydına ve araç sonucuna konmaz. Anahtar yoksa `jev_run` "Jev did not run" der ve başarı bildirmez. Sahte cevapla yapılan form testi de aynı sonucu verir: `fetchImpl` FILL sonra CLICK seçer, sunucu `ada@example.com` alır, `typesafeCalls` 2, `actions` 2 olur. Bu sahte koşu TypeSafe faturası değildir.

Canlı koşu 2026-10-24'te bir kez yapıldı. Anahtar yalnızca o sürecin ortamındaydı. Yerel formda gerçek `jev-latest` e-postayı yazıp Save'e bastı. Sunucu `ada@example.com` değerini aldı. Sonuç `done`. Gerekçe "destination verified by fresh browser snapshot". `actions` 2, `typesafeCalls` 2, `computerCalls` 5, girdi token 1111, çıktı token 96, döngü süresi 611 ms. Testin duvar saati Chromium açılışıyla birlikte 1629 ms idi. `test/jev-live.test.ts` ancak `LINCO_JEV_LIVE=1` ve anahtar varken çalışır. Varsayılan `npm test` bu çağrıyı yapmaz.

Yeni oturumun damgası `linco-toolset: v3-jev`dir. v3 prompt'u v2 metnini önek olarak tutar ve sona `browser_select`, `jev_run` ekler. Yalnızca `linco-toolset: v2-browser` damgası olan eski oturum bu iki aracı almaz. v1 oturum tarayıcı aracı almaz. `web_fetch` duruyor. v3 araç tanımları v2 prefix'ini yeniden kullanmaz. Canlı token farkı ölçülmedi.

Kişi tarayıcının başına geçmez. Şifre, tek kullanımlık kod veya doğrulama ekranı `USER_TAKEOVER_REQUIRED` ile escalate olur. Native select, listelenen tek etkin etiketi DOM `change` olayıyla yazar. Headless seçicide ok tuşu yolu kullanılmaz. Aynı kontroller durur: tam bir etiket, `multiple` yok, en fazla 50 seçenek.

Profil `workspace/.linco/browser`. Aynı profil ikinci bir görevde açılmaz. Görev bitince veya iptal edilince bağlam kapanır ve kilit kalkar. Ekran görüntüsü çalışma alanına yazılır. Her tarayıcı çağrısı `traces` tablosunda `kind: browser` olur.

Yerel test, `http://127.0.0.1` üzerindeki bir formda ref ile e-postayı yazıp Save'e bastı. Sunucu `ada@example.com` değerini aldı. `/done` başlığı `Saved` oldu. Eski ref reddedildi. İkinci sekme açıldı. İkinci görev profili alamadı. Asılı navigasyon iptal edilince profil bir sonraki göreve açıldı. Harness koşusu scripted modelle bitti: durum `succeeded`, input 50, output 10, maliyet 0.00002 USD. Bu DeepSeek faturası değildir. Süre, Chromium'un açılışını içeren duvar saatidir. Canlı tarayıcı maliyeti yoktur.

Navigasyon `http` ve `https` ile sınırlı. Loopback serbest. Özel ağ, link-local ve metadata hostları reddedilir. Bu, `SECURITY.md` içindeki `web_fetch` SSRF maddesini kapatmaz. DNS yeniden bağlama ve üretim izolasyonu duruyor. Tarayıcı yerel geliştirme içindir.

## Çocuk görev

Durum makinesi: `queued → running → waiting_children → queued → running → succeeded`. Başarısız veya iptal edilen çocuk da ebeveyni uyandırır. Ebeveyn o hatayı rapor olarak görür ve sonsuza kadar beklemez. Çocuk `waiting_approval` ise terminal sayılmaz. Kimse onaylamazsa ebeveyn parkta kalır.

`task_wait` artık worker içinde uyumaz. Çocuk açıksa araç sonucu `LINCO_WAIT <görev>` olur, ebeveyn `waiting_children` yazılır ve `worker_id` boşalır. Model bu işareti görmez. Çocuk bitince `finishTask` ebeveyni uyandırır. Ebeveyn park satırına yazılmadan çocuk bittiyse, parkın hemen ardından aynı uyanış bir kez daha bakar. Uyanış tek koşullu `UPDATE`'tir: durum hâlâ `waiting_children` ve listedeki her çocuk terminal ise satır `queued` olur ve checkpoint `resumeChildren` taşır. İki çocuk aynı anda bitse de ikinci çağrı satırı değişmiş bulur.

Devam aynı görev ve aynı Pi transkriptidir. `agent.continue()` yeni kullanıcı mesajı eklemez. Eski araç çağrıları yeniden çalışmaz. Çocuk yeniden doğmaz. Park edilmiş sonuç, devam etmeden önce çocuk raporuna çevrilir: durum, kırpılmış sonuç, hata, süre, token ve maliyet. `waitForTask` ve `waitMs` ile bekleyen HTTP/CLI çağrısı, ebeveyn `waiting_children` iken beklemeye devam eder ve görev bitince sonucu verir. Onay bekleyen görev yine hemen döner. Kullanıcı o kararı verecektir.

İptal, ebeveyn `running` değilse onu `cancelled` yapar, sonra kuyruktaki ve çalışan çocukları iptal eder. Çalışan çocuğun kabuğu görev sinyalinden kesilir. Süreç yeniden açılınca `start()`, çocukları bitmiş `waiting_children` satırlarını bir kez uyandırır. `running` iken çöken satır toplanmaz.

Ölçüm `reports/orchestration.json` ve `reports/orchestration.md`. Mod `offline`. `performanceClaim` none. Beş senaryo da scripted modeldir. DeepSeek token'ı, cache'i ve maliyeti ölçülmedi. Hepsi sıfırdır. Paralel satır iki worker ve 350 ms uyku kullanır. İki çocuk örtüşür. Tek worker'da aynı uykular örtüşmez. Süreler duvar saatidir ve süreç ile SQLite payını içerir. Bu bir model sıralaması değildir. Başarısız çocuk ebeveyni uyandırır ve transkriptte her iki rapor da durur. İptal, ebeveyni ve çocukları `cancelled` yapar. Yeniden açılış, ebeveyni bir model çağrısıyla ve tek kullanıcı mesajıyla bitirir.

## Üretim engeli

`SECURITY.md` dört maddeyi ayırır. Hepsi üretim kapısını kapatır: HTTP'de kimlik doğrulaması yok, `web_fetch` özel adreslere ve yönlendirme sonrası adrese açık, kabuk `sh -c` artı ifade filtresi, çoklu süreçte kira ve transkript çiti yok. Aynı satırın iki worker tarafından alınması, koşullu `UPDATE` ile engelli. Bu, çökünce `running` kalan işi geri almaz.

## Bilinçli olarak yapılmayanlar

DeepSeek Harness, Hermes ve NeMo kaynak ağaçları bu depoya kopyalanmadı. Üçü de MIT. Kopyalamak yerine Pi döngüsünün üstüne Linco modülü yazıldı. Üçüncü parti notu `THIRD_PARTY_NOTICES.md` içinde.

Şunlar faz 1'de yok:

- Masaüstü kontrolü. Tarayıcı faz 3'te geldi. Ekran, fare ve Box üzerindeki sanal masa hâlâ yok. `ComputerProvider` arayüzü duruyor. Uygulama `LocalComputerProvider`.
- İşletim sistemi sandbox'ı. OpenShell yok. Seatbelt, bubblewrap, Landlock yok.
- Birden fazla makine. Worker'lar aynı sürecin içinde.
- Vektör bellek, Hermes FTS, kullanıcıya gösterilen bellek arayüzü. API var, ekran yok.
- Hermes'teki tam cron ifadesi, kanal bildirimleri, gateway, ACP.
- DeepSeek'in PTC runtime'ı, goal/plan inceleme akışı, LSP, spill. Çocuk görev bir düzeydir. Çocuk, çocuk doğuramaz. Ayrı çalışma dizini yoktur.
- NeMo değerlendirme koşusu. Yalnızca dışa aktarılan iz var.
- DeepSeek Harness ile aynı senaryoların karşılaştırması. Bu faz yalın Pi ile Linco'yu ölçtü. Üçüncü ağaç koşulmadı.
- Mevcut ürünün Hermes yolu kapatılmadı. Bu depo onun yerine geçmeye hazır bir çekirdek. Taşıma ayrı iş.

## Sıradaki faz

Sırayı bozma. Pi çekirdeği duruyor. NeMo bu sırada yok; mevcut ölçüm yeterli. GitHub Actions, hesap kilidi kalkınca aynı workflow ile doğrulanır.

1. Canlı taban çizgisi bir kez alındı. Sayılar yukarıdaki ölçüm bölümünde. Bu tek koşu bir sıralama değildir. Toplam süreler birbirine yakındı. Linco'nun faturası bu koşuda daha yüksekti. Araç listesi ve prompt boyutu farklı olduğu için bu bir verimlilik kararı değildir. DeepSeek Harness aynı senaryolarla henüz koşulmadı.

2. Cache alanları ayrıldı. `secondCallCacheRead` ikinci model çağrısıdır. `secondUserTurnCacheRead` ikinci kullanıcı mesajının ilk çağrısıdır. İkincisi bu eski raporda etiketli değildir. Linco'nun kayıtlı veritabanında o değer 1920'dir. Yeni senaryoların canlı koşusu anahtar olmadan yapılmadı.

3. Tarayıcı ve Jev kuruldu. Ayrıntı ve 2026-10-24 canlı Jev sayıları yukarıdaki bölümde. Canlı DeepSeek tarayıcı maliyeti yoktur. Bu fazda Jev'e dokunulmadı.

4. Kabuk izolasyonu. `SECURITY.md` içindeki üretim engeli. İfade filtresini sıkılaştırmak yetmez. Süreç sandbox'ı gerekir. OpenShell bu sırada yok.

5. Çocuk görev kuruldu. Ebeveyn worker'ı bırakır, çocuk bitince aynı transkriptten devam eder. Ayrıntı yukarıdaki bölümde. Sıradaki ürün işi plandır. Derin bir çocuk ağacı ve çocuk başına ayrı dizin bu fazda yoktur.

6. Plan. `plan_write` duruyor. Sıradaki adım, bitiş kriteri olan bir plan ve plan dışına çıkınca durma. Yine ölç.

7. Bellek. Kelime seçimi yetmezse kullanıcıya görünür düzenleme ekranı ve daha isabetli seçim ekle. Tüm belleği system prompt'a basma. O, cache'i ve faturayı bozar.

8. Otomasyon. UTC cron yetiyor. Saat dilimi ve gerçek bildirim (webhook çıkışı) ancak bir kullanıcı senaryosu varsa gelsin.

9. Süreç sınırı. Aynı SQLite kuyruğunu başka bir makinedeki worker'ın alması. API değişmeden. Önce tek makinede ikinci bir süreçle dene. Kira ve transkript çiti `SECURITY.md` içinde üretim engelidir.

10. NeMo ertelendi. `linco.observe.v1` izi duruyor. Harness'in içine NeMo runtime'ı bağlama. Mevcut bench, bu sıra için yeterli ölçüm.

## Doğrulama

```bash
cd linco-harness
npm test
npm run build
node dist/cli.js bench
```

Canlı:

```bash
DEEPSEEK_API_KEY=... node dist/cli.js bench --live --out reports --data .data-bench
DEEPSEEK_API_KEY=... TYPESAFE_API_KEY=... node dist/cli.js serve
```

Sunucu `127.0.0.1:8787`. Worker sayısı `LINCO_WORKERS`. Veri dizini `LINCO_DATA_DIR`.

## Dosya haritası

- `src/agent/runtime.ts` — kuyruk, worker, Pi Agent, onay, çocuk parkı ve devam
- `src/agent/children.ts` — park işareti, çocuk raporu, devam etmeden önce sonuçların değişimi
- `src/llm/deepseek.ts` — Pi DeepSeek sağlayıcısı
- `src/llm/scripted.ts` — test ve çevrimdışı bench modeli
- `src/llm/usage.ts` — cache hit oranı
- `src/prompt/layout.ts` — sabit prompt ve değişken kuyruk
- `src/prompt/compact.ts` — system mesajını bozmayan sıkıştırma
- `src/tools/create-tools.ts` — v1 araç sırası
- `src/tools/toolset.ts` — v2 tarayıcı damgası ve v3 Jev damgası
- `src/tools/browser-tools.ts` — snapshot, ref, sekme, doğrulama, `jev_run`
- `src/browser/session.ts` — kalıcı Playwright profili
- `src/browser/semantic.ts` — accessibility ağacı ve ref ile tıklama, doldurma, select
- `src/browser/jev-run.ts` — TypeSafe `jev-latest` karar döngüsü
- `src/browser/jev-delegation.ts` — sınırlı hedef, bütçe ve taze doğrulama
- `test/jev-live.test.ts` — `LINCO_JEV_LIVE=1` olmadan atlanan tek canlı TypeSafe formu
- `src/browser/navigation-policy.ts` — özel ağ reddi
- `src/tools/files.ts`, `local-computer.ts`, `http-browser.ts`, `code-mode.ts`, `agent-tools.ts`
- `src/security/policy.ts`, `workspace.ts`
- `src/db/database.ts` — şema ve sorgular
- `src/automation/cron.ts`
- `src/server/http.ts`
- `src/bench/runner.ts` — çevrimdışı senaryolar
- `src/bench/compare.ts` — canlı Linco ve yalın Pi koşusu
- `src/bench/scenarios.ts` — dosya, çok adım, kod ve aynı oturum senaryoları
- `src/bench/report.ts` — JSON ve Markdown
- `src/bench/orchestration.ts` — scripted çocuk senaryoları
- `test/orchestrate.test.ts` — park, örtüşme, hata, iptal, tek uyanış
- `reports/orchestration.json`, `reports/orchestration.md` — `performanceClaim: none`
- `SECURITY.md` — üretime geçişi durduran dört madde
- `src/observe/nemo.ts`
- `skills/file-ops`, `skills/web-research`

`ARCHITECTURE.md` kısa tasarım notu. `README.md` çalıştırma. Bu dosya, sıradaki planın girdisi.
