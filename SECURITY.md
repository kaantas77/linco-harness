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

## Kabuk izolasyonu yok

`shell_exec` `LocalComputerProvider` üzerinden `spawn(..., { shell: true })` çalıştırır. Bu, Unix'te `sh -c` demektir. Sınır şunlardır: çalışma dizini, `HOME` ve `TMPDIR` çalışma alanı, ortam listesinde API anahtarının olmaması, `src/security/policy.ts` içindeki düzenli ifadeler.

Bu bir işletim sistemi sandbox'ı değildir. İfade filtresini geçen bir komut, süreç kullanıcısının görebildiği dosyaları ve ağı kullanır. `code_run` da Node `vm` içindedir ve güvenlik sınırı değildir.

Üretim engeli: kabuk ve code mode, paylaşılan bir makinede kullanıcıları birbirinden ayırmaz.

## Çoklu süreçte görev yarışı

Aynı süreçteki worker'lar bir satırı iki kez alamaz. `claimTask` önce aday satırı seçer, sonra `UPDATE ... WHERE id = ? AND status = 'queued'` çalıştırır ve `changes === 1` değilse satırı bırakır.

Bu, çöken worker için kira değildir. Süreç ölürse satır `running` kalır. Onu geri kuyruğa alan bir süre yoktur.

Transkript yazımı da süreçler arasında kilitli değildir. İki süreç aynı SQLite dosyasını açarsa, aynı oturumun transkriptini sırayla ezebilir. WAL ve `busy_timeout` yazma çakışmasını bekletir. Oturum sahipliğini tek yazıcıya bağlayan bir çit yoktur.

Üretim engeli: ikinci bir süreç aynı kuyruğu güvenle tüketemez. Tek süreç içindeki koşullu güncelleme, çökme sonrası takılan işi ve çapraz süreç transkript yazımını çözmez.
