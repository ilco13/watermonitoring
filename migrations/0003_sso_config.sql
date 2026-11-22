-- Jetons de connexion unique déjà utilisés (usage unique, purgés une fois expirés)
CREATE TABLE IF NOT EXISTS sso_nonces (
  nonce TEXT    PRIMARY KEY,
  exp   INTEGER NOT NULL
) WITHOUT ROWID;

-- Réglages communs à tous les utilisateurs (seuils d'alerte, noms, variables), modifiables par le bureau
CREATE TABLE IF NOT EXISTS config (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
) WITHOUT ROWID;
