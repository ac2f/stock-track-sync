# StockTrack Eşitleme Ajanı

Dükkândaki **yerel sunucu** (StockTrack, `SYNC_ROLE=replica`) ile **merkez
sunucuyu** eşitler. İnternet kesildiğinde ya da merkez çöktüğünde dükkân yerel
sunucuyla çalışmaya devam eder; bağlantı gelince bu program yerelde yapılan
işlemleri merkeze gönderir, merkezdeki değişiklikleri yerele indirir —
**veri kaybı ve çift kayıt olmadan**.

Sözleşmenin tamamı: `stock-track` reposunda `docs/SYNC.md`.

```
 Merkez (internet)                       Dükkân bilgisayarı
 ┌──────────────────┐   HTTPS   ┌──────────────────────────────────────────┐
 │ StockTrack       │◄─────────►│  eşitleme ajanı (bu program)             │
 │ /api/v1/sync/*   │           │        │ SQL                             │
 └──────────────────┘           │        ▼                                 │
                                │  yerel PostgreSQL ◄── yerel sunucu :3000 │
                                │                        ▲                 │
                                │      tarayıcı · Corel · runner           │
                                └──────────────────────────────────────────┘
```

## Ne yapar

Birkaç saniyede bir (merkez yoksa üstel bekleyerek) bir **tur** atar:

1. **Nabız**: arayüz "ajan çalışıyor" görsün (merkez yokken de sürer).
2. **Bağlantı**: yerel sunucunun ve merkezin sürümü (şema özeti) aynı mı,
   doğru merkeze mi bağlanıyor? Değilse eşitleme yapmaz, nedenini yazar.
3. **Gönder**: giden kutusundaki işlemler (satış, tahsilat, teklif, runner
   klasör bildirimi…) yapılış sırasıyla merkeze gider. Merkez her birini o
   kişi adına, aynı kurallarla (stok, yetki, cari) yeniden işler. Aynı işlem
   iki kez gitse de **bir kez** uygulanır; kayıtlar merkezde **aynı kimlik**,
   teklifler **aynı numara** ve **yerel işlem zamanıyla** açılır.
4. **Duraklat**: yerel yazmalar birkaç saniye bekletilir (en çok 30 sn; ajan
   ölse de kendiliğinden kalkar), kalan işlemler gönderilir.
5. **Geri al (rebase)**: yerelde değişen satırlar merkezdeki asıl hale
   getirilir — merkezin reddettiği işlemin yerel etkisi kalkar.
6. **Çek**: merkezdeki değişiklikler yerele iner.

İlk kurulumda boş yerel veritabanını merkezden **ilk yükleme** ile doldurur.
Merkez günlüğünün gerisinde kalırsa (410) önce bekleyen işlemleri gönderir,
sonra **baştan yükler**; giden kutusu ve kişinin kararları korunur.

Merkezin **reddettiği** işlemler (ör. stok başka yerde satılmış) ve yerel
sunucu işlem ortasında kapandığı için **belirsiz** kalanlar asla kendiliğinden
gönderilmez ya da silinmez: yerel sunucunun **Eşitleme** ekranında kişi
"yeniden dene" ya da "vazgeç" der.

## Kurulum

Önce:

1. Merkezde **Ayarlar › Yerel sunucular** → ad + dükkânlar → **Anahtar üret**.
   Anahtar (`str_…`) yalnız bir kez gösterilir.
2. Dükkân bilgisayarında yerel sunucu kurulu ve çalışıyor olmalı
   (`stock-track/docker-compose.replica.yml`, bkz. `docs/SYNC.md` § 9).

### Docker (önerilen)

```bash
git clone https://github.com/ac2f/stock-track-sync
docker build -t stocktrack-sync:latest stock-track-sync
```

`stock-track/docker-compose.replica.yml`'deki yorumlu `sync-agent` servisini
şöyle açın (merkez adresi ve anahtar `.env` dosyasında):

```yaml
  sync-agent:
    image: stocktrack-sync:latest
    container_name: stocktrack-sync-agent
    restart: unless-stopped
    depends_on:
      replica-db:
        condition: service_healthy
      api:
        condition: service_started
    environment:
      UPSTREAM_URL: ${UPSTREAM_URL}          # https://merkez.ornek.com/api/v1
      REPLICA_TOKEN: ${REPLICA_TOKEN}        # str_…
      LOCAL_API_URL: http://api:3000/api/v1
      REPLICA_DB_URL: postgres://${DB_USERNAME:-stocktrack}:${DB_PASSWORD:-stocktrack}@replica-db:5432/${DB_NAME:-stocktrack}
    volumes:
      - sync_logs:/app/logs

volumes:
  replica_pgdata:
  sync_logs:
```

```bash
docker compose -f docker-compose.replica.yml up -d
docker logs -f stocktrack-sync-agent        # İlk yükleme bitti: … satır
```

İmaj `node` kullanıcısıyla çalışır; sağlık denetimi konteynerin içindeki
`/health` ucunu kullanır (`docker ps` → `healthy`).

### Windows 10/11

1. [Node.js 20 LTS](https://nodejs.org) (ya da daha yenisi) kurun.
2. Bu repoyu indirin (Code › Download ZIP) ve açın.
3. `install.bat`'a **sağ tıklayın › Yönetici olarak çalıştır**. Merkez adresi,
   anahtar ve yerel veritabanı parolası sorulur (bilinmiyorsa boş bırakın:
   `stocktrack`).
   - Yönetici olarak kurulursa ajan **bilgisayar açılışında**, kimse oturum
     açmadan başlar; normal kurulumda **oturum açılışında**.
   - Çökerse 5 sn sonra kendiliğinden yeniden başlar.
4. Kurulum bağlantıyı dener (`--check`) ve ilk turun sonucunu gösterir.

Kurulum yeri `%LOCALAPPDATA%\StockTrackSync`: `config.json` (anahtar ve
parola; yalnız sizin kullanıcınız, SYSTEM ve yöneticiler okuyabilir),
`logs\`, `dist\`. Ayar değiştirince ajanı yeniden başlatın (Görev
Zamanlayıcı › *StockTrack Esitleme Ajani* › Sonlandır / Çalıştır) ya da
`install.bat`'ı yeniden çalıştırın (ayarlar korunur).

Kaldırmak: `uninstall.bat` (yönetici olarak kurduysanız yönetici olarak).
Yerel sunucuya ve bekleyen işlemlere dokunmaz.

### Linux (systemd)

```bash
sudo useradd --system --home /opt/stocktrack-sync stocktrack-sync
sudo git clone https://github.com/ac2f/stock-track-sync /opt/stocktrack-sync
cd /opt/stocktrack-sync && sudo npm ci && sudo npm run build && sudo npm prune --omit=dev
sudo install -m 600 /dev/null /etc/stocktrack-sync.env     # anahtar ve parola burada
sudoedit /etc/stocktrack-sync.env                           # UPSTREAM_URL=… REPLICA_TOKEN=… REPLICA_DB_URL=…
sudo cp systemd/stocktrack-sync.service /etc/systemd/system/
sudo systemctl enable --now stocktrack-sync
journalctl -u stocktrack-sync -f
```

## Ayarlar

Ortam değişkenleri ya da çalışma klasöründeki `config.json` (aynı adlar,
örnek: `config.example.json`; başka dosya için `CONFIG_FILE`). İkisi de
varsa **ortam değişkeni geçerlidir**; boş değer verilmemiş sayılır.

| Ad | Varsayılan | |
|---|---|---|
| `UPSTREAM_URL` | — (zorunlu) | Merkez API kökü, ör. `https://stok.ornek.com/api/v1` |
| `REPLICA_TOKEN` | — (zorunlu) | Merkezde Ayarlar › Yerel sunucular'dan (`str_…`) |
| `REPLICA_DB_URL` | — (zorunlu) | Yerel veritabanı, ör. `postgres://stocktrack:…@127.0.0.1:5433/stocktrack` |
| `LOCAL_API_URL` | `http://127.0.0.1:3000/api/v1` | Yerel sunucu (yalnız sürüm denetimi için) |
| `SYNC_INTERVAL_SECONDS` | `5` | Çevrimiçiyken tur aralığı |
| `SYNC_MAX_BACKOFF_SECONDS` | `60` | Merkez yokken bekleme üst sınırı (2 → 4 → 8 … sn) |
| `STATUS_PORT` | `3100` | `127.0.0.1`'de durum ucu (`0` = kapalı) |
| `LOG_DIR` | `./logs` | Günlük dosyaları (her gün yenisi, 7 gün saklanır) |
| `LOG_LEVEL` | — | `debug`: tablo tablo yükleme ayrıntısı |

Merkez adresi `https://` değilse ve yerel ağda değilse ajan uyarır (anahtar ve
veriler şifresiz gider).

## Komutlar

```bash
node dist/main.js               # çalıştır
node dist/main.js --check       # ayar, yerel veritabanı, yerel sunucu, merkez: [TAMAM]/[HATA]
node dist/main.js --resnapshot  # elle kurtarma: bir sonraki turda baştan yükle
node dist/main.js --version
```

Çıkış kodları: `0` normal, `1` ayar/beklenmedik hata (yeniden başlatılır),
`2` kişi müdahalesi gerekir (aynı veritabanında ikinci ajan, `REPLICA_DB_URL`
merkezin veritabanını gösteriyor) — systemd ve Windows çalıştırıcısı bunda
hemen yeniden başlatmaz.

## Durum

- **Arayüz**: yerel sunucunun üst şeridi ve **Eşitleme** ekranı (merkez
  bağlantısı, bekleyen/reddedilen/belirsiz işlemler, son hata). Ajan bunları
  `replica_state`'e yazar; nabız 2 dk'dan eskiyse arayüz "ajan çalışmıyor" der.
- **Durum ucu**: `curl http://127.0.0.1:3100/health`
  ```json
  { "ok": true, "upstream": true, "pending": 0, "rejected": 1, "uncertain": 0,
    "lastSeq": "48211", "lastError": null, "lastTourAt": "…", "version": "1.0.0" }
  ```
  `ok:false` (HTTP 503): eşitleme bir engel yüzünden duruyor (`lastError`).
  Merkez yokken `ok` true kalır, `upstream` false olur — ajan doğru çalışıyor.
- **Günlük**: `logs/sync-YYYY-MM-DD.log` (JSON satırları), konsola kısa özet.
  Anahtar ve parolalar maskelenir (`str_ab…`, `postgres://kullanıcı:***@…`).

## Sorun giderme

| Görülen (`last_error` / günlük) | Neden | Ne yapmalı |
|---|---|---|
| Merkez sunucuya ulaşılamıyor (…) | İnternet ya da merkez yok | Bir şey yapmayın; yerel sunucu çalışır, bağlantı gelince eşitlenir |
| Merkez bu yerel sunucunun anahtarını kabul etmedi (401/403) | Anahtar silinmiş, kapatılmış ya da yanlış | Merkezde Ayarlar › Yerel sunucular'dan kontrol edin; gerekirse yeni anahtar üretip `REPLICA_TOKEN`'a girin, ajanı yeniden başlatın |
| Sürüm farkı: merkez X, yerel Y | Merkez ve yerel sunucu farklı sürümde | İkisini aynı StockTrack sürümüne güncelleyin; eşitleme kendiliğinden sürer |
| Farklı bir merkeze bağlanılıyor | `UPSTREAM_URL` başka bir kurulumu gösteriyor | Adresi düzeltin. Merkez gerçekten değiştiyse yerel veritabanını sıfırlayıp baştan kurun |
| Yerel sunucuya ulaşılamıyor (`LOCAL_API_URL`) | Yerel sunucu kapalı | Yerel sunucuyu başlatın |
| Yerel veritabanına ulaşılamıyor / parola kabul edilmedi | PostgreSQL kapalı ya da `REPLICA_DB_URL` yanlış | Veritabanını başlatın, adresi/parolayı düzeltin (`--check`) |
| REPLICA_DB_URL merkez sunucunun veritabanını gösteriyor (çıkış 2) | Ajan merkezin veritabanına bağlanmak üzereydi | Adresi yerel sunucunun veritabanıyla değiştirin. Ajan bu veritabanına hiç yazmadı |
| Başka bir eşitleme ajanı zaten çalışıyor (çıkış 2) | Aynı veritabanında ikinci kopya | Fazla kopyayı kaldırın (ör. hem Docker hem Windows kurulumu) |
| Saat farkı: … dk geri/ileri | Bilgisayar saati yanlış | Saati düzeltin (iş tarihleri yerel saatle kaydedilir); eşitleme sürer |
| Merkezden gelen veri yerele yazılamadı: tablo id (…) | Merkezdeki satır yereldeki bir kurala uymuyor | Günlükteki ayrıntıyla bildirin; imleç ilerlemez, veri atlanmaz, her turda yeniden denenir |
| Reddedilen işlem (Eşitleme ekranı) | Merkez işlemi kabul etmedi (stok, yetki, silinmiş kayıt…) | Koşulu düzeltip **Yeniden dene** ya da **Vazgeç** |
| Belirsiz işlem | Yerel sunucu işlem ortasında kapandı | Yerelde yapılıp yapılmadığını kontrol edip **Yeniden dene** ya da **Vazgeç** |
| Teklif numarası merkezde … oldu | Numara merkezde başka teklife verilmiş | Corel klasörü eski numarayla kalmış olabilir; adını düzeltin |
| Gönderilemedi: işlem merkeze gönderilemeyecek kadar büyük | Tek işlem 100 KB sınırını aşıyor | İşlemi merkezde elle yapıp **Vazgeç** |

Kurtarma: `--resnapshot` bekleyen işlemleri gönderdikten sonra yerel veriyi
merkezden yeniden yükler (giden kutusu ve kararlar kalır).

## Ölçümler

Yük testi (`test/integration/load.test.ts`), 4 çekirdekli Linux, merkez + yerel
sunucu + iki PostgreSQL + ajan aynı makinede:

| | Süre | Ajanın en yüksek belleği |
|---|---|---|
| İlk yükleme, 10.000 müşteri | 3,1 sn | 137 MB |
| İlk yükleme, 100.000 müşteri | 31,5 sn | 146 MB |
| Çevrimdışı birikmiş 1.000 işlemin gönderimi | 13,1 sn (eşitlik 15,9 sn) | 98 MB |

Bellek veriyle büyümez: sayfa sayfa (2000 satır) yazılır, bellekte tek sayfa
tutulur. İlk yükleme ve baştan yükleme süresince yerel yazmalar bekletilir.

## Geliştirme ve testler

```bash
npm ci
npm run typecheck
npm test                    # birim testleri
npm run test:integration    # entegrasyon (aşağıdaki gereksinimlerle)
```

Entegrasyon testleri **gerçek merkez ve gerçek yerel sunucu** çalıştırır:

- Docker (iki ayrı PostgreSQL: `test/integration/docker-compose.test.yml`,
  testler kendisi `up` eder),
- yanında derlenmiş `stock-track` (`../stock-track`, ya da `STOCK_TRACK_DIR`):
  `cd stock-track/backend && npm ci && npm run build`.

Sunucular ve ajan testten süreç olarak başlatılır; merkezin önünde bir kaos
vekili bağlantıyı keser, istekleri geciktirir, yanıtı merkez işledikten sonra
düşürür. Her senaryo sonunda eşitlenen 40 tablonun hepsinde yerel = merkez
doğrulanır. Docker imajı testi (`docker.test.ts`) yalnız
`docker build -t stocktrack-sync:test .` yapılmışsa çalışır.

| Dosya | Kapsam |
|---|---|
| `contract.test.ts` | `stock-track/scripts/sync-contract-test.mjs` senaryosu, ajan adımları yerine bu ajan: ilk yükleme, yerelde satış/teklif/runner bildirimi, aynı kimlik/numara/zaman, çakışma ve red, vazgeç, merkezden gelen değişiklik |
| `decisions.test.ts` | Yeniden dene; yerel sunucu işlem ortasında öldürülünce belirsiz, gönderilmez; vazgeç |
| `chaos.test.ts` | Gönderim ortasında ağ kesilir; ajan rebase'de ve gönderimde `kill -9`; merkez çöker; aynı parti iki kez |
| `resnapshot.test.ts` | 410 → önce gönder, sonra baştan yükle, giden kutusu kalır; günlüğü tamamen budanmış merkez; `--resnapshot` |
| `identity.test.ts` | Şema farkı, farklı merkez, kapatılan anahtar, saat farkı, ikinci ajan, merkezin veritabanı, eksik ayar, günlükte gizli bilgi yok |
| `catchup.test.ts` | Uzun aradan sonra yakalama: sayfa sınırı onarımı, merkezin sıralama hatası (aşağıda) |
| `apply.test.ts` | Yazma motoru gerçek PostgreSQL'de: sıra, eksik üst kayıt, alt kayıt, benzersizlik, çözülemeyen durum |
| `load.test.ts` | 100.000 satır ilk yükleme, 1.000 çevrimdışı işlem, bellek |
| `docker.test.ts` | Konteynerdeki ajan |

## Bilinen sınırlar

- Windows kurulumu (`install.ps1`) yalnız sözdizimi denetiminden geçti; temiz
  bir Windows makinesinde baştan sona denenmedi.
- Ajan zorla durdurulursa (Windows'ta görev sonlandırma, `kill -9`) yerel
  yazma duraklatması en çok 30 sn sürer.
- Merkez yedekten geri yüklenmişse yalnız imleci yereldekinden küçükse
  anlaşılır ve baştan yüklenir; geri yüklemeden sonra merkezde yerelin
  imlecini aşacak kadar iş yapılmışsa anlaşılamaz (gerekirse `--resnapshot`).
- Uzun açık kalan (> 60 sn) merkez transaction'ları, merkezin boşluk kuralı
  gereği atlanabilir (sözleşmenin bilinen davranışı).

## Merkez sunucu için öneriler

Bunlar `stock-track` reposunda yapılmalı; ajan şimdilik bunlara karşı
önlemlidir.

1. **`/sync/changes` günlüğü metin olarak sıralıyor** (veri kaybı).
   `sync-feed.service.ts` → `changes()`:
   `SELECT seq::text AS seq … ORDER BY seq` — `ORDER BY` metne çevrilmiş
   sütunu kullanıyor (`'100' < '1000' < '55'`). Bekleyen aralık 99→100,
   999→1000… sınırını aşıyor ve bir sayfaya sığmıyorsa sayfa yanlış yerden
   kesilir, imleç bazı satırların üstünden atlar; o satırlar yerele hiç
   gelmez. Kanıt: `catchup.test.ts`'in ilk senaryosu, ajandaki önlem
   (`src/pull.ts` → `crossesDecade`) kapatılınca 44 müşteri satırı eksik
   kalıyordu. Düzeltme: `ORDER BY sync_changes.seq` (ya da sütunu `bigint`
   bırakıp metne JS'te çevirmek). Ajan bu bölgede tek sayfa (5000) ister,
   sığmazsa baştan yükler; merkez düzeltilince de zararsızdır.
2. **Gövde sınırı aşılınca 413 yerine 500**: Express'in varsayılan sınırı
   100 KB; aşan istekte `PayloadTooLargeError` genel hata süzgecinde
   (`all-exceptions.filter.ts`) 500 "Beklenmeyen bir hata oluştu" olur. 500
   geçici hata sayıldığı için sınırı aşan bir işlem sırayı sonsuza dek
   tıkayabilirdi. Ajan partileri ≈90 KB'ta böler, tek başına 100 KB'ı aşan
   işlemi göndermeden kişinin kararına bırakır (`chaos.test.ts`). Öneri: bu
   hatayı 413 döndürmek ve `/sync/push` için sınırı büyütmek (ör. 5 MB).
3. `docker-compose.replica.yml`'deki yorumlu `sync-agent` servisi yukarıdaki
   (Docker) biçimiyle açılabilir.
