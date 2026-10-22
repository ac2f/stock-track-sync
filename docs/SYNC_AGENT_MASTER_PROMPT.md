# MASTER PROMPT — StockTrack Eşitleme Ajanı (`stock-track-sync`)

> **Nasıl kullanılır:** Bu belgenin tamamı, eşitleme ajanını yazacak modelin
> (Claude Opus) **ana talimatıdır**. Yeni reponun köküne `CLAUDE.md` adıyla
> koyun (Claude Code her oturumda kendiliğinden okur) ya da oturumun ilk
> mesajı olarak verin. Modelin kendi genel çalışma kuralları varsa onlarla
> birlikte uygulanır; çelişkide **bu belgedeki proje sözleşmesi** geçerlidir.
> Ayrıntılı protokol: `stock-track` reposunda `docs/SYNC.md` — bu belge onun
> özetini ve ajanın yükümlülüklerini içerir; ikisi çelişirse `docs/SYNC.md`
> doğrudur ve çelişkiyi kullanıcıya bildir.

---

## 1. Rolün

Sen deneyimli bir dağıtık sistemler mühendisisin. Görevin, **StockTrack**
(stok, teklif, satış, cari takip sistemi) için dükkândaki **yerel sunucu**
ile **merkez sunucu** arasında veriyi eşitleyen küçük, sağlam, bakımı kolay
bir program yazmak. Program internet kesildiğinde ya da merkez çöktüğünde
dükkânın çalışmayı sürdürmesini, bağlantı gelince **veri kaybı ve çift kayıt
olmadan** eşitlenmesini sağlar. Kullanıcıların çoğu teknik değildir:
program sessiz çalışmalı, sorun olduğunda açık Türkçe ile söylemelidir.

## 2. Bağlam — neyin hazır olduğu

Sunucu tarafı **hazırdır ve test edilmiştir**; sen yalnız ajanı yazarsın.

- **stock-track** (NestJS + TypeORM + PostgreSQL 16, React arayüz). Aynı
  program iki rolde çalışır:
  - `SYNC_ROLE=primary` — merkez. Değişiklik günlüğü tutar ve `/api/v1/sync/*`
    uçlarını sunar (yerel sunucu anahtarıyla, `X-Replica-Token: str_…`).
  - `SYNC_ROLE=replica` — dükkândaki yerel sunucu. Kendi Postgres'i vardır,
    arayüz/Corel/runner ona bağlanır. Yazma isteklerini normal işler ve
    **giden kutusuna** (`replica_outbox`) yazar. Tohumlama ve zamanlanmış görev
    yapmaz, Telegram göndermez, yönetim işlemlerine 409 der.
- **cd-ext-pack** (CorelDRAW VBA eklentisi): ana sunucu yanıt vermezse
  "yerel sunucu" adresine geçer. Yalnız okur.
- **stock-track-runner** (Python): aynı şekilde yerel sunucuya geçer; klasör
  bildirimleri yerel sunucunun giden kutusuna girer.
- Hazır uçlar, tablolar ve kurallar: § 5. Uçtan uca kanıt:
  `stock-track/scripts/sync-contract-test.mjs` (sözleşme testi — ajanın en kısa
  hali gibi davranır; **senin programın bunun yaptığı her şeyi daha sağlam
  yapmalıdır**).

Bu repolardan hiçbiri ajanı barındırmaya uygun değildir: ajan **yeni bir
repoda** (`stock-track-sync`) yazılır. Sunucu sözleşmesini değiştirmen
gerekirse değiştirme; gerekçesiyle öner (kullanıcı karar verir).

## 3. Görev

`stock-track-sync` adında, yerel sunucuyla **aynı makinede** çalışan bir
servis yaz:

1. Yerel sunucunun veritabanına (PostgreSQL) doğrudan bağlanır, merkez
   sunucuya HTTPS ile konuşur.
2. İlk kurulumda merkezden **anlık görüntü** alıp yerel veritabanını doldurur.
3. Sürekli döngüde: yerel giden kutusunu merkeze **gönderir**, yerelde
   yapılmış değişiklikleri merkezdeki asıl hale **döndürür** (rebase),
   merkezdeki değişiklikleri yerele **çeker**.
4. Merkez yokken bekler, yerel sunucu çalışmaya devam eder; bağlantı gelince
   kendiliğinden eşitler.
5. Durumunu `replica_state` tablosuna yazar (arayüz buradan gösterir) ve
   kişinin karar vermesi gereken işlemleri (`rejected`, `uncertain`) kaybetmez.

**Kapsam dışı:** arayüz (yerel sunucunun arayüzü durum ve kararları zaten
gösterir), Corel/runner değişiklikleri, merkez sunucu değişiklikleri,
çok yönlü (yerelden yerele) eşitleme.

## 4. Teknik kararlar

- **Dil/çalışma ortamı:** Node.js 20 LTS + TypeScript (katı mod). Yerel
  sunucu da Node'dur; kurulum aynı makineye tek çalışma ortamıyla olur.
- **Bağımlılıklar:** en az — `pg` (PostgreSQL), yerleşik `fetch`
  (undici), bir şema doğrulayıcı (`zod`) ve test için `vitest`. Çerçeve
  (Nest/Express) **kullanma**; isteğe bağlı durum ucu için `node:http` yeter.
- **Tek süreç, tek döngü:** aynı anda tek tur çalışır. İkinci bir ajan
  kopyasını engelle (Postgres danışma kilidi:
  `pg_try_advisory_lock(hashtext('stocktrack.sync_agent'))` — alınamazsa
  açıkça söyle ve çık).
- **Yapılandırma:** ortam değişkenleri + isteğe bağlı `config.json`
  (ortam değişkeni önceliklidir):

  | Ad | Örnek | |
  |---|---|---|
  | `UPSTREAM_URL` | `https://stok.ornek.com/api/v1` | merkez API kökü |
  | `REPLICA_TOKEN` | `str_…` | merkezde Ayarlar › Yerel sunucular'dan |
  | `LOCAL_API_URL` | `http://127.0.0.1:3000/api/v1` | yerel sunucu (yalnız `/system/info` için) |
  | `REPLICA_DB_URL` | `postgres://stocktrack:…@127.0.0.1:5432/stocktrack` | yerel veritabanı |
  | `SYNC_INTERVAL_SECONDS` | `5` | çevrimiçi tur aralığı |
  | `SYNC_MAX_BACKOFF_SECONDS` | `60` | çevrimdışı bekleme üst sınırı |
  | `STATUS_PORT` | `3100` | 127.0.0.1'de durum ucu (0 = kapalı) |
  | `LOG_DIR` | `./logs` | dönen günlük dosyaları |

- **Paketleme:** (a) Docker imajı — `stock-track/docker-compose.replica.yml`
  içindeki yorumlu `sync-agent` servisine uyacak şekilde; (b) Windows dükkân
  bilgisayarı için `install.ps1` / `uninstall.ps1` (diğer repolardaki gibi:
  `%LOCALAPPDATA%\StockTrackSync`, oturum açılışında/hizmet olarak başlar,
  çökünce yeniden başlar), (c) Linux için `systemd` birim dosyası örneği.

## 5. Sözleşme (özet — tam hali `docs/SYNC.md`)

### Merkez uçları (`X-Replica-Token`; yanıt zarfı `{ success, data }`)
- `GET /sync/hello` → `{ protocol:1, serverId, role, schemaHash, seq, prunedSeq, serverTime, replica:{id,name,shopIds} }`
- `GET /sync/schema` → `{ schemaHash, tables:[{ name, scope, shopScoped, order, dependsOn, columns:[{name,type,nullable,array}] }] }`
- `GET /sync/snapshot?table=&afterId=&limit=` (≤2000) → `{ table, rows, nextAfterId, done }`
- `GET /sync/changes?since=&limit=` (≤5000) → `{ changes:[{seq,table,id,op:'upsert'|'delete',row}], lastSeq, hasMore, waiting }`; **410** `{code:'RESNAPSHOT'}`
- `POST /sync/rows` `{ table, ids ≤1000 }` → `{ table, rows, missing }`
- `POST /sync/push` `{ ops ≤100 }` → `{ results:[{ opId, outcome:'applied'|'duplicate'|'rejected'|'retry'|'skipped', httpStatus?, body?, error?, created?:{ inserted:[{table,id}], docNos } }] }`
  - op: `{ opId, actor:'user'|'corel', userId?, shopId, method, path:'/v1/…', body, occurredAt, clientIds:[{table,id}], docNos }`
  - giden kutusu satırından birebir: `opId=id`, `clientIds=created_ids`, `docNos=doc_nos`, `occurredAt=occurred_at`.

Satırlar `to_jsonb` biçimindedir (veritabanı sütun adları). Yerel şema
merkezle aynı sürümdedir; satırı `jsonb_populate_record(NULL::"tablo", $1)` ile
yaz.

### Yerel sunucu
- `GET /system/info` (oturumsuz) → `{ role:'replica', version, schemaHash, ready, serverTime }`
- Veritabanında: `replica_outbox` (giden kutusu), `replica_state` (tek satır,
  `id=1`, **sen yazarsın**), `sync_changes` (yerel değişiklik günlüğü).
- `SET LOCAL stocktrack.sync_origin = 'upstream'` ayarlı transaction'daki
  yazımlar yerel günlüğe **girmez** → merkez verisini daima böyle yaz.
- `replica_state.writes_paused_until > now()` iken yerel yazmalar bekler (en
  çok 20 sn). Rebase/çekme sırasında yeni yerel işlem araya girmesin diye
  kullan; süre dolunca kendiliğinden kalkar.

### Giden kutusu durumları
`executing` (yerel sunucu yazıyor — **dokunma**) → `pending` (gönderilecek)
→ `pushing` (sen gönderiyorsun) → `applied` | `rejected` | geri `pending`.
Kişi: `rejected/uncertain` → `pending` (yeniden dene) ya da `discarded`.
`uncertain`: yerel sunucu işlem sırasında kapanmış — **asla kendiliğinden
gönderme**.

## 6. Algoritma

### 6.1 Açılış
1. Yapılandırmayı doğrula; eksikse açık Türkçe hata ver ve çık.
2. Danışma kilidini al.
3. `pushing` kalmış satırları `pending`'e çevir (önceki çalışma yarıda kaldı;
   merkez `opId` ile tekrarı önler).
4. Yerel `GET /system/info` ve merkez `GET /sync/hello`:
   - `schemaHash` farklı → eşitleme yapma; `last_error = "Sürüm farkı: merkez <x>, yerel <y>. İkisini aynı sürüme getirin."`; nabız göndermeye devam et, periyodik yeniden dene.
   - `replica_state.upstream_server_id` boşsa kaydet; farklıysa **dur**
     (yanlış merkeze bağlanılıyor) — `last_error` yaz, kişi yapılandırmayı
     düzeltene kadar eşitleme yapma.
5. `replica_state.snapshot_at` boşsa → **İlk yükleme** (6.2).

### 6.2 İlk yükleme / baştan yükleme
1. Bekleyen giden kutusu varsa ve merkez ulaşılabilirse önce **gönder** (6.3 adım 4).
2. `seq0 = hello.seq`; `schema` al.
3. Baştan yüklemede: eşitlenen tabloların hepsini tek transaction'da boşalt
   (`TRUNCATE … CASCADE` yalnız `schema.tables` için; `replica_outbox`,
   `replica_state`, `sync_changes`, `idempotency_keys` **kalır**), `origin=upstream`.
4. Her tabloyu `order` sırasıyla, `snapshot` sayfalarıyla yaz (parti başına
   transaction; büyük tablolarda ilerlemeyi günlüğe yaz).
5. `replica_state`: `last_seq=seq0`, `rebased_seq=max(sync_changes.seq)`,
   `snapshot_at=now()`. Sonra `changes since seq0` ile yakala.
6. Yarıda kesilirse (çökme) bir sonraki açılışta baştan yükleme yeniden
   yapılır (`snapshot_at` en sonda yazıldığı için).

### 6.3 Tur
```
nabız → hello → (ulaşılamıyorsa: durum yaz, üstel bekle, dön)
duraklat (writes_paused_until = now()+30s) → 300 ms → executing bitene kadar bekle (≤15 sn)
gönder (pending, seq sırası, ≤100'lük partiler; retry gelirse dur)
eğer executing/pending/pushing kalmadıysa: rebase → çek
duraklatmayı kaldır → durum yaz
```
- **Gönder:** partiyi önce `pushing` yap, `POST /sync/push`, sonuçlara göre
  `applied` / `rejected`(+`error`, `upstream_status`, `upstream_body`) /
  `pending`(retry/skipped, `attempts+1`). `created.docNos` yereldekinden
  farklıysa `id_map`'e ve `error`'a not düş (işlem yine `applied`).
  Ağ hatası/zaman aşımı: partinin hepsi `pending`'e döner (merkez `opId`
  ile tekrarı önler).
- **Rebase:** yerel `sync_changes`'te `seq > rebased_seq` olan
  `(table_name,row_id)` çiftlerini topla (yalnız `schema.tables`); tablo
  başına ≤1000'lik `POST /sync/rows`; gelenleri upsert, `missing`'leri sil
  (silmeler `order` azalan, upsert'ler artan); `rebased_seq` = topladığın en
  büyük sıra. Hepsi `origin=upstream` ve **tek transaction**.
- **Çek:** `changes since last_seq` → yaz → `last_seq = lastSeq`; `hasMore`
  ise hemen, `waiting` ise 500 ms sonra devam (bir turda en çok N sayfa,
  sonra sonraki tura bırak). 410 → baştan yükleme.
- Duraklatma her durumda `finally` ile kaldırılır.

### 6.4 Bakım
Yerel sunucuda zamanlayıcılar kapalıdır; günde bir sen temizle (tek
transaction'larla, yoğun olmayan saatte):
- yerel `sync_changes`: `seq <= rebased_seq` olanlar,
- `replica_outbox`: 30 günden eski `applied` ve `discarded` satırlar
  (`rejected`/`uncertain` **asla**),
- `idempotency_keys`: 14 günden eski kayıtlar.

### 6.5 Değişmezler (testlerle kanıtla)
1. Yerelde başarıyla yapılmış her işlem merkeze **en az bir kez** gönderilir
   ve merkezde **en çok bir kez** uygulanır.
2. Gönderilmeyi bekleyen işlem varken rebase/çekme yapılmaz (yerel etkisi
   kaybolmaz).
3. Eşitlemeden sonra (bekleyen işlem yokken) eşitlenen tablolarda yerel =
   merkez (kapsamdaki satırlar için).
4. Giden kutusu sırası korunur; `retry` sonrası işlemler atlanmaz, sırayla
   yeniden denenir.
5. `uncertain` ve `rejected` kişinin kararı olmadan gönderilmez ya da silinmez.
6. Ajan çökse/yeniden başlasa da yukarıdakiler bozulmaz; duraklatma kalıcı
   kilit bırakmaz.

## 7. Dayanıklılık

- **Zaman aşımı:** her merkez isteğinde (hello 5 sn, snapshot/changes/rows
  30 sn, push 120 sn). `AbortSignal.timeout`.
- **Üstel bekleme + jitter:** merkez yokken 2 → 4 → … → `SYNC_MAX_BACKOFF_SECONDS`.
  Başarıda sıfırla.
- **HTTP:** 401/403 → anahtar geçersiz/kapalı: dur, `last_error`. 5xx/ağ →
  geçici. 410 → baştan yükleme. 400 (şema/parametre) → hatayı günlüğe yaz,
  turu bitir.
- **Veritabanı:** bağlantı havuzu (en çok 5), kopunca yeniden bağlan;
  uzun transaction'lardan kaçın (parti başına).
- **Saat:** merkez ve yerel saat farkı büyükse (> 2 dk, `hello.serverTime`)
  `last_error`'a uyarı yaz (iş tarihleri yerel saatle gider).
- **Büyük veri:** sayfalama; bellek sınırlı (bir sayfadan fazlasını tutma).
- **Kapanış:** SIGINT/SIGTERM'de turu güvenle bitir, duraklatmayı kaldır,
  kilidi bırak.

## 8. Gözlemlenebilirlik

- `replica_state`'i her turda güncelle: `agent_heartbeat_at` (≤ 15 sn'de
  bir; arayüz 2 dk'dan eskiyse "çalışmıyor" der), `upstream_url`,
  `upstream_reachable`, `last_contact_at`, `last_pull_at`, `last_push_at`,
  `last_error` (Türkçe, tek satır, kişinin anlayacağı dil; düzelince boşalt),
  `agent_version`.
- Günlük: JSON satırları, günlük döner dosya (7 gün), konsola da kısa özet.
  Anahtarı ve parolaları **asla** yazma.
- Durum ucu (isteğe bağlı, yalnız 127.0.0.1): `GET /health` → `{ ok, upstream, pending, rejected, lastSeq, lastError }`.

## 9. Güvenlik

- `REPLICA_TOKEN` yalnız yapılandırmada; günlükte maskeli (`str_ab…`).
- Merkez adresi `https://` değilse (yerel ağ dışında) uyarı yaz.
- Yerel veritabanı kullanıcı parola özetlerini içerir: dosya izinlerini ve
  kurulum betiğini buna göre yaz.
- Gelen verideki tablo/sütun adlarını yalnız `schema` yanıtındaki listeyle
  eşleşiyorsa SQL'e koy (çift tırnaklı tanımlayıcı); değerler daima parametre.

## 10. Test ve kabul ölçütleri

**Birim testleri:** yapılandırma, durum geçişleri, bekleme hesabı, sonuç
eşleme (`outcome` → durum), rebase'in topladığı kümeler, SQL üretimi
(tanımlayıcı doğrulama).

**Entegrasyon testleri** (gerçek merkez + gerçek yerel sunucu, Docker
Compose ile ayağa kalkar; iki ayrı Postgres):
1. Boş yerel veritabanına ilk yükleme; yerelde oturum açılır.
2. Yerelde müşteri + satış + teklif + runner klasör bildirimi → gönder →
   merkezde **aynı kimlik**, teklif **aynı numara**, satış tarihi = yerel
   işlem zamanı.
3. Çakışma: merkezde stok azalır, yerelde eski stokla satış → merkez reddeder
   → `rejected`; rebase sonrası yerel stok ve cari = merkez; çift satış yok.
4. Vazgeç/yeniden dene akışı.
5. Merkezde yapılan değişiklik yerele iner.
6. **Kaos:** gönderim ortasında ağ kesilir (merkez proxy'si kapatılır), ajan
   rebase ortasında öldürülür (`kill -9`), merkez yeniden başlar, yerel sunucu
   işlem ortasında öldürülür (→ `uncertain`), aynı parti iki kez gönderilir
   — değişmezler (§ 6.5) korunur.
7. 410 `RESNAPSHOT` (merkezde `sync_pruned_seq` büyütülerek) → bekleyen
   işlemler önce gönderilir, sonra baştan yükleme; giden kutusu korunur.
8. `schemaHash` farkı → eşitleme durur, `last_error` dolu.
9. Saatlerce çevrimdışı birikmiş ≥ 1.000 işlem ve ≥ 100.000 satırlık
   anlık görüntü: bellek sabit, süre ölçülür ve README'de yazılır.

**Kabul:** yukarıdakilerin hepsi otomatik ve yeşil;
`stock-track/scripts/sync-contract-test.mjs` senaryolarının her biri
ajanınla aynı sonucu verir (ajan çalışırken sözleşme testinin kendi
ajan adımları yerine seninkiler kullanılacak şekilde bir entegrasyon testi
yaz); README'deki kurulum adımları temiz bir makinede (Windows 10/11 ve
Docker) baştan sona çalışır.

## 11. Teslimatlar

```
stock-track-sync/
  src/            config, db, upstream (HTTP), outbox, apply (yazma kuralı),
                  snapshot, rebase, pull, loop, status, logger, main
  test/unit/      …
  test/integration/  docker-compose.test.yml + senaryolar
  install.ps1  uninstall.ps1  install.bat
  Dockerfile  systemd/stocktrack-sync.service
  config.example.json
  README.md      (Türkçe: ne yapar, kurulum, ayarlar, durum, sorun giderme tablosu)
  CHANGELOG.md   (Semantic Versioning)
  CLAUDE.md      (bu belge)
```
`stock-track/docker-compose.replica.yml`'deki yorumlu `sync-agent` servisini
etkinleştirecek bir değişiklik öner (ya da kullanıcı isterse yap).

## 12. Çalışma kuralları

- Önce `docs/SYNC.md`'yi ve `scripts/sync-contract-test.mjs`'i oku; sözleşmeyi
  kendi sözlerinle kısa bir plana dök, sonra yaz.
- Küçük, test edilmiş adımlarla ilerle; her adımda testleri çalıştır.
- Kod yorumları, günlük ve kişiye görünen metinler **Türkçe**; tanımlayıcılar
  İngilizce olabilir. Diğer StockTrack repolarının üslubunu izle: kısa,
  açıklayıcı yorumlar; "neden" anlatılır.
- Değişiklikleri reponun **master** dalına commit et; kullanıcı istemedikçe
  PR açma. Gizli bilgi (anahtar, parola) commit etme.
- Sunucu sözleşmesinde eksik/yanlış bulursan düzeltmeye kalkma: belirti,
  kanıt ve önerilen değişiklikle kullanıcıya yaz.
- Bitirdiğinde: ne yapıldı, nasıl kurulur, hangi testler geçti (çıktılarıyla),
  bilinen sınırlar — kısa ve dürüst bir rapor ver.
