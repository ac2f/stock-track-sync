# Değişiklik günlüğü

Sürümler [Semantic Versioning](https://semver.org/lang/tr/) izler.

## [1.0.0] - 2026-10-22

İlk sürüm (sözleşme: `stock-track` › `docs/SYNC.md`, protokol 1).

### Eklenenler
- İlk yükleme: boş yerel veritabanını merkezin anlık görüntüsünden sayfa
  sayfa doldurur; yarıda kalırsa bir sonraki turda baştan yapar.
- Gönderme: giden kutusu `seq` sırasıyla, ≤100 işlem ve ≈90 KB'lık
  partiler; `retry` gelince sıra korunur; ağ hatasında parti yeniden
  gönderilir (merkez `opId` ile tekrarı önler); 400'de suçlu işlem tek tek
  gönderilerek bulunur; 100 KB'ı aşan tek işlem kişinin kararına bırakılır.
- Geri alma (rebase) ve çekme, yerel yazmalar kısa süre duraklatılarak;
  bekleyen işlem varken yapılmaz. Sayfa sınırında eksik üst kayıt, silinen
  kaydı gösteren alt kayıt ve benzersizlik çakışmaları merkezden ilgili
  satırlar alınarak onarılır.
- 410 RESNAPSHOT ve merkez imlecinin gerilemesinde: önce gönder, sonra
  baştan yükle; giden kutusu korunur. `--resnapshot` ile elle.
- Merkezin `/sync/changes` metin sıralaması hatasına karşı önlem: 10'un
  kuvveti sınırında tek sayfa, sığmazsa baştan yükleme.
- Denetimler: şema özeti, merkez kimliği, protokol, saat farkı, merkezin
  veritabanına bağlanmayı ve ikinci ajan kopyasını önleme.
- `replica_state` durum ve nabız, `127.0.0.1` durum ucu (`/health`),
  dönen JSON günlükleri (7 gün, anahtar/parola maskeli), günlük bakım.
- Docker imajı, Windows kurulumu (`install.bat`, zamanlanmış görev),
  systemd birimi.
