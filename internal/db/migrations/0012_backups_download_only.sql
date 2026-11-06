-- Backups are now a download from the web page: no schedule, no "keep the last N" and no backup folder.
-- Forget the two settings that only the old scheduler used. (The history table stays: it shows who made
-- a backup and when.)
DELETE FROM settings WHERE key IN ('backup.interval_minutes', 'backup.keep');
