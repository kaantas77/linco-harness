# Güvenlik sınırları

Bu dosya faz 8'den sonra hâlâ açık olan kapıları tutar. Kapatılanlar da burada, iddia edilenden ayrı durur. Bunlar performans iddiası değildir.

## Kimlik

Varsayılan `LINCO_AUTH` değerinin yokluğu token modudur. `Authorization: Bearer` olmadan `/health` ve webhook dışındaki istekler 401 döner. Kullanıcı yaratmak bootstrap token ister. `LINCO_BOOTSTRAP_TOKEN` yoksa `linco serve` token'ı bir kez stderr'e yazar ve düz metin olarak kaydetmez. Kullanıcı token'ı yaratma cevabında bir kez döner. Veritabanında yalnız SHA-256 özeti durur.

Kullanıcı, başkasının oturumunu, görevini, belleğini, otomasyonunu ve bildirimini göremez. Başka kullanıcıya ait görev kimliği iptal, onay ve inspection okumasında 404 döner. Bootstrap token görev okuyamaz.

`LINCO_AUTH=dev` eski açık localhost kullanımını bırakır. Bu mod `127.0.0.1`, `localhost` veya `::1` dışında dinlemeyi reddeder. Üretim modu değildir.

Webhook yolu kendi gizli token'ını taşır. Bu bir kullanıcı oturumu değildir. Token'ı bilen, o otomasyonun kullanıcısı adına görev kuyruğa alır.

Kalan kapı: TLS yoktur. Token çalınırsa o kullanıcının yetkisi ele geçer. İlk bootstrap satırı processes arasında paylaşılmaz. `linco worker` kimlik satırını yönetmez.

## SSRF

`web_fetch` ve Playwright aynı hedef kuralını kullanır. Özel ağlar, link-local, metadata adları ve bu adreslere çözülen hostlar reddedilir. Sayısal host adları reddedilir. Her yönlendirmede hedef yeniden kontrol edilir. Bağlantı, kontrol edilen adrese sabitlenir. Böylece ikinci DNS cevabı özel adrese kayamaz.

Loopback varsayılan olarak kapalıdır. `LINCO_ALLOW_LOOPBACK=1` yalnız yerel test sayfaları içindir. Bu bayrak özel ağı açmaz.

Kalan kapı: DNS kaydı kontrol ile bağlantı arasında değişirse sabitlenmiş adres kullanılır. Hedef sunucunun kendisi, izinli bir adresin arkasından iç ağa bağlanırsa bu katman onu görmez. Jev, `TYPESAFE_API_KEY` varken sayfa başlığını, adresini ve görevin verdiği alan değerlerini TypeSafe'e gönderir. Şifre adayı snapshot'a alınmaz.

## Kabuk ve code mode

`shell_exec` macOS'ta `sandbox-exec` ile çalışır. Linux'ta `/usr/bin/bwrap` varsa bubblewrap kullanır. İkisi de yoksa komut çalışmaz. `LINCO_SANDBOX=off` bu reddi kaldırır ve izolasyon yoktur.

Seatbelt, kullanıcı evini, `/private` altını, `/etc` içeriğini, `/Volumes`, `/mnt`, `/media`, `/Network`, `/opt`, `/Library` ve `/Applications` okumayı reddeder. Yazma yalnız görev çalışma alanındadır. Ağ reddedilir. Çalışma zamanının kendi dizini, `/usr`, `/bin`, `/sbin`, `/System` ve `/dev` okunabilir. Süreç başlayabilsin diye bu araç ağaçları açıktır. CPU saniyesi, süreç sayısı, açık dosya ve dosya boyutu `ulimit` ile sınırlanır. Duvar saati araç zaman aşımıdır.

`code_run` sandbox zorunluyken ayrı bir Node sürecindedir. Araç çağrıları ebeveyne döner. Süreç aynı dosya ve ağ sınırındadır. `vm` tek başına güvenlik sınırı sayılmaz.

Kalan kapı: Darwin `ulimit -v` güvenilir bir adres alanı sınırı vermez. Bellek tavanı iddia edilmez. `/usr`, `/bin` ve `/System` okunabilir. İki kullanıcının çocukları aynı çalışma alanına yazarsa dosya çakışabilir. Çocuklar kullanıcının çalışma alanını paylaşır. Ayrı kullanıcıların dizinleri sandbox tarafından ayrılır. Yazılmış dosya, kira düşünce geri alınmaz.

## Boat

`LINCO_COMPUTER=boat` her Linco kullanıcısına bir sanal makine bağlar. Oluşturma `noEnv` kullanır ve hesabın gizli değişkenlerini makineye koymaz. `BOAT_API_KEY` yalnız süreç ortamındadır. Araç sonucu, görev hatası ve HTTP cevabı anahtarı, `on.boat.dev` adresini ve `_token` değerini yazmaz. Masaüstü izleme URL'si saklanmaz.

Dosya, kabuk ve sayfa okuma o makinede çalışır. Host dizini bu araçlarla değişmez. Başka kullanıcının makinesine komut gitmez. Masaüstü kilitlidir. Tıklama, yazma, pencere ve tarayıcı açma onay ister. Model görüntü kabul etmiyorsa ağaç döner ve görüntü işlenmiş sayılmaz.

Durmuş diskin Boat belgesinde 14 gün kaldığı, `/home/user` içinin durduğu, `/tmp`, `~/.cache` ve çalışan süreçlerin durmadığı yazılır. Sahte API bu kuralı uygular. `reports/boat.md` sahte kayıttır. `reports/boat-live.md` gerçek hesaptır.

Canlı sürücü `cua-driver` 0.23.2 stdin'i JSON satırı olarak okur. `Content-Length` başlığı ilk kolonda ayrıştırma hatası verdi. Linco artık her MCP mesajını tek JSON satırı yazar. Araç adları canlı `tools/list` ile doğrulandı. Masaüstü kilidi ikinci görevi `desktop is in use by another task` ile çevirdi. Eksik sandbox kimliği `boat api 404 not_found` döndü. Gerçek kimlikler `bx_` ile başlar. `usage.seconds` ilk okumada 0 kaldı; `usage.dollars` sonraki okumalarda değişti.

Sürücü `tools/call` içinde `isError` veya `type: error` döndürürse Linco bunu başarılı araç sonucu saymaz. Çağrıdan önce argümanlar canlı `tools/list` şemasındaki zorunlu alanlara bakılır. Eksik alan sürücüye gitmez.

Faz 10.1 kaydı `reports/computer-use.md` içindedir. Makine `bx_5zp78mwa` silindi. Yazma 5/5 bağımsız okumayla durdu. Chrome 0/5: pencere `New Tab - Chromium` kaldı ve `browser_route_unavailable` erişilebilirlik yolunun AT-SPI ağacı olmadığını söyledi. Bu başlık doğrulanmadı. Bu makinede görüntü okuma 0/5 oldu. Daha önceki silinmiş `bx_amtewwdh` makinesinde Flash 5 görüntünün 2'sinde kodu tutturdu. Yanlış okuma başarı değildir.

Faz 10.2 kaydı `reports/computer-use-v2.md` içindedir. Yayımlanan makine `bx_9tcbmyxj` silindi. Ondan önceki `bx_ek9jw5yf` de silindi; orada servis komutu bash tarafından reddedildi. İzole Chrome profili `/home/user/linco/.linco/chrome-profile` altındadır ve hata ayıklama portu yalnız `127.0.0.1` dinler. `vm_browser_goto` ve `vm_browser_fill` onay ister. Adres, komuttan önce özel ağ ve metadata kurallarından geçer. Host Playwright araçları Boat oturumuna eklenmez. Bu koşuda `playwright-core` yüklenmedi; aynı izole Chrome CDP ile sürüldü. Cua bir kez example.com başlığını açtı. Form değeri cevap gövdesinde vardı. Yazmanın sonunda bir boşluk kaldı. Görüntüde Flash orijinal PNG'de 0/3, high ayrıntıda 0/3, masaüstü görüntüsünde 0/3 ve Cua pencere görüntüsünde 1/3 tutturdu. Serbest yazma görevinde model başarılı dedi; `desktop_type` çağrılmadığı için bu başarı sayılmadı. İkinci görev aynı makinede kilit yüzünden giremedi.

Faz 10.3 kaydı `reports/release-candidate.md` içindedir. Yayımlanan makine `bx_3hbbmdmv` silindi. `bx_mx9dpp9w` de silindi. `--remote-allow-origins=*` kalktı. Yerine `--remote-allow-origins=http://127.0.0.1:9333` var ve port yine yalnız `127.0.0.1` dinliyor. Bu, sanal makinenin içindeki başka bir sürecin hata ayıklama portuna bağlanmasını engellemez. Herkese açık kullanıma hazır değildir. `browser_navigate` ve `browser_open_read` onay ister. `browser_click`, `browser_fill` ve `browser_select` yerel Playwright araçlarıyla aynı adı taşıdığı için mevcut izin kuralında kalır. Eski `snapshotId` reddedilir. Parola, MFA veya CAPTCHA `USER_TAKEOVER_REQUIRED` döner ve alan değeri snapshot'a yazılmaz. `web_search` ve `web_extract` anahtar yoksa hata döner. Yayımlanan alt kümede tarayıcı 14/14, masaüstü 2/5, serbest görev 2/2. Masaüstünün üç dosyası okunamadı ve başarısız sayıldı.

Faz 10.4 kaydı `reports/pilot-readiness.md` içindedir. Makine `bx_jhq9jey5` silindi. `readText` olmayan dosyada HTTP 400 `sandbox_direct_failed` döndürür. `cat` aynı anda `No such file` yazar ve komut API'si ayaktadır. Sandbox `ready` kalır. Bu, Faz 10.3'teki okuma hatalarının kök nedenidir. Yeni dosya penceresine yazılan on kaydın onu `cat` ile doğrulandı. Chrome hata ayıklama portuna aynı VM içindeki `user` kabuğu 200 ile ulaştı. Ayrı bir tarayıcı kullanıcısı kurulmadı; imaj tek `user` hesabı veriyor ve bu faz ikinci hesap açmadı. Metadata IP'si host kontrolünde reddedildi. `httpbin` yönlendirmesi zaman aşımına düştü ve reddedildiği kanıtlanmadı. Son URL metni kontrol edilir; yönlendirmeden sonra DNS yeniden çözülmez ve sayfanın alt kaynakları denetlenmez. Bu üç madde üretim engelidir. Herkese açık kullanıma hazır değildir.

Faz 10.5 kaydı `reports/agent-reliability.md` ve `reports/security-gates.md` içindedir. Makine `bx_thha4kef` silindi. Eylem sözleşmesi kullanıcı metninden türetilir. Model durunca görev kendiliğinden `succeeded` olmaz. Boat üzerinde `browser_click`, `browser_fill` ve `browser_select` onay ister. Yerel Playwright araçlarının adı aynıdır ve onların izni değişmedi. Canlı matrisin otomatik onayı test sürecindedir. Üretimde kullanıcının yerine geçmez. Parola, CAPTCHA, MFA, ödeme, satın alma, gönderme ve silme mevcut kullanıcı kontrolünde kalır. Chrome TCP `9333` dinlemez. Hata ayıklama borusu üst sürecin 3 ve 4 numaralı dosya tanımlayıcılarındadır. Web çıkışı `127.0.0.1` üzerindeki bir vekilden geçer. Vekil özel ve metadata adreslerini reddeder. Aynı `uid 1000` kabuğu `browser.sock` dosyasını açabilir ve kendi Chrome sürecini başlatabilir. Bu, ayrı bir güven alanı değildir. Metadata yönlendirmesinde sayfa `httpbin` adresinde kaldı. Metadata adresi görülmedi. Açık bir red de dönmedi. Zaman aşımı güvenli red sayılmaz. Herkese açık kullanıma hazır değildir.

Faz 10.6 kaydı `reports/action-execution.md` içindedir. Makineler `bx_kvp7mkx3`, `bx_av5296mb` ve `bx_hk45dneg` silindi. `desktop_edit_file` ve `code_write_run` mevcut onay kapısından geçer. İlki masaüstü yazmasıdır ve onay ister. İkincisi kabuk politikasından geçer; `sudo` reddedilir, zaman aşımı ve sıfırdan farklı çıkış hata olarak döner. Canlı matrisin otomatik onayı yine test sürecindedir. Chrome borusu, çıkış vekili, `browser.sock` ve yönlendirme boşluğu durur. Herkese açık kullanıma hazır değildir.

Faz 11 kaydı `reports/backend-integration.md` ve `reports/pilot-security.md` içindedir. Sözleşme `docs/API.md` ve `docs/INTEGRATION.md` içindedir. Kod görevinin doğrulayıcısı artık kırpılmış metindeki `exit 0` yazısına bakmaz. İzde `exitCode`, `timedOut`, `stdout`, `path` ve `command` durur. Başarı bu alanlardan çıkar. Daha önceki başarısız komut sonrakini düşürmez. `echo`, yalnız `code_run` ve model cümlesi başarı sayılmaz. Eksik dosya başarısızdır. Okunamayan dosya `needs_inspection` kalır. Faz 10.6'daki 9/10 değişmedi. `LINCO_VM_BROWSER` kapalıdır; API Chrome başlatmaz ve `browserAct` soketi yazmadan reddeder. Soket yolu, açılırsa, çalışma alanının dışında `/home/user/.linco/browser.sock` olur. Kabuk ve `code_write_run` bu yolu, metadata adresini ve hata ayıklama bayrağını reddeder. Çalışma anında kurulan yol, tarayıcı süreci açıksa hâlâ aynı kullanıcıya açıktır. Bu yüzden tarayıcı kapalı kalır. Yönlendirme, alt kaynak ve DNS yeniden bağlama doğrulanmış red değildir. Kullanıcı jetonu başkasının oturumuna, görevine ve makinesine 404 alır. Cevaplarda `sk-` ve `boat_` silinir. Görev `LINCO_TASK_MAX_TOKENS` ve `LINCO_TASK_MAX_COST_USD` tavanını aşınca `failed` olur. Herkese açık kullanıma hazır değildir. Dağıtım yapılmadı.

Faz 12 kaydı `reports/application-integration.md` ve `reports/pilot-security-v2.md` içindedir. weblinco ekranları durur. Uygulama sunucusu `externalUserId` gönderir; Linco kullanıcı jetonu tarayıcıya dönmez. `LINCO_VM_BROWSER` kapalıyken `desktop_browser`, `desktop_window`, `desktop_batch`, kabuk, `code_write_run` ve Boat yöneticisi Chrome başlatmayı reddeder. Kapalı makine açılırken eski Chrome süreçleri, her iki soket ve profil yolu mühürlenir. Aynı uid o izni geri açabilir. Yönlendirme, alt kaynak, DNS yeniden bağlama ve metadata yönlendirmesi ayrı testlerden geçmedi. Bu yüzden tarayıcı kapalı kalır ve herkese açık kullanım NO-GO durur. Dağıtım yapılmadı.

İptal, uzak komutun bitmesini beklemez. `code_run` yorumlayıcısı hosttaki kapılı süreçte kalır; çağırdığı dosya ve kabuk araçları Boat modunda makineye gider. Sanal makinedeki `web_fetch` adres kontrolünü hostta yapar, sonra sabitlenmiş adresle makinede `curl` çalıştırır. Makinenin kendi sonraki bağlantısı bu kontrolün dışında kalabilir. Boşta duran makine `LINCO_BOAT_IDLE_MS` sonra durur. `LINCO_BOAT_MAX_SECONDS` aşılınca yeni komut reddedilir. Canlı koşunun tavanı small, 1500 saniye, Boat $0.10 ve DeepSeek $0.75 idi. Makine sonunda silindi.

## Kira ve çit

`holdsLease` worker kimliğini, fence değerini ve kira süresini birlikte ister. Süre dolmuş kira yenilenmez. `setPlan`, `setGoal`, transkript, terminal durum, iz ve kullanım yazısı bu şarta bağlıdır. Çocuk kuyruğu ve hedef güncellemesi tek transaction'dadır. Yarım çocuk bırakılmaz.

İki süreç testi, süresi dolmuş worker'ın hedefi, planı, çocuğu ve transkripti yazamadığını gösterir. Başka süreç aynı fence ile yazamaz.

Kalan kapı: exactly-once yoktur. Araç, kira kontrolünden sonra ve iz yazılmadan dosyayı değiştirebilir. Tarama o izi görmezse işi yeniden kuyruğa alabilir. Ağ dosya sistemiyle paylaşılan SQLite desteklenmez.

## Ölçüm

`reports/security.md`. Mod offline. `performanceClaim` none. Seatbelt bu makinede anonim isteği, başka kullanıcının görevini, özel DNS cevabını, metadata yönlendirmesini, `/etc/passwd` okumasını, başka çalışma alanını ve süresi dolmuş kirayı reddetti. Bu bir sıralama değildir.
