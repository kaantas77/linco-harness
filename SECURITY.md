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

İptal, uzak komutun bitmesini beklemez. `code_run` yorumlayıcısı hosttaki kapılı süreçte kalır; çağırdığı dosya ve kabuk araçları Boat modunda makineye gider. Sanal makinedeki `web_fetch` adres kontrolünü hostta yapar, sonra sabitlenmiş adresle makinede `curl` çalıştırır. Makinenin kendi sonraki bağlantısı bu kontrolün dışında kalabilir. Boşta duran makine `LINCO_BOAT_IDLE_MS` sonra durur. `LINCO_BOAT_MAX_SECONDS` aşılınca yeni komut reddedilir. Canlı koşunun tavanı small, 1500 saniye, Boat $0.10 ve DeepSeek $0.75 idi. Makine sonunda silindi.

## Kira ve çit

`holdsLease` worker kimliğini, fence değerini ve kira süresini birlikte ister. Süre dolmuş kira yenilenmez. `setPlan`, `setGoal`, transkript, terminal durum, iz ve kullanım yazısı bu şarta bağlıdır. Çocuk kuyruğu ve hedef güncellemesi tek transaction'dadır. Yarım çocuk bırakılmaz.

İki süreç testi, süresi dolmuş worker'ın hedefi, planı, çocuğu ve transkripti yazamadığını gösterir. Başka süreç aynı fence ile yazamaz.

Kalan kapı: exactly-once yoktur. Araç, kira kontrolünden sonra ve iz yazılmadan dosyayı değiştirebilir. Tarama o izi görmezse işi yeniden kuyruğa alabilir. Ağ dosya sistemiyle paylaşılan SQLite desteklenmez.

## Ölçüm

`reports/security.md`. Mod offline. `performanceClaim` none. Seatbelt bu makinede anonim isteği, başka kullanıcının görevini, özel DNS cevabını, metadata yönlendirmesini, `/etc/passwd` okumasını, başka çalışma alanını ve süresi dolmuş kirayı reddetti. Bu bir sıralama değildir.
