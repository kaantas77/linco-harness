# Mimari

Linco Harness tek Node sürecidir. İçinde sürekli yaşayan worker'lar vardır. Kullanıcı mesajı bir Hermes süreci veya yeni bir ACP oturumu açmaz. Görev SQLite kuyruğuna yazılır. Boş bir worker aynı oturumda ikinci bir iş yoksa görevi alır, Pi `Agent` oluşturur, oturum transkriptini yükler, işi çalıştırır ve transkripti geri yazar.

## Önbellek

DeepSeek otomatik prefix cache kullanır. Bu yüzden system prompt ve araç listesi oturum boyunca değişmez. Kullanıcıya özel bellek, çalışma alanı yolu ve saat, son kullanıcı mesajının sonundaki `<linco-context>` bloğuna gider. Araç sırası `createTools` içinde sabittir. Sıralamayı değiştirmek prefix'i bozar.

Pi, DeepSeek'in `prompt_cache_hit_tokens` alanını `usage.cacheRead` olarak kaydeder. Her model turu `usage_events` tablosuna yazılır. Cache hit oranı `cacheRead / (input + cacheRead + cacheWrite)` olarak durur.

Transkript 180000 karakteri aşınca modele giden kopyanın ortası özetlenir. İlk system mesajı aynı nesne olarak kalır. İlk kullanıcı talimatı, sondaki turlar ve bir araç sonucunun `toolCall` eşi durur. Tutulan asistan mesajının gerekçe bloğu durur. SQLite kaydı kısalmaz. Büyük araç çıktısı istekte kısalsa da oturum kaydındadır. `LINCO_COMPACT=0` bu kopyalamayı kapatır. Eşik düşürülmedi. Özetten sonraki kısım cache kaçırır. Bu, sıkıştırmanın bedelidir. Token tahmini karakter/4'tür.

## Araçlar

Dosya araçları çalışma alanının dışına, sembolik link dahil, çıkamaz. Kabuk, çalışma alanını `cwd` ve `HOME` yapar. Ortamda API anahtarı yoktur. `..`, çalışma alanı dışı mutlak yol, `sudo`, `mkfs`, `dd`, kapanma ve `curl | bash` reddedilir. `rm` ve dosya silme onay kaydı açar, çalışmaz. Onay gelince aynı görev kuyruğa döner ve yalnızca o çağrı yeniden denenir. Ret görevi bitirir.

`web_fetch` HTTP metnidir. Sayfa betiği çalıştırmaz. `code_run` kısa bir JavaScript çalıştırır ve yalnızca kayıtlı araçları çağırabilir. `task_spawn` aynı çalışma alanında ayrı oturumlu bir çocuk görev bırakır. Çocuk, çocuk doğuramaz. Üst sınır 8'dir. `task_wait` çocuk bitmişse raporunu döner. `waitMs` tam 0 ise duruma bakar. Diğer halde çocuk açıksa ebeveyn `waiting_children` olur ve worker serbest kalır. Çocuk bitince tek koşullu güncelleme ebeveyni bir kez kuyruğa alır. Devam, `agent.continue()` ile aynı transkripttir. Yeni kullanıcı mesajı eklenmez. Devam işareti, bu çağrı başarıyla bitene kadar satırda durur. Hata sonrası yeniden kuyruk aynı işareti taşır. Çocuklar aynı dizine yazar. Ayrı dizin yoktur. İki yazma çakışabilir. Onay bekleyen çocuk, ebeveyni o onay bitene kadar parkta tutar.

## Hedef

Yeni oturumlar v4 araçlarını alır. Eski oturumun `plan_write` listesi durur. Hedef `goal_json` sütunundadır. Bağımlılığı bitmemiş adım kuyruğa girmez. Bağımsız adımlar mevcut çocuk görevleriyle paralel gider. Zorunlu kriter, dosya, araç izi veya çocuk sonucundan doğrulanır. `tool_ok` yalnızca o adımın çocuğundaki izi, ya da aynı aracı isteyen tek açık adımın `goalStepId` etiketli ebeveyn izini kabul eder. Kapatan iz `evidenceTraceId` olur. Doğrulanamayan kriter başarılı sayılmaz. Ana görev, açık adım varken `succeeded` olmaz. Başarısız adım yeniden planda `replaced` olur. Henüz başlamamış bağımlılar yeni adıma bağlanır. Başlamış adım ve bitmiş adım değişmez. Döngü kuran plan reddedilir. Aynı hata ikinci kez planlanmaz. Plan özeti system prompt'a yazılmaz. `goal_status` kısa araç sonucu verir. Basit görev plan açmaz.

Kabuk bir işletim sistemi sandbox'ı değildir. Seatbelt, Landlock veya OpenShell bu fazda yok.

## Çok kullanıcı

Her kullanıcının dizini `data/workspaces/<userId>` altındadır. Oturumlar, bellek ve otomasyon kullanıcıya bağlıdır. Aynı oturumda iki görev aynı anda çalışmaz. Farklı oturumlar worker sayısınca paralel çalışır. Süreç hâlâ tek makinededir. Kuyruk tablosu, işi sonra başka bir sürece taşıyabilecek yerdir.

## Dışarıda bırakılanlar

NeMo çalışma anına bağlı değildir. `GET /v1/tasks/:id/observe` onun daha sonra okuyabileceği bir iz bırakır. Hermes bellek, skill, cron, heartbeat ve webhook davranışları Linco tablolarında yeniden yazıldı. DeepSeek paketleri içe aktarılmadı. Code mode, plan listesi, çocuk görev ve iz, Pi araçları olarak duruyor.
