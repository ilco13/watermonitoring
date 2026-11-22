-- Clés de réception Live Objects générées depuis le tableau de bord. On ne garde que l'empreinte SHA-256 :
-- la clé elle-même n'est affichée qu'une seule fois, à sa création.
CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash     TEXT    NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  created_by   TEXT,
  expires_at   INTEGER,          -- NULL = clé en vigueur ; sinon fin de validité (24 h après le remplacement)
  last_used_at INTEGER
);
