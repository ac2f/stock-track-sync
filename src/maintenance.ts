import { tx, type Db } from './db.js';

export interface MaintenanceSummary {
  changes: number;
  outbox: number;
  idempotency: number;
}

/**
 * Günlük bakım (docs/SYNC.md § 7 Bakım): yerel sunucuda zamanlayıcılar kapalı
 * olduğu için ajanın işi. Her adım kendi kısa transaction'ında.
 *  - yerel günlük: geri alınmış (rebase) satırlar,
 *  - giden kutusu: 30 günden eski uygulanmış/vazgeçilmiş işlemler
 *    (reddedilen ve belirsiz olanlara ASLA dokunulmaz — kişinin kararı),
 *  - tekrar koruması: 14 günden eski kayıtlar.
 */
export async function maintain(db: Db): Promise<MaintenanceSummary> {
  const changes = await tx(db, (c) =>
    c.query(
      `DELETE FROM sync_changes
        WHERE seq <= (SELECT COALESCE(rebased_seq, 0) FROM replica_state WHERE id = 1)`,
    ),
  );
  const outbox = await tx(db, (c) =>
    c.query(
      `DELETE FROM replica_outbox
        WHERE state IN ('applied', 'discarded') AND updated_at < now() - interval '30 days'`,
    ),
  );
  const idempotency = await tx(db, (c) =>
    c.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '14 days'`),
  );
  return {
    changes: changes.rowCount ?? 0,
    outbox: outbox.rowCount ?? 0,
    idempotency: idempotency.rowCount ?? 0,
  };
}
