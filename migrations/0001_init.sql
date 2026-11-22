-- Index relevés : une ligne par variable et par instant (les doublons de rejeu Live Objects sont ignorés)
CREATE TABLE IF NOT EXISTS readings (
  variable TEXT    NOT NULL,
  ts       INTEGER NOT NULL,   -- millisecondes depuis 1970 (UTC)
  value    REAL    NOT NULL,
  PRIMARY KEY (variable, ts)
) WITHOUT ROWID;

-- Derniers messages reçus, tels quels, pour comprendre ce qui arrive (purgés au-delà de 200)
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL,
  stored      INTEGER NOT NULL,   -- nombre de mesures retenues
  ignored     INTEGER NOT NULL,
  raw         TEXT    NOT NULL
);
