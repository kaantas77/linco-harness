# Linco Harness — faz 5 devir notu

Bu metin, 28 Ekim 2026'daki backend'in durumudur. Faz 1 çekirdeği duruyor: Pi Agent döngüsü, warm worker, SQLite, bellek, skill, araçlar ve otomasyon yeniden yazılmadı. Faz 2 ölçüm katmanını ekledi. Faz 3, yeni oturumlara Playwright tarayıcısı ve Jev karar döngüsünü ekledi. Faz 4, ebeveynin worker'ı bırakıp çocuk bitince aynı görevden devam etmesini ekledi. Faz 5, bu kuyruğun üstüne hedef planı ekledi. Faz 6, isteğin bağlamını kısalttı ve aynı görevleri açık/kapalı ölçtü. SQLite transkripti durur. Faz 7, aynı makinede iki Node sürecinin tek SQLite kuyruğunu kira ve çitle paylaşmasını ekledi. Faz 8, süresi dolmuş kirayı, görev yazılarını, HTTP kimliğini, SSRF kontrolünü ve kabuk izolasyonunu ekledi. Faz 9, `LINCO_COMPUTER=boat` iken her kullanıcıya bir Boat sanal bilgisayarı bağlar. Faz 10, bu bağı gerçek Boat hesabında DeepSeek Flash ile ölçtü. Faz 10.1, başarısız Chrome, masaüstü yazma ve görüntü okuma denemelerini aynı tavanlarla yeniden ölçtü. Faz 10.2, aynı makinede izole bir Chrome profili açtı ve üç görüntü yolunu ayrı ölçtü. Faz 10.3, Boat Chrome'unu CDP erişilebilirlik ağacı ve `b{backendNodeId}` referanslarıyla sürer. Eski snapshot reddedilir. Faz 10.4, `sandbox_direct_failed` kodunun kayıp dosyada dosya API'sinden geldiğini ayırdı ve yeni dosyalarda masaüstü kaydı 10/10 doğruladı. Ana agent modeli DeepSeek Flash olarak kaldı. Yerel modun araç listesi aynı kaldı. `buildStablePrompt` baytları, v1 araç sırası ve `task_wait` açıklama metni aynı kaldı. Eski oturumlar `plan_write` kontrol listesini tutar. `web_fetch` ve eski oturumların araç listesi duruyor.

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

HTTP sunucusu `src/server/http.ts`. Kimlik doğrulaması yok. CLI: `serve`, `task`, `bench`, `bench --live`, `bench --context`, `bench --durable`, `worker`. `serve` eskisi gibi kendi worker döngülerini de başlatır. `worker` HTTP açmaz; aynı veri dizinindeki kuyruğu tüketir. `LINCO_WORKERS=0` ile `serve` yalnız görev kabul eder. `bench` `reports/offline.json` ve `reports/offline.md` yazar. `bench --live` aynı senaryoları Linco ve yalın Pi üzerinde koşar, `reports/live.json` ve `reports/live.md` yazar. `bench --context` scripted bağlam raporunu her zaman yazar. `DEEPSEEK_API_KEY` varsa aynı altı görevi sıkıştırma açık ve kapalı, beş tekrar ve dengeli sırayla koşar ve `reports/context-live.json` yazar. Anahtar yoksa canlı rapor `liveExecuted: false` olur, senaryo çalışmaz ve çıkış kodu 0'dır. Canlı senaryo başarısızsa rapor yine yazılır ve çıkış kodu 1'dir.

Veri: `node:sqlite`, dosya `dataDir/linco.sqlite`. Node 22'de bu API hâlâ experimental uyarısı basar. Çalışıyor. Ayrı bir native sqlite paketi eklemedik.

## Test

`npm test`: 87 test geçer, `test/jev-live.test.ts`, `test/boat-live.test.ts`, `test/computer-use-live.test.ts`, `test/computer-use-v2-live.test.ts`, `test/release-candidate-live.test.ts` ve `test/pilot-readiness-live.test.ts` anahtarsız atlanır. Önceki 84 regresyon durur. `test/pilot-readiness.test.ts` kayıp dosyadaki 400 kodunu komut kanalından ayırır ve eski nano penceresini yeni dosya için seçmez. `test/boat.test.ts` sahte Boat API ile tek sanal makine, dosyanın durması, başka kullanıcı, host dizininin değişmemesi, masaüstü kilidi ve onayı kontrol eder. `test/security.test.ts` kimlik, SSRF, sandbox ve süresi dolmuş kirayı kontrol eder. `test/durable.test.ts` iki süreci, kira dolumunu, belirsiz yan etkiyi ve ebeveyn/çocuk kurtarmayı scripted modelle koşar. `test/goal-fix.test.ts` bağımlılık yeniden bağlamasını ve adıma ait araç kanıtını kontrol eder. `test/context.test.ts` araç çifti, gerekçe, kısa transkript ve kayıtta kalan metni kontrol eder. Faz 1'deki 15 test ve faz 2'deki 5 bench testi duruyor. `test/orchestrate.test.ts` park, örtüşme, başarısız çocuk, iptal ve süreç açılışında tek uyanışı kontrol eder. `test/resume.test.ts` hatalı devamın aynı transkriptten yeniden denendiğini, devam sırasında işaretin durduğunu ve SIGKILL sonrası kira dolmadan açık çocuğun toplanmadığını kontrol eder. `test/plan.test.ts` bağımlılık, paralel adım, eksik kanıt, yeniden plan ve iptal sonrası planın durmasını kontrol eder. Tarayıcı testleri politikayı, v1/v2/v3 araç sırasını, ref ile form doldurmayı, sekme yönetimini, profil kilidini, iptalde tarayıcının kapanmasını, anahtarsız `jev_run` reddini ve sahte Jev cevabıyla formun kaydını kontrol eder. `test/jev.test.ts` karar döngüsünü sahte TypeSafe cevabıyla kontrol eder. Canlı dosya `LINCO_JEV_LIVE=1` ister.

Kapsananlar: sabit prompt ve kelime belleği, sembolik link kaçışı, kabuk politikası, cron, cache oranı, dosya yazımı, onaylanmadan silmeme ve onaydan sonra silme, iki worker'ın komutları örtüştürmesi, cron'un çift basmaması, webhook, HTTP kullanıcı/bellek/mesaj, yerel sayfanın `web_fetch` ile okunması, üç çevrimdışı bench senaryosu.

`npm run build` geçti. `node dist/cli.js bench` üç senaryoyu da geçti: `write-note`, `code-list`, `delete-needs-approval`. CI dosyası `.github/workflows/ci.yml`. İçinde `npm ci`, `npx playwright install --with-deps chromium`, `npm test` ve `npm run build` var. Canlı API yoktur. Koşu `ubuntu-22.04` üzerindedir.

GitHub Actions hâlâ faturalama kilidi yüzünden runner açmıyor. Bu bir test hatası değil. Yerel 92 test geçti ve 7 canlı dosya atlandı. `tsc --noEmit` geçti. Canlı Jev testi varsayılan süitte yoktur. Canlı DeepSeek bağlam ölçümü `npm test` içinde yoktur. Canlı Boat ölçümü de yoktur; `BOAT_API_KEY` bu koşuda yoktu. `linco bench --context` anahtar görünce ayrıca koşar.

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

Yeni oturumun damgası `linco-toolset: v4-plan`dir. Bu metin v3'ü önek olarak tutar. v3, v2 metnini önek olarak tutar ve sona `browser_select`, `jev_run` ekler. v4 sona `goal_set`, `goal_status`, `goal_dispatch`, `goal_evidence`, `goal_replan` ekler. Eski v3 oturum bu beş aracı almaz. Yalnızca `linco-toolset: v2-browser` damgası olan eski oturum Jev araçlarını almaz. v1 oturum tarayıcı aracı almaz. `web_fetch` duruyor. Canlı token farkı ölçülmedi.

Kişi tarayıcının başına geçmez. Şifre, tek kullanımlık kod veya doğrulama ekranı `USER_TAKEOVER_REQUIRED` ile escalate olur. Native select, listelenen tek etkin etiketi DOM `change` olayıyla yazar. Headless seçicide ok tuşu yolu kullanılmaz. Aynı kontroller durur: tam bir etiket, `multiple` yok, en fazla 50 seçenek.

Profil `workspace/.linco/browser`. Aynı profil ikinci bir görevde açılmaz. Görev bitince veya iptal edilince bağlam kapanır ve kilit kalkar. Ekran görüntüsü çalışma alanına yazılır. Her tarayıcı çağrısı `traces` tablosunda `kind: browser` olur.

Yerel test, `http://127.0.0.1` üzerindeki bir formda ref ile e-postayı yazıp Save'e bastı. Sunucu `ada@example.com` değerini aldı. `/done` başlığı `Saved` oldu. Eski ref reddedildi. İkinci sekme açıldı. İkinci görev profili alamadı. Asılı navigasyon iptal edilince profil bir sonraki göreve açıldı. Harness koşusu scripted modelle bitti: durum `succeeded`, input 50, output 10, maliyet 0.00002 USD. Bu DeepSeek faturası değildir. Süre, Chromium'un açılışını içeren duvar saatidir. Canlı tarayıcı maliyeti yoktur.

Navigasyon `http` ve `https` ile sınırlı. Loopback serbest. Özel ağ, link-local ve metadata hostları reddedilir. Bu, `SECURITY.md` içindeki `web_fetch` SSRF maddesini kapatmaz. DNS yeniden bağlama ve üretim izolasyonu duruyor. Tarayıcı yerel geliştirme içindir.

## Çocuk görev

Durum makinesi: `queued → running → waiting_children → queued → running → succeeded`. Başarısız veya iptal edilen çocuk da ebeveyni uyandırır. Ebeveyn o hatayı rapor olarak görür ve sonsuza kadar beklemez. Çocuk `waiting_approval` ise terminal sayılmaz. Kimse onaylamazsa ebeveyn parkta kalır.

`task_wait` artık worker içinde uyumaz. Çocuk açıksa araç sonucu `LINCO_WAIT <görev>` olur, ebeveyn `waiting_children` yazılır ve `worker_id` boşalır. Model bu işareti görmez. Çocuk bitince `finishTask` ebeveyni uyandırır. Ebeveyn park satırına yazılmadan çocuk bittiyse, parkın hemen ardından aynı uyanış bir kez daha bakar. Uyanış tek koşullu `UPDATE`'tir: durum hâlâ `waiting_children` ve listedeki her çocuk terminal ise satır `queued` olur ve checkpoint `resumeChildren` taşır. İki çocuk aynı anda bitse de ikinci çağrı satırı değişmiş bulur.

Devam aynı görev ve aynı Pi transkriptidir. `agent.continue()` yeni kullanıcı mesajı eklemez. Eski araç çağrıları yeniden çalışmaz. Çocuk yeniden doğmaz. Park edilmiş sonuç, devam etmeden önce çocuk raporuna çevrilir: durum, kırpılmış sonuç, hata, süre, token ve maliyet. `waitForTask` ve `waitMs` ile bekleyen HTTP/CLI çağrısı, ebeveyn `waiting_children` iken beklemeye devam eder ve görev bitince sonucu verir. Onay bekleyen görev yine hemen döner. Kullanıcı o kararı verecektir.

İptal, ebeveyn `running` değilse onu `cancelled` yapar, sonra kuyruktaki ve çalışan çocukları iptal eder. Çalışan çocuğun kabuğu görev sinyalinden kesilir. Süreç yeniden açılınca `start()`, çocukları bitmiş `waiting_children` satırlarını bir kez uyandırır. `running` iken çöken satır, kira dolmadan toplanmaz. Kira dolunca güvenli iş kuyruğa döner. Belirsiz iş incelemeye alınır.

`resumeChildren` işareti, `agent.continue()` bitmeden silinmez. Model çağrısı hata verip görev yeniden kuyruğa girerse işaret durur. Sonraki deneme eski kullanıcı mesajını eklemez. Tamamlanmış araç çağrıları transkriptte kaldığı için yeniden yürütülmez. Çağrının kendisinin yazdığı asistan hata mesajı, devamı kilitlemesin diye transkriptin sonundan düşer. Bu, dosyaya yazılmış bir yan etkiyi geri almaz. Çağrı sırasında yeni bir araç çalıştıysa ve süreç orada öldüyse o yan etki ikinci denemede yeniden görülebilir. Bu exactly-once değildir.

SIGKILL sonrası çocuk, kira süresi dolana kadar `running` kalır. Ebeveyn bu arada `waiting_children` olarak bekler. Kira dolunca belirsiz çocuk `needs_inspection` olur ve ebeveyn uyanır. Güvenli çocuk yeniden kuyruğa girer. Düzgün `stop()` çalışan çocukları iptal eder. Bu exactly-once değildir.

Ölçüm `reports/orchestration.json` ve `reports/orchestration.md`. Mod `offline`. `performanceClaim` none. Beş senaryo da scripted modeldir. DeepSeek token'ı, cache'i ve maliyeti ölçülmedi. Hepsi sıfırdır. Paralel satır iki worker ve 350 ms uyku kullanır. İki çocuk örtüşür. Tek worker'da aynı uykular örtüşmez. Süreler duvar saatidir ve süreç ile SQLite payını içerir. Bu bir model sıralaması değildir. Başarısız çocuk ebeveyni uyandırır ve transkriptte her iki rapor da durur. İptal, ebeveyni ve çocukları `cancelled` yapar. Yeniden açılış, ebeveyni bir model çağrısıyla ve tek kullanıcı mesajıyla bitirir.

## Hedef planı

Basit görev plan açmadan biter. `plan_write` eski kontrol listesidir ve hedef kapısını çalıştırmaz. Karmaşık görev `goal_set` ile SQLite'a yazılır: hedef, adımlar, bağımlılıklar, beklenen çıktı, zorunlu kriter, durum, kanıt, yeniden plan notu ve bütçe. Bütün geçmiş her model çağrısına basılmaz. `goal_status` kısa özeti araç sonucu olarak verir. System prompt sabit kalır.

`goal_dispatch` bağımlılığı bitmiş adımları mevcut çocuk kuyruğuna bırakır. Bağımlılığı açık adım başlamaz. Bağımsız adımlar Faz 4 park ve uyanışıyla paralel gider. Çocuk, çocuk doğuramaz.

`goal_evidence` dosyayı, araç izini veya çocuk sonucunu kendisi okur. Modelin verdiği "oldu" değeri kabul edilmez. Dosya yoksa kriter `unverified` kalır. Yol çalışma alanının dışına çıkıyorsa `blocked` olur. Zorunlu kriterlerin hepsi `verified` olmadan adım `done` olmaz. Planın açık adımı varken ana görev `succeeded` yazılmaz.

Başarısız adım `goal_replan` ile `replaced` olur ve kayıtta kalır. Bitmiş adımlar değişmez. Yeni adımlar eklenir. Henüz başlamamış (`pending` veya `ready`, çocuğu yok) bir adım eski başarısız kimliği beklemez. Bağımlılığı yeni adımlara taşınır. Birden fazla yedek varsa hepsini bekler. Başlamış adımın bağımlılığı değişmez. Taşıma döngü kuracaksa plan reddedilir ve eski bağımlılık durur. Aynı hata ikinci kez planlanmaz. Bütçe varsayılan 2, tavan 3'tür. Bütçe bitince kalan adımlar `blocked` olur ve görev gerekçeyle durur.

`tool_ok` artık ebeveyndeki herhangi bir başarılı araç çağrısıyla kapanmaz. Çocuğu olan adım yalnızca o çocuğun izini kabul eder. Çocuğu olmayan adım, aynı araç adını isteyen tek açık adımsa ebeveyn izindeki `goalStepId` ile kapanır. İki adım aynı aracı istiyorsa iz etiketsiz kalır ve ikisi de `unverified` durur. Kapatan iz `evidenceTraceId` olarak kriterde saklanır.

Ölçüm `reports/planning.json` ve `reports/planning.md`. Mod `offline`. `performanceClaim` none. Aynı not yazma işi plan kapalıyken 2 tur, plan açıkken 4 tur sürdü. Scripted girdi 16'ya karşı 32, çıktı 4'e karşı 8. Bu DeepSeek faturası değildir. Kanıtsız "bitti" iddiası plan kapalıyken `succeeded`, plan açıkken `failed` oldu. Paralel iki adım 350 ms uyudu ve örtüştü. Bağımlı ikinci adım birincinin bitişinden önce başlamadı. Basit görev yine plansız kalır. Plan açmak bu ölçümde tur sayısını ikiye katladı.

## Bağlam

İstek ile kayıt ayrıdır. `transformContext` yalnızca modele giden mesajları değiştirir. `agent.state.messages` ve SQLite transkripti tam kalır. Büyük araç çıktısı istekte kısalsa da oturum kaydından yeniden okunabilir. Sıkıştırma, kaydı silmez.

Varsayılan karakter bütçesi 180000'dir. Bu sınırın altındaki görevde istek olduğu gibi gider. Model penceresinin yüzde 70'i daha gevşekse karakter bütçesi yine önce tetiklenir. `deepseek-flash` penceresi 1000000 token olduğu için bu fazda asıl kapı 180000 karakterdir. `LINCO_COMPACT=0` sıkıştırmayı kapatır. Eşik düşürülmedi.

Bütçe aşılınca ilk system mesajı aynı nesne olarak kalır. İlk kullanıcı talimatı durur. Sondaki mesajlar durur. Sonda bir araç sonucu varsa, ona ait `toolCall` da kalır. Ortadaki turlar tek `[linco-compaction]` işaretine iner. Tutulan asistan mesajının gerekçe bloğu yerinde kalır. Hâlâ bütçe aşıksa, son araç sonucu hariç eski büyük sonuçlar istek kopyasında kısaltılır. Asıl mesaj değişmez.

Kısa scripted görev sıkışmaz. Uzun scripted satır, ölçüm için 4000 karakterlik bütçe kullanır. Varsayılan 180000 durur. `reports/context.json` modu `offline`, `performanceClaim` none. Token tahmini karakter/4'tür. Bu dosyadaki sıfırlar DeepSeek faturası değildir.

Canlı karşılaştırma 25 Ekim 2026, `deepseek-flash`, beş tekrar, altı görev, açık ve kapalı. `reports/context-live.json` ve `reports/context-live.md`. `liveExecuted` true. `performanceClaim` none. Aynı model, aynı araç listesi, aynı prompt. Her koşu yeni oturumdur. İlk çağrı o oturum için soğuktur. Sağlayıcı, önceki koşunun aynı system prompt ve araç listesini yine de cache'leyebilir. `secondUserTurnCacheRead` ikinci kullanıcı turudur. `secondCallCacheRead` ikinci model çağrısıdır ve çoğu zaman ilk turun araç devamıdır. Tek tekrarlarda senaryo sırası ve önce giden kip yer değiştirir.

On iki hücrenin hepsi 5/5 başarılı oldu. Kayıp bağlam 0. Hatalı araç sonucu 0. Kısa görevler 180000 karakterin altında kaldı, sıkışmadı ve açık ile kapalı aynı işi yaptı. `file-op` medyan maliyeti her iki kipte de $0.00030 civarıdır. Bu medyan sıcak önektir. Örneklemin ilk hücresi, `file-op` açık, 256 cache token okudu ve $0.001469 tuttu.

Uzun transkriptte açık kip her tekrarda 379068 karakteri istekten çıkardı ve başarı 5/5 kaldı. Kayıt durdu. Kapalı kipin ilk tekrarı sıkışmamış metni gönderdi: 48723 cache'siz girdi, $0.015047, 2708 ms. Sonraki aynı metinler cache'e girdi ve medyan $0.000840'a indi. Açık kipin beş maliyeti $0.000329 ile $0.000756 arasındadır. Medyan, soğuk uzun gönderimin yerini tutmaz. Bu örneklem bir sıralama değildir.

## Kalıcı worker

İki süreç aynı `linco.sqlite` dosyasını bu makinede paylaşabilir. `claimTask` `BEGIN IMMEDIATE` içinde aday seçer ve `status = 'queued'` satırı bir kez `running` yapar. Aynı oturumda ikinci bir `running` görev alınmaz. Her sahiplenme `worker_id`, `fence`, `lease_until` ve `heartbeat_at` yazar. `fence` monoton artar. Canlı worker kirayı yeniler. Süreç ölürse kira dolunca satır taranır.

Tarama kör tekrar yapmaz. Araç izi yoksa ya da yalnız okuma izi varsa görev yeniden kuyruğa girer. `fs_write`, kabuk, `web_fetch`, tarayıcı, çocuk doğurma ve benzeri belirsiz iz varsa durum `needs_inspection` olur. Başlamış ama bitmemiş araç da incelemeye gider. Bu durum terminal sayılır, ebeveyn sonsuza kadar beklemez. Exactly-once yoktur. Yazılmış dosya geri alınmaz.

Eski worker'ın transkripti ve terminal yazımı `fence` ile `status = 'running'` şartına bağlıdır. Kira el değişince eski yazı sıfır satır değiştirir. `resumeChildren` işareti kira kurtarmasında silinmez. Tamamlanmış çocuk yeniden yaratılmaz. Güvenli çocuk yeniden kuyruğa girer, biter ve ebeveyn `agent.continue()` ile aynı transkriptten devam eder.

`linco serve` ve süreç içi worker döngüsü durur. Ayrı süreç `linco worker --data <dir>` ile açılır. Yeni kullanıcı mesajı yeni işletim sistemi süreci açmaz. Ağ dosya sistemiyle paylaşım yoktur. Redis veya Postgres yoktur. API varsayılan olarak token ister. `LINCO_AUTH=dev` yalnız loopback'te açıktır. `LINCO_ALLOW_LOOPBACK=1` yerel sayfa içindir. `LINCO_SANDBOX=off` kabuğu izolasyonsuz çalıştırır. `LINCO_COMPUTER=boat` ve `BOAT_API_KEY` her kullanıcıya bir uzak bilgisayar bağlar. Anahtar modele, cevaba ve loga yazılmaz.

Ölçüm `reports/durable.json` ve `reports/durable.md`. Mod `offline`. `performanceClaim` none. Scripted model. Doğrudan claim 164917 ns. Elli kira yenilemesinin ortalaması 15519 ns. Kuyruk beklemesi worker açılışı dahil: tek süreç 954 ms, iki süreç 660 ms. Güvenli çökme kurtarması 971 ms, belirsiz yazma incelemesi 874 ms, ebeveyn/çocuk kurtarması 886 ms. Çift yürütme 0. Kayıp transkript 0. Aynı oturumdaki ikinci görev birincinin bitmesini bekledi. Ebeveyn/çocuk kurtarma oranı 1. SQLite kilit sayacı bu koşuda 0. Bu sayılar bir sıralama değildir.

## Üretim engeli

`SECURITY.md` kalan kapıları ayırır. HTTP artık varsayılan olarak token ister. `LINCO_AUTH=dev` yalnız loopback'te eski açık kullanımı bırakır. `web_fetch` özel adresleri, metadata'yı ve yönlendirme sonrası hedefi reddeder. Kabuk ve `code_run`, macOS seatbelt veya Linux bubblewrap içinde çalışır. Araç yoksa komut reddedilir. `/Volumes`, `/mnt`, `/opt` ve `/Library` okuması kapalıdır. Aynı makinedeki iki süreç kirayı ve çiti kullanır. Süre dolmuş kira yeni yazı başlatamaz. `LINCO_COMPUTER=boat` iken dosya, kabuk ve masaüstü o kullanıcının sanal makinesindedir. Yerel mod durur. Bu, exactly-once değildir ve yazılmış dosyayı geri almaz. Ağ üzerinden paylaşılan bir SQLite dosyası desteklenmez. Darwin'de adres alanı için güvenilir bir `ulimit` yoktur. Webhook adresi hâlâ bir yetenek URL'sidir. Canlı Boat hesabı bu fazda koşulmadı.

## Bilinçli olarak yapılmayanlar

DeepSeek Harness, Hermes ve NeMo kaynak ağaçları bu depoya kopyalanmadı. Üçü de MIT. Kopyalamak yerine Pi döngüsünün üstüne Linco modülü yazıldı. Üçüncü parti notu `THIRD_PARTY_NOTICES.md` içinde.

Şunlar faz 1'de yok:

- Masaüstü kontrolü. Tarayıcı faz 3'te geldi. Ekran, fare ve Box üzerindeki sanal masa hâlâ yok. `ComputerProvider` arayüzü duruyor. Uygulama `LocalComputerProvider`.
- İşletim sistemi sandbox'ı. OpenShell yok. Seatbelt, bubblewrap, Landlock yok.
- Birden fazla makine. İki süreç aynı makinedeki tek SQLite dosyasını paylaşır. Ağ dosya sistemi yoktur.
- Vektör bellek, Hermes FTS, kullanıcıya gösterilen bellek arayüzü. API var, ekran yok.
- Hermes'teki tam cron ifadesi, kanal bildirimleri, gateway, ACP.
- DeepSeek'in PTC runtime'ı, plan inceleme akışı, LSP ve spill. Linco'nun kendi hedef tablosu Faz 5'te eklendi. Çocuk görev bir düzeydir. Çocuk, çocuk doğuramaz. Ayrı çalışma dizini yoktur.
- NeMo değerlendirme koşusu. Yalnızca dışa aktarılan iz var.
- DeepSeek Harness ile aynı senaryoların karşılaştırması. Bu faz yalın Pi ile Linco'yu ölçtü. Üçüncü ağaç koşulmadı.
- Mevcut ürünün Hermes yolu kapatılmadı. Bu depo onun yerine geçmeye hazır bir çekirdek. Taşıma ayrı iş.

## Sıradaki faz

Sırayı bozma. Pi çekirdeği duruyor. NeMo bu sırada yok; mevcut ölçüm yeterli. GitHub Actions, hesap kilidi kalkınca aynı workflow ile doğrulanır.

1. Canlı taban çizgisi bir kez alındı. Sayılar yukarıdaki ölçüm bölümünde. Bu tek koşu bir sıralama değildir. Toplam süreler birbirine yakındı. Linco'nun faturası bu koşuda daha yüksekti. Araç listesi ve prompt boyutu farklı olduğu için bu bir verimlilik kararı değildir. DeepSeek Harness aynı senaryolarla henüz koşulmadı.

2. Cache alanları ayrıldı. `secondCallCacheRead` ikinci model çağrısıdır. `secondUserTurnCacheRead` ikinci kullanıcı mesajının ilk çağrısıdır. Faz 2 kaydında ikinci kullanıcı turu 1920'dir. Faz 6 `session-continue` tekrar 0'da ikinci çağrı 4352, ikinci kullanıcı turu 4608'dir. İkisi aynı olay değildir.

3. Tarayıcı ve Jev kuruldu. Ayrıntı ve 2026-10-24 canlı Jev sayıları yukarıdaki bölümde. Canlı DeepSeek tarayıcı maliyeti yoktur. Bu fazda Jev'e dokunulmadı.

4. Kabuk izolasyonu kuruldu. macOS `sandbox-exec`, Linux'ta varsa `bwrap`. İkisi de yoksa komut reddedilir. `LINCO_SANDBOX=off` izolasyon değildir. OpenShell bu sırada yok. Darwin adres alanı sınırı iddia edilmez.

5. Çocuk görev kuruldu. Ebeveyn worker'ı bırakır, çocuk bitince aynı transkriptten devam eder. Hatalı devam eski kullanıcı mesajını yeniden göndermez. Ayrıntı yukarıdaki bölümde. Derin bir çocuk ağacı ve çocuk başına ayrı dizin yoktur. Kira dolunca güvenli görev yeniden kuyruğa girer. Belirsiz yan etki `needs_inspection` olur.

6. Hedef planı kuruldu. Ayrıntı yukarıdaki bölümde. Basit görev plansız kalır.

7. Bağlam kısaltması kuruldu. Ayrıntı yukarıdaki bölümde. Varsayılan eşik 180000 karakterde kaldı. Başarıyı düşüren daha sert bir kısaltma açılmadı. Canlı sayılar `reports/context-live.md` içindedir.

8. Aynı makinede iki süreç kuruldu. Ayrıntı yukarıdaki bölümde. Çok makineli kuyruk ve exactly-once yoktur.

9. Kimlik, SSRF ve kabuk izolasyonu kuruldu. Ayrıntı `SECURITY.md` ve `reports/security.md` içindedir. `LINCO_AUTH=dev` ve `LINCO_SANDBOX=off` üretim modu değildir.

10. Boat bilgisayarı kuruldu. `LINCO_COMPUTER=boat` her kullanıcıya bir sanal makine bağlar. Dosya, kabuk ve masaüstü o makinededir. Yerel mod eski testlerde durur. Sahte API kaydı `reports/boat.md` içindedir.

11. Canlı Boat koşusu `bx_k26y6st3` üzerinde yapıldı ve makine silindi. Tavanlar önceden small, 1500 saniye ömür, Boat $0.10 ve DeepSeek $0.75 idi. Senaryo satırlarının toplamı yaklaşık $0.0081 DeepSeek ve $0.0003 Boat'tur. Bu bir fatura dökümü değildir ve sıralama değildir. Dosya, terminal, durdur-devam, iki çocuk, tek makine, başka kullanıcı, host dosyası, zaman aşımı, iptal ve masaüstü kilidi model cümlesinden ayrı doğrulandı. Chrome başlığı ve klavyeyle yazılan dosya doğrulanamadı. Ekran görüntüsü modele gitti; modelin okuduğu dört karakter PNG'deki karakter değildi. Ayrıntı `reports/boat-live.md` içindedir.

Faz 10.1 aynı tavanlarla `bx_5zp78mwa` üzerinde bitti ve makine silindi. Süre 269902 ms. DeepSeek $0.013773. Boat $0.001020. Bu da fatura dökümü veya sıralama değildir. Masaüstünde yazma 5/5 oldu: her deneme `click` ve `type_text` çağırdı, kabuk `PHASE10-TYPE` yazmadı, bağımsız okuma bu metin artı sondaki boşluktu. Chrome 0/5 kaldı. Pencere `New Tab - Chromium` olarak durdu. `get_browser_state` `browser_route_unavailable` döndü; erişilebilirlik yolu güvenilir bir AT-SPI ağacı görmedi. Adres çubuğuna tıklama ve Ctrl+L başlığı değiştirmedi. Görüntü okuma bu makinede 0/5 oldu. PNG gerçek 945x920 pencere görüntüsüydü ve ağaç kodu içermiyordu. Modelin cevabı boyalı kod değildi; yanlış tahmin başarı sayılmadı. Silinmiş `bx_amtewwdh` makinesinde aynı boyuttaki kırpılmamış görüntüde Flash 5 denemenin 2'sinde kodu tutturdu, 3'ünde başka kod söyledi. Kırpılmış gönderim `bx_99g7yu93` üzerinde 0/5 oldu. Dosya, terminal, durdur-devam ve iki çocuk bu koşuda da durdu. Ayrıntı `reports/computer-use.md` içindedir.

Faz 10.2 aynı tavanlarla `bx_9tcbmyxj` üzerinde bitti ve makine silindi. Süre 74827 ms. DeepSeek $0.005214. Boat $0.000350. Bu bir fatura dökümü veya sıralama değildir. Daha önceki silinmiş `bx_ek9jw5yf` makinesinde tarayıcı başlamadı: servis komutunda `&;` vardı ve bash bunu reddetti. O koşuda doğrudan görüntü çağrıları boş içerik döndürdü; düşünme açıkken 64 token cevap bırakmadı. Yayımlanan koşu bu iki hatadan sonradır. `gdbus` erişilebilirlik yoluna ulaştı, komutun ortamında `DBUS_SESSION_BUS_ADDRESS` yoktu. Cua'nın klavye yolu bu makinede bir kez `Example Domain - Chromium` başlığını açtı. İzole profil ayrı bir Chrome penceresi açtı. `playwright-core` yüklenmediği için o pencereyi CDP sürdü; hostta tarayıcı açılmadı. İkinci okuma başlığı `Example Domain` idi. `https://httpbin.org/forms/post` alanına `PHASE102-FORM` yazıldı ve cevap gövdesi bu değeri içerdi; sayfa başlığı boştu. Masaüstü yazma `click` ve `type_text` ile yapıldı. Bağımsız okuma `PHASE102-TYPE` artı sondaki boşluktu. İkinci görev masaüstü kilidine takıldı, dosya aynı makinede durdu ve oluşturma sayısı 1 kaldı. Görüntü yolları ayrıdır. Orijinal PNG, ayrıntı kapalı 0/3 ve ayrıntı high 0/3. Masaüstü `scrot` görüntüsü 0/3. Cua'nın etiket penceresinden aldığı görüntünün Pi yolundan giden hali 1/3. Yanlış tahminler, `DTFW` için `OTFW` gibi, başarı sayılmadı. Ayrıntı high oranı yükseltmedi. Başka bir vision modeli çağrılmadı. Serbest görevler ayrıdır: example.com aracı ve ikinci başlık okuması tuttu, modelin yazma görevi `desktop_click` hatası verdi ve `desktop_type` çağrılmadı. Dosyada kalan eski metin başarı sayılmadı. Ayrıntı `reports/computer-use-v2.md` içindedir.

Faz 10.3 aynı tavanlarla `bx_3hbbmdmv` üzerinde bitti ve makine silindi. Süre 84443 ms. DeepSeek $0.001119. Boat $0.00041. Bu bir fatura dökümü veya sıralama değildir. Ondan önceki silinmiş `bx_mx9dpp9w` 6/6 sayfa açtı ve eski ref'i reddetti; bağlantı tıklaması example.com'da kaldı ve form cevabı jetonu içermedi. Yayımlanan koşu bu düzeltmeden sonradır. Kontrollü tarayıcı alt kümesi 14/14: altı sayfanın gerçek URL'si ve başlığı, dört `More information` tıklamasının `https://www.iana.org/help/example-domains` adresi, üç formun httpbin cevap gövdesindeki jetonu ve eski snapshot reddi. Masaüstü 2/5: ilk yazma `click` ve `type_text` sonrası `PHASE103-TYPE-1` olarak okundu. Sonraki üç dosya `boat api 400 sandbox_direct_failed` verdi ve kabukla da okunamadı; bu satırlar başarısızdır. Kilit ikinci görevi çevirdi ve oluşturma sayısı 1 kaldı. Serbest görevler ayrıdır: `browser_open_read` sonrası başlık `Example Domain`, dosya yazma `fs_write` sonrası `PHASE103-EDIT`. İstenen onar onar matris bütçe yüzünden bu alt kümeye indirildi. Web araması anahtarsız uydurma sonuç üretmez; bu koşuda Serper ve Tavily çağrılmadı. Görüntü okuma tekrarlanmadı. Chrome hata ayıklama portu `127.0.0.1:9333` ve izin verilen origin yalnız `http://127.0.0.1:9333`. Port sanal makinenin içindeki başka süreçlere açık olduğu için bu kontrollü bir pilottur. Ayrıntı `reports/release-candidate.md` içindedir.

Faz 10.4 aynı tavanlarla `bx_jhq9jey5` üzerinde bitti ve makine silindi. Süre 157768 ms. DeepSeek $0.009524. Boat $0.00076. Bu bir fatura dökümü veya sıralama değildir. Kök neden: Boat dosya API'si olmayan bir dosyada HTTP 400 ve `sandbox_direct_failed` döndürür. Aynı anda `execCommand` ile `cat` çalışır ve `No such file or directory` yazar. Sandbox durumu `ready` idi. Disk `%31` doluydu. Faz 10.3'teki üç başarısız okuma, komut kanalının kopması değildi; dosya yoktu ve doğrulama `cat` çıktısını gizleyip yalnız `readText` hatasını yazmıştı. Bu koşuda her deneme yeni bir dosya açtı, o dosyanın penceresine `click` ve `type_text` uyguladı. `cat` ve `readText` on dosyanın onunda da jetonu gördü. Eski dosya içeriği başarı sayılmadı. Serbest görevler ayrıdır: tarayıcı açma, form, kod ve iki çocuk görev kanıtla geçti. Bağlantı tıklamasında model `succeeded` dedi ve yalnız `browser_snapshot` çağırdı. Masaüstü yazmada model `succeeded` dedi ve yalnız `desktop_state` çağırdı. İkisi de başarısızdır. Metadata adresi Chrome açılmadan reddedildi. Metadata yönlendirmesi `Page.navigate` zaman aşımıyla bitti; ne doğrulanmış red ne de metadata URL'si görüldü. Kabuk kullanıcısı `1000 user` iken `http://127.0.0.1:9333/json/version` 200 döndü. Tarayıcı kullanıcısı kabuktan ayrı değil. VM son URL metnini kontrol eder; DNS'i yeniden çözmez ve alt kaynakları denetlemez. Bu üçü üretim engelidir. Ayrıntı `reports/pilot-readiness.md` içindedir.

Faz 10.5 `8683678` üstüne geldi. Yayımlanan matris `bx_thha4kef` üzerinde bitti ve makine silindi. Süre 355303 ms. DeepSeek $0.055906. Boat $0.00175. Bu bir fatura dökümü veya sıralama değildir. Görev sözleşmesi kullanıcı cümlesinden çıkar. Sohbet ve bilgi isteklerinde sözleşme yoktur. Model bu sözleşmeyi yazamaz. Eksik eylemde bir kez düzeltme istenir. Eylem yapılmış ve sonuç tutmuyorsa aynı eylem tekrarlanmaz. Sonuç okunamıyorsa durum `needs_inspection` olur. `bx_thha4kef` kanıtı: bağlantı tıklama 10/10, her satırda `browser_click` ve `https://www.iana.org/help/example-domains`. Form 5/5, `browser_fill` ve `browser_click`. İki çocuk görev 5/5, çocuklar `succeeded` ve dosyalar jetonu taşıyor. Masaüstü yazma 0/10 `failed`. Kod 0/5 `failed`. Bu satırlar `succeeded` değildir. Kontrollü sayfa açma `Example Domain` oldu. TCP `127.0.0.1:9333` kapalı; kabuk `000` ve `port 9333 closed` gördü. Chrome hata ayıklama borusu 3 ve 4 numaralı dosya tanımlayıcılarındadır ve boş karakterle ayrılır. Aynı kullanıcı `browser.sock` dosyasını açabilir. Metadata adresi Chrome açılmadan reddedildi. Yönlendirme sayfası `https://httpbin.org/redirect-to` adresinde kaldı. Metadata adresi görülmedi ve açık bir red dönmedi. Bu doğrulanmış bir blok değildir. Herkese açık kullanıma hazır değildir. Ayrıntı `reports/agent-reliability.md` ve `reports/security-gates.md` içindedir. Sıradaki büyük iş, gerçek kullanıcı yüküyle ölçek ve dayanıklılık ölçmektir.

12. Bellek. Kelime seçimi yetmezse kullanıcıya görünür düzenleme ekranı ve daha isabetli seçim ekle. Tüm belleği system prompt'a basma. O, cache'i ve faturayı bozar.

13. Otomasyon. UTC cron yetiyor. Saat dilimi ve gerçek bildirim (webhook çıkışı) ancak bir kullanıcı senaryosu varsa gelsin.

14. Yük. Aynı makinede gerçek kullanıcı sayısı, kuyruk beklemesi ve çökme sonrası toparlanma. Yeni agent özelliği eklemeden ölç.

15. Başka makine. Aynı SQLite dosyasını ağ üzerinden paylaşma. Kira, yazılmış dosyayı geri almaz.

16. NeMo ertelendi. `linco.observe.v1` izi duruyor. Harness'in içine NeMo runtime'ı bağlama. Mevcut bench, bu sıra için yeterli ölçüm.

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
DEEPSEEK_API_KEY=... node dist/cli.js bench --context --out reports --data .data-bench
node dist/cli.js bench --durable --out reports
node dist/cli.js worker --data .data --workers 1
DEEPSEEK_API_KEY=... TYPESAFE_API_KEY=... node dist/cli.js serve
```

Sunucu `127.0.0.1:8787`. Worker sayısı `LINCO_WORKERS`. Veri dizini `LINCO_DATA_DIR`.

## Dosya haritası

- `src/agent/runtime.ts` — kuyruk, worker, kira, Pi Agent, onay, çocuk parkı ve devam
- `src/agent/lease.ts` — güvenli araç ile belirsiz yan etki ayrımı
- `src/security/isolate.ts` — macOS seatbelt ve Linux bubblewrap. Ek mount ve `/opt` okuması kapalıdır
- `src/security/tokens.ts` — API token özeti
- `src/boat/manager.ts` — kullanıcı başına tek Boat sanal makinesi
- `src/boat/client.ts` — `@boatdev/sdk` uyarlaması
- `src/boat/mcp.ts` — sanal makinedeki hazır Cua Driver MCP çağrısı
- `test/security.test.ts` — kimlik, SSRF, sandbox ve süresi dolmuş kira
- `test/boat.test.ts` — sahte Boat API
- `reports/security.json`, `reports/security.md` — `performanceClaim: none`
- `reports/boat.json`, `reports/boat.md` — sahte API, `performanceClaim: none`
- `reports/boat-live.json`, `reports/boat-live.md` — gerçek Boat, `bx_k26y6st3`, `performanceClaim: none`
- `reports/computer-use.json`, `reports/computer-use.md` — Faz 10.1, `bx_5zp78mwa`, `performanceClaim: none`
- `reports/computer-use-v2.json`, `reports/computer-use-v2.md` — Faz 10.2, `bx_9tcbmyxj`, `performanceClaim: none`
- `reports/release-candidate.json`, `reports/release-candidate.md` — Faz 10.3, `bx_3hbbmdmv`, `performanceClaim: none`
- `reports/pilot-readiness.json`, `reports/pilot-readiness.md` — Faz 10.4, `bx_jhq9jey5`, `performanceClaim: none`
- `reports/agent-reliability.json`, `reports/agent-reliability.md` — Faz 10.5, `bx_thha4kef`, `performanceClaim: none`
- `reports/security-gates.md` — Faz 10.5, herkese açık kullanım NO-GO
- `src/boat/pilot-readiness.ts` — dosya kanalı, on masaüstü kaydı ve ayrı doğal dil satırları
- `src/boat/probe.ts` — `sandbox_direct_failed` sınıfı
- `src/boat/release-candidate.ts` — CDP ref alt kümesi. Anahtarsız canlı başarı yazmaz
- `src/boat/ax-snapshot.ts` — snapshot, eski ref ve yönlendirme kararı
- `src/agent/route.ts` — gönderim profili. İkinci gateway değildir
- `src/boat/live-check.ts` — tavanlı canlı senaryolar. `LINCO_BOAT_LIVE=1` olmadan süite girmez
- `src/boat/computer-use.ts` — Chrome, yazma ve görüntü denemeleri. Anahtarsız canlı başarı yazmaz
- `src/boat/computer-use-v2.ts` — izole Chrome, üç görüntü yolu ve ayrı doğal dil satırları
- `src/boat/vm-browser.mjs` — sanal makinenin içinde çalışan Chrome. Hostta başlamaz. Erişilebilirlik ağacı ve ref burada uygulanır
- `src/agent/children.ts` — park işareti, çocuk raporu, hatalı asistan mesajını düşürme
- `src/agent/goal.ts` — hedef, bağımlılık, kanıt ve yeniden plan
- `src/tools/goal-tools.ts` — v4 hedef araçları
- `src/llm/deepseek.ts` — Pi DeepSeek sağlayıcısı
- `src/llm/scripted.ts` — test ve çevrimdışı bench modeli
- `src/llm/usage.ts` — cache hit oranı
- `src/prompt/layout.ts` — sabit prompt ve değişken kuyruk
- `src/prompt/compact.ts` — istek bağlamı. Kayıt bundan etkilenmez
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
- `src/bench/planning.ts` — scripted hedef senaryoları ve plan açık/kapalı karşılaştırması
- `src/bench/context.ts` — scripted bağlam karşılaştırması
- `src/bench/context-live.ts` — canlı açık/kapalı bağlam karşılaştırması
- `test/goal-fix.test.ts` — yeniden bağlama ve adıma ait kanıt
- `test/context.test.ts` — sıkıştırma ve kayıt
- `reports/context.json`, `reports/context.md` — `performanceClaim: none`
- `reports/context-live.json`, `reports/context-live.md` — canlı örneklem, `performanceClaim: none`
- `src/bench/durable.ts` — tek süreç ve iki süreç ölçümü
- `test/worker-proc.ts` — scripted worker süreci
- `test/durable.test.ts` — kira, çit, çökme ve ebeveyn kurtarma
- `reports/durable.json`, `reports/durable.md` — `performanceClaim: none`
- `test/orchestrate.test.ts` — park, örtüşme, hata, iptal, tek uyanış
- `test/resume.test.ts` — devam işareti, veritabanını yeniden açma, süreç öldürme
- `test/plan.test.ts` — hedef planı
- `reports/orchestration.json`, `reports/orchestration.md` — `performanceClaim: none`
- `reports/planning.json`, `reports/planning.md` — `performanceClaim: none`
- `SECURITY.md` — üretime geçişi durduran dört madde
- `src/observe/nemo.ts`
- `skills/file-ops`, `skills/web-research`

`ARCHITECTURE.md` kısa tasarım notu. `README.md` çalıştırma. Bu dosya, sıradaki planın girdisi.
