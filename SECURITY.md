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

Seatbelt, kullanıcı evini, `/private` altını ve `/etc` içeriğini okumayı reddeder. Yazma yalnız görev çalışma alanındadır. Ağ reddedilir. Çalışma zamanının kendi dizini, `/usr`, `/bin`, `/System`, `/Library`, `/opt` ve `/dev` okunabilir. Süreç başlayabilsin diye bu araç ağaçları açıktır. CPU saniyesi, süreç sayısı, açık dosya ve dosya boyutu `ulimit` ile sınırlanır. Duvar saati araç zaman aşımıdır.

`code_run` sandbox zorunluyken ayrı bir Node sürecindedir. Araç çağrıları ebeveyne döner. Süreç aynı dosya ve ağ sınırındadır. `vm` tek başına güvenlik sınırı sayılmaz.

Kalan kapı: Darwin `ulimit -v` güvenilir bir adres alanı sınırı vermez. Bellek tavanı iddia edilmez. `/opt` ve sistem dizinleri okunabilir. İki kullanıcının çocukları aynı çalışma alanına yazarsa dosya çakışabilir. Çocuklar kullanıcının çalışma alanını paylaşır. Ayrı kullanıcıların dizinleri sandbox tarafından ayrılır. Yazılmış dosya, kira düşünce geri alınmaz.

## Kira ve çit

`holdsLease` worker kimliğini, fence değerini ve kira süresini birlikte ister. Süre dolmuş kira yenilenmez. `setPlan`, `setGoal`, transkript, terminal durum, iz ve kullanım yazısı bu şarta bağlıdır. Çocuk kuyruğu ve hedef güncellemesi tek transaction'dadır. Yarım çocuk bırakılmaz.

İki süreç testi, süresi dolmuş worker'ın hedefi, planı, çocuğu ve transkripti yazamadığını gösterir. Başka süreç aynı fence ile yazamaz.

Kalan kapı: exactly-once yoktur. Araç, kira kontrolünden sonra ve iz yazılmadan dosyayı değiştirebilir. Tarama o izi görmezse işi yeniden kuyruğa alabilir. Ağ dosya sistemiyle paylaşılan SQLite desteklenmez.

## Ölçüm

`reports/security.md`. Mod offline. `performanceClaim` none. Seatbelt bu makinede anonim isteği, başka kullanıcının görevini, özel DNS cevabını, metadata yönlendirmesini, `/etc/passwd` okumasını, başka çalışma alanını ve süresi dolmuş kirayı reddetti. Bu bir sıralama değildir.
