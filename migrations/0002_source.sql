-- Origine d'un relevé : 'auto' (message du compteur ou import) ou 'manual' (saisi dans le tableau de bord)
ALTER TABLE readings ADD COLUMN source TEXT NOT NULL DEFAULT 'auto';
