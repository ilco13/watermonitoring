-- Alertes déjà signalées par mail au bureau (une ligne par compteur et par règle, tant que l'alerte dure)
CREATE TABLE IF NOT EXISTS alert_state (
  key          TEXT    PRIMARY KEY,          -- « variable|règle », par exemple index_eau_2|quiet
  level        TEXT    NOT NULL,
  meter        TEXT    NOT NULL,             -- nom du compteur, pour le mail de rétablissement
  text         TEXT    NOT NULL,             -- dernier texte de l'alerte
  first_at     INTEGER NOT NULL,             -- première annonce (ms)
  last_sent_at INTEGER NOT NULL,             -- dernier mail (annonce ou rappel)
  sent_count   INTEGER NOT NULL DEFAULT 1,
  clear_runs   INTEGER NOT NULL DEFAULT 0    -- contrôles de suite où l'alerte n'était plus là
) WITHOUT ROWID;
