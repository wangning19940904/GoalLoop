ALTER TABLE goals ADD COLUMN activated_at timestamptz;
UPDATE goals SET activated_at=deadline_at-((spec->>'deadlineMs')||' milliseconds')::interval WHERE deadline_at IS NOT NULL;
ALTER TABLE runs ADD COLUMN error_code text;
