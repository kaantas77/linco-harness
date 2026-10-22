# Linco Harness — faz 2 devir notu

Bu metin, 22 Ekim 2026'daki backend'in durumudur. Faz 1 çekirdeği duruyor: Pi Agent döngüsü, warm worker, SQLite, bellek, skill, araçlar ve otomasyon yeniden yazılmadı. Faz 2 bu çekirdeğin üstüne ölçüm katmanı ekledi. Sıradaki işi planlarken çalışan parçaları yeniden yazma.

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

`task_spawn` çocuk görevi ayrı oturuma koyar, aynı çalışma alanını kullanır. Çocuk çocuk doğuramaz. Üst sınır 8. `task_wait` en fazla 20 saniye bakar. Tek worker ile çocuk, ebeveyn bitmeden ilerlemez. Varsayılan worker sayısı 2'dir. Test, iki kabuk komutunun aynı anda örtüştüğünü gördü.

`plan_write` görev üzerinde bir kontrol listesi tutar. Ayrı bir plan modu yok.

Skill'ler `skills/<ad>/SKILL.md`. Katalog system prompt'ta ad ve tek satır açıklama olarak durur. Gövde `skill_load` ile gelir. Şu an `file-ops` ve `web-research`.

Bellek CRUD'su API'de. Kullanıcı görür, değiştirir, siler. Model `memory_save` ile kayıt ekleyebilir.

Otomasyon: cron (`0 8 * * *`, `*/15`, `@hourly`, `@daily`, `@weekly`), heartbeat (`everyMs`), webhook. Saatler UTC. Gün ve ay alanı yalnızca `*`. Kaçırılan tikler yığılmaz. Bir çalışma alanının önceki işi hâlâ kuyruktaysa o otomasyon 30 saniye sonraya ertelenir. Otomasyonun kendi oturumu vardır, böylece ertesi çalıştırma aynı transkriptin üstüne biner. Webhook gövdesi `{{payload}}` yerine ya da mesajın sonuna yazılır.

Bildirimler otomasyon bitişinde ve onay beklerken `notifications` tablosuna düşer. Dışarıya push yok.

İz: her araç çağrısı `traces` tablosunda. `GET /v1/tasks/:id/observe` şeması `linco.observe.v1`. NeMo paketi import edilmedi.

HTTP sunucusu `src/server/http.ts`. Kimlik doğrulaması yok. CLI: `serve`, `task`, `bench`, `bench --live`. `bench` `reports/offline.json` ve `reports/offline.md` yazar. `bench --live` aynı senaryoları Linco ve yalın Pi üzerinde koşar, `reports/live.json` ve `reports/live.md` yazar. Anahtar yoksa canlı rapor `liveExecuted: false` olur, senaryo çalışmaz ve çıkış kodu 0'dır. Canlı senaryo başarısızsa rapor yine yazılır ve çıkış kodu 1'dir.

Veri: `node:sqlite`, dosya `dataDir/linco.sqlite`. Node 22'de bu API hâlâ experimental uyarısı basar. Çalışıyor. Ayrı bir native sqlite paketi eklemedik.

## Test

`npm test`: 20 test geçti. Faz 1'deki 15 test duruyor. Bench testleri ikinci model çağrısını ikinci kullanıcı turundan ayırır. Dosya doğru olsa bile beklenen araç çağrısı yoksa not başarısız olur.

Kapsananlar: sabit prompt ve kelime belleği, sembolik link kaçışı, kabuk politikası, cron, cache oranı, dosya yazımı, onaylanmadan silmeme ve onaydan sonra silme, iki worker'ın komutları örtüştürmesi, cron'un çift basmaması, webhook, HTTP kullanıcı/bellek/mesaj, yerel sayfanın `web_fetch` ile okunması, üç çevrimdışı bench senaryosu.

`npm run build` geçti. `node dist/cli.js bench` üç senaryoyu da geçti: `write-note`, `code-list`, `delete-needs-approval`. CI dosyası `.github/workflows/ci.yml`. İçinde `npm ci`, `npm test` ve `npm run build` var. Canlı API yoktur. Koşu `ubuntu-22.04` üzerindedir.

GitHub'daki ilk Actions koşusu, [run 39792248273](https://github.com/kaantas77/linco-harness/actions/runs/39792248273), adım başlatmadan `failure` oldu. Adım listesi boş, runner id 0. Check annotation şöyle: "The job was not started because your account is locked due to a billing issue." Bu bir test hatası değil. Hesap kilidi kalkmadan aynı workflow yeniden kırmızı kalır. Yerel 20 test ve build bu yüzden duruyor.

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

## Üretim engeli

`SECURITY.md` dört maddeyi ayırır. Hepsi üretim kapısını kapatır: HTTP'de kimlik doğrulaması yok, `web_fetch` özel adreslere ve yönlendirme sonrası adrese açık, kabuk `sh -c` artı ifade filtresi, çoklu süreçte kira ve transkript çiti yok. Aynı satırın iki worker tarafından alınması, koşullu `UPDATE` ile engelli. Bu, çökünce `running` kalan işi geri almaz.

## Bilinçli olarak yapılmayanlar

DeepSeek Harness, Hermes ve NeMo kaynak ağaçları bu depoya kopyalanmadı. Üçü de MIT. Kopyalamak yerine Pi döngüsünün üstüne Linco modülü yazıldı. Üçüncü parti notu `THIRD_PARTY_NOTICES.md` içinde.

Şunlar faz 1'de yok:

- Playwright veya gerçek tarayıcı profili. `BrowserProvider` arayüzü var. Uygulama `HttpBrowserProvider`.
- Masaüstü kontrolü, ekran, fare. Bilgisayar erişimi dosya ve kabuk. `ComputerProvider` arayüzü var. Uygulama `LocalComputerProvider`.
- İşletim sistemi sandbox'ı. OpenShell yok. Seatbelt, bubblewrap, Landlock yok.
- Birden fazla makine. Worker'lar aynı sürecin içinde.
- Vektör bellek, Hermes FTS, kullanıcıya gösterilen bellek arayüzü. API var, ekran yok.
- Hermes'teki tam cron ifadesi, kanal bildirimleri, gateway, ACP.
- DeepSeek'in PTC runtime'ı, goal/plan inceleme akışı, LSP, spill, subagent ağacı.
- NeMo değerlendirme koşusu. Yalnızca dışa aktarılan iz var.
- DeepSeek Harness ile aynı senaryoların karşılaştırması. Bu faz yalın Pi ile Linco'yu ölçtü. Üçüncü ağaç koşulmadı.
- Mevcut ürünün Hermes yolu kapatılmadı. Bu depo onun yerine geçmeye hazır bir çekirdek. Taşıma ayrı iş.

## Sıradaki faz

Sırayı bozma. Pi çekirdeği duruyor. NeMo bu sırada yok; mevcut ölçüm yeterli. GitHub Actions, hesap kilidi kalkınca aynı workflow ile doğrulanır.

1. Canlı taban çizgisi bir kez alındı. Sayılar yukarıdaki ölçüm bölümünde. Bu tek koşu bir sıralama değildir. Toplam süreler birbirine yakındı. Linco'nun faturası bu koşuda daha yüksekti. Araç listesi ve prompt boyutu farklı olduğu için bu bir verimlilik kararı değildir. DeepSeek Harness aynı senaryolarla henüz koşulmadı.

2. Cache alanları ayrıldı. `secondCallCacheRead` ikinci model çağrısıdır. `secondUserTurnCacheRead` ikinci kullanıcı mesajının ilk çağrısıdır. İkincisi bu eski raporda etiketli değildir. Linco'nun kayıtlı veritabanında o değer 1920'dir. Yeni senaryoların canlı koşusu anahtar olmadan yapılmadı.

3. Tarayıcı. `BrowserProvider`'a profil dizini `workspace/.linco/browser` olan bir Playwright sağlayıcısı ekle. `web_fetch` kalsın. Yeni araçlar ayrı adlarla gelsin ki mevcut araç listesinin prefix'i, profilsiz kurulumda değişmesin. Araç listesi değişecekse bunu bir oturum sürümü olarak tut ve cache etkisini ölç.

4. Kabuk izolasyonu. `SECURITY.md` içindeki üretim engeli. İfade filtresini sıkılaştırmak yetmez. Süreç sandbox'ı gerekir. OpenShell, paylaşılan makine ihtiyacı doğunca.

5. Çocuk görev. `task_spawn` / `task_wait` ilk kesit. Eksik olan, ebeveynin worker'ı kilitlemeden çocuğun sonucunu alması ve birden fazla çocuğun planlanması. Bunu DeepSeek subagent paketini yapıştırarak değil, mevcut kuyruk üstüne kur.

6. Plan. `plan_write` duruyor. İkinci adım, bitiş kriteri olan bir plan ve plan dışına çıkınca durma. Yine ölç.

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
DEEPSEEK_API_KEY=... node dist/cli.js serve
```

Sunucu `127.0.0.1:8787`. Worker sayısı `LINCO_WORKERS`. Veri dizini `LINCO_DATA_DIR`.

## Dosya haritası

- `src/agent/runtime.ts` — kuyruk, worker, Pi Agent, onay, devam
- `src/llm/deepseek.ts` — Pi DeepSeek sağlayıcısı
- `src/llm/scripted.ts` — test ve çevrimdışı bench modeli
- `src/llm/usage.ts` — cache hit oranı
- `src/prompt/layout.ts` — sabit prompt ve değişken kuyruk
- `src/prompt/compact.ts` — system mesajını bozmayan sıkıştırma
- `src/tools/create-tools.ts` — sabit araç sırası
- `src/tools/files.ts`, `local-computer.ts`, `http-browser.ts`, `code-mode.ts`, `agent-tools.ts`
- `src/security/policy.ts`, `workspace.ts`
- `src/db/database.ts` — şema ve sorgular
- `src/automation/cron.ts`
- `src/server/http.ts`
- `src/bench/runner.ts` — çevrimdışı senaryolar
- `src/bench/compare.ts` — canlı Linco ve yalın Pi koşusu
- `src/bench/scenarios.ts` — dosya, çok adım, kod ve aynı oturum senaryoları
- `src/bench/report.ts` — JSON ve Markdown
- `SECURITY.md` — üretime geçişi durduran dört madde
- `src/observe/nemo.ts`
- `skills/file-ops`, `skills/web-research`

`ARCHITECTURE.md` kısa tasarım notu. `README.md` çalıştırma. Bu dosya, sıradaki planın girdisi.
