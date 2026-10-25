# Üretim öncesi güvenlik engelleri

Bu dosya faz 1 kodunun üretimde açılmasını engelleyen dört maddeyi ayrı ayrı tutar. Dördü de giderilmeden Linco Harness birden fazla kullanıcıya veya herkese açık bir ağa verilmez. Bunlar ölçüm raporundaki performans iddiası değildir.

## HTTP kimlik doğrulaması yok

`src/server/http.ts` gelen istekte kullanıcı, oturum veya token kontrol etmez. `127.0.0.1:8787` varsayılanıdır. Bu adres başka bir arayüze, tünele veya `LINCO_HOST=0.0.0.0` ile dış ağa açılırsa, isteği gören herkes kullanıcı yaratır, mesaj gönderir, onaylar, belleği okur ve webhook çalıştırır.

Üretim engeli: sunucu, çağıranı doğrulamadan görev kabul ediyor.

## SSRF

`web_fetch` (`src/tools/http-browser.ts`) yalnızca `http` ve `https` kabul eder. Engellenen hostlar şunlardır: `169.254.169.254`, `metadata.google.internal`, `169.254.170.2`.

Şunlar engelli değildir:

- `127.0.0.1` ve diğer özel adresler
- yönlendirme (`redirect: "follow"`). İlk host engelli olsa bile sonraki adres kontrol edilmez
- DNS yeniden bağlama. Host adı çözülürken kontrol edilen dize ile bağlanılan adres ayrı tutulmaz

Üretim engeli: model, çalışma alanındaki bir araçla iç ağa ve bulut metadata adreslerinin bu listedeki üçü dışındaki hallerine istek atabilir.

Tarayıcı navigasyonu (`src/browser/navigation-policy.ts`) ayrı bir kontrol kullanır. Loopback açıktır. `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, metadata adları ve sayısal hostlar reddedilir. Her istek Playwright route'undan da geçer. Jev'in snapshot izin listesi aynı host kurallarını DNS sorgusu olmadan uygular. Hostname'in özel adrese çözülmesi navigasyonda reddedilir. Bu, yönlendirme sonrası adres ve DNS yeniden bağlamayı kapatan bir üretim sınırı değildir. `TYPESAFE_API_KEY` varken `jev_run`, sayfa başlığını, adresini, öğe adlarını ve görevin verdiği alan değerlerini TypeSafe'e gönderir. Alanın içindeki metin snapshot'ta yoktur. Şifre adayı olmaz. Tarayıcı bu haliyle yerel geliştirme içindir.

## Kabuk izolasyonu yok

`shell_exec` `LocalComputerProvider` üzerinden `spawn(..., { shell: true })` çalıştırır. Bu, Unix'te `sh -c` demektir. Sınır şunlardır: çalışma dizini, `HOME` ve `TMPDIR` çalışma alanı, ortam listesinde API anahtarının olmaması, `src/security/policy.ts` içindeki düzenli ifadeler.

Bu bir işletim sistemi sandbox'ı değildir. İfade filtresini geçen bir komut, süreç kullanıcısının görebildiği dosyaları ve ağı kullanır. `code_run` da Node `vm` içindedir ve güvenlik sınırı değildir.

Üretim engeli: kabuk ve code mode, paylaşılan bir makinede kullanıcıları birbirinden ayırmaz.

## Çoklu süreç

Aynı makinedeki iki Node süreci tek SQLite dosyasını paylaşabilir. `claimTask` aday seçimini ve `queued` satırın `running` oluşunu tek `BEGIN IMMEDIATE` işleminde yapar. Aynı oturumun ikinci görevi, ilki `running` iken alınmaz. Sahiplenme worker kimliği, artan `fence`, kira bitişi ve son heartbeat yazar. Canlı worker kirayı yeniler.

Kira dolunca tarama kör tekrar yapmaz. Okuma izi olan veya hiç araç izi olmayan görev yeniden kuyruğa girer. Yazma, silme, kabuk, dış istek, tarayıcı ve çocuk doğurma gibi belirsiz izler `needs_inspection` olur. Başlamış ama bitmemiş araç da incelemeye gider. Bu durum ebeveyni sonsuza kadar bekletmez. Yazılmış dosya geri alınmaz. Exactly-once iddiası yoktur.

Transkript ve terminal yazımı, satır hâlâ `running` ve `fence` hâlâ o worker'a aitse geçer. Eski worker'ın geç yazısı sıfır satır değiştirir. `resumeChildren` işareti bu kurtarmada silinmez.

`waiting_children` uyanışı koşullu bir güncellemedir. Durum hâlâ `waiting_children` ise ve beklenen her çocuk bitmişse satır bir kez `queued` olur. İkinci çağrı bir şey yapmaz. Başarısız bir devam denemesi aynı transkriptten devam işaretini korur. Bu, çağrı sırasında yazılmış dosyayı geri almaz.

Üretim engeli: bu koruma tek makinedeki yerel dosya içindir. Ağ dosya sistemiyle paylaşılan SQLite desteklenmez. Kira, harici yan etkiyi geri alamaz. HTTP kimlik doğrulaması, SSRF ve kabuk izolasyonu ayrı kapılardır.

İstek sıkıştırması kaydı silmez. Modele giden kopya kısalabilir. SQLite transkripti durur.
