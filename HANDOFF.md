# Linco Harness — faz 1 devir notu

Bu metin, 22 Ekim 2026'da kurulan backend'in durumudur. Sıradaki fazı planlarken buradaki çalışan parçaları yeniden yazma. Eksik diye işaretlenen yerleri büyüt.

Kod: `linco-harness/` (bu klasörün yanında Pi, DeepSeek Harness, Hermes ve NeMo duruyor; onlar referans. Yeni depo sadece `linco-harness`).

## Ne kuruldu

Pi Agent (`@earendil-works/pi-agent-core` 1.4.0 ve `@earendil-works/pi-ai` 1.4.0) model döngüsü olarak bağlı. Linco, Pi'nin `Agent` sınıfını her görevde oluşturur. `streamFn` testte sahte, canlıda `createModels().streamSimple`. Varsayılan model `deepseek-flash`. Katalogda `deepseek-v4-pro` da var. `createDeepSeek("deepseek-flash")` bu makinede modeli yükledi. Canlı API çağrısı bu oturumda yapılmadı. Anahtar yoktu.

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

HTTP sunucusu `src/server/http.ts`. CLI: `serve`, `task`, `bench`, `bench --live`.

Veri: `node:sqlite`, dosya `dataDir/linco.sqlite`. Node 22'de bu API hâlâ experimental uyarısı basar. Çalışıyor. Ayrı bir native sqlite paketi eklemedik.

## Test

`npm test`: 15 test geçti.

Kapsananlar: sabit prompt ve kelime belleği, sembolik link kaçışı, kabuk politikası, cron, cache oranı, dosya yazımı, onaylanmadan silmeme ve onaydan sonra silme, iki worker'ın komutları örtüştürmesi, cron'un çift basmaması, webhook, HTTP kullanıcı/bellek/mesaj, yerel sayfanın `web_fetch` ile okunması, üç çevrimdışı bench senaryosu.

`npm run build` geçti. `node dist/cli.js bench` üç senaryoyu da geçti: `write-note`, `code-list`, `delete-needs-approval`. `createDeepSeek("deepseek-flash")` modeli yükledi. `--live` çalıştırılmadı.

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
- Canlı token maliyeti karşılaştırması. Bench'in canlı hali tek senaryo: çalışma alanına tam olarak `hello` yazan `hello.txt`. Henüz koşulmadı.
- Mevcut ürünün Hermes yolu kapatılmadı. Bu depo onun yerine geçmeye hazır bir çekirdek. Taşıma ayrı iş.

## Sıradaki faz

Sırayı bozma. Önce ölç, sonra ekle. Bir mekanizma görev başarısını, süreyi veya token'ı iyileştirmiyorsa durmasın.

1. Canlı taban çizgisi. `DEEPSEEK_API_KEY` ile `node dist/cli.js bench --live` çalışsın. Sonra aynı dosya, araştırma ve çok adımlı senaryolar Pi tek başına, bu harness ve mümkünse DeepSeek Harness için aynı modelle koşulsun. Kaydet: başarı, süre, ilk yanıt, input, output, cache hit, maliyet, hata. Bu sayı olmadan yeni mekanizma ekleme.

2. Cache'i canlı cevapta doğrula. İkinci turda `cacheRead` artıyor mu bak. System prompt veya araç sırası ikinci turda değişiyorsa bunu bug say. `requiresReasoningContentOnAssistantMessages` deepseek-flash kataloğunda açık. Pi transkripti olduğu gibi saklıyor. Canlı turda reasoning alanının düşüp düşmediğini kontrol et. Düşüyorsa Pi'nin kaydettiği assistant mesajını eksiltme.

3. Tarayıcı. `BrowserProvider`'a profil dizini `workspace/.linco/browser` olan bir Playwright sağlayıcısı ekle. `web_fetch` kalsın. Yeni araçlar ayrı adlarla gelsin ki mevcut araç listesinin prefix'i, profilsiz kurulumda değişmesin. Araç listesi değişecekse bunu bir oturum sürümü olarak tut ve cache etkisini ölç.

4. Çocuk görev. `task_spawn` / `task_wait` ilk kesit. Eksik olan, ebeveynin worker'ı kilitlemeden çocuğun sonucunu alması ve birden fazla çocuğun planlanması. Bunu DeepSeek subagent paketini yapıştırarak değil, mevcut kuyruk üstüne kur.

5. Plan. `plan_write` duruyor. İkinci adım, bitiş kriteri olan bir plan ve plan dışına çıkınca durma. Yine ölç.

6. Bellek. Kelime seçimi yetmezse kullanıcıya görünür düzenleme ekranı ve daha isabetli seçim ekle. Tüm belleği system prompt'a basma. O, cache'i ve faturayı bozar.

7. Otomasyon. UTC cron yetiyor. Saat dilimi ve gerçek bildirim (webhook çıkışı) ancak bir kullanıcı senaryosu varsa gelsin.

8. İzolasyon. Kabuk hâlâ `sh -c`. Dosya aracı kilitli, kabuk değil. Bir sonraki güvenlik adımı komut filtresini sıkılaştırmak değil, süreç sandbox'ı. OpenShell'i ancak çok kullanıcılı makine paylaşımı gerekince değerlendir. O günden önce Seatbelt veya eşdeğeri bir `ComputerProvider` olabilir.

9. Süreç sınırı. Aynı SQLite kuyruğunu başka bir makinedeki worker'ın alması. API değişmeden. Önce tek makinede ikinci bir süreçle dene.

10. NeMo. `linco.observe.v1` izini NeMo eval'ine sok. Harness'in içine NeMo runtime'ı bağlama. Aynı görevi iki harness sürümünde karşılaştırmak için kullan.

## Doğrulama

```bash
cd linco-harness
npm test
npm run build
node dist/cli.js bench
```

Canlı:

```bash
DEEPSEEK_API_KEY=... node dist/cli.js bench --live
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
- `src/bench/runner.ts`
- `src/observe/nemo.ts`
- `skills/file-ops`, `skills/web-research`

`ARCHITECTURE.md` kısa tasarım notu. `README.md` çalıştırma. Bu dosya, sıradaki planın girdisi.
