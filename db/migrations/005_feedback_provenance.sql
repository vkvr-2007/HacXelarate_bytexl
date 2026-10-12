-- Phase 4: know where every training label came from, so demo and unknown rows can be kept out of training.
ALTER TABLE ml_feedback ADD COLUMN IF NOT EXISTS mode TEXT CHECK (mode IN ('live', 'demo'));
ALTER TABLE ml_feedback ADD COLUMN IF NOT EXISTS decision TEXT CHECK (decision IN ('confirmed', 'false_positive', 'official'));
ALTER TABLE ml_feedback ADD COLUMN IF NOT EXISTS reviewer_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

-- Existing rows keep their data; their origin is recovered from the finding when it still exists, otherwise left unknown (NULL),
-- and rows with an unknown origin are never used for training.
UPDATE ml_feedback f SET mode = x.mode,
  decision = CASE WHEN f.label = 1 THEN 'confirmed' WHEN x.status = 'official' THEN 'official' ELSE 'false_positive' END
FROM findings x WHERE x.id = f.finding_id AND f.mode IS NULL;
