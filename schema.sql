-- OpenClipper: long videos in, short vertical clips out.
--
-- Ids are UUIDs (v4-shaped) so rows are safe to reference from anywhere.

-- A long source video. The file itself lives on the platform's media service
-- (Cloudflare Stream, via services.clawnify.com/media): uploads can be tens of
-- gigabytes and hours long, and clips are cut from it by range reads, so the
-- source never passes through this app.
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY DEFAULT (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6)))
  ),
  name TEXT NOT NULL,
  -- The media service's id for the video.
  media_id TEXT NOT NULL UNIQUE,
  -- uploading → processing → preparing (download + transcript) → ready | failed
  status TEXT NOT NULL DEFAULT 'uploading',
  progress REAL,
  error TEXT,
  duration REAL,
  width INTEGER,
  height INTEGER,
  -- Spoken language of the video (captions are generated in it).
  language TEXT NOT NULL DEFAULT 'en',
  -- The timed transcript (WebVTT), cached once the media service has it.
  transcript TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One "find clips" pass over a source. The brief anchors the model: a moment is
-- only strong relative to an audience and a goal.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY DEFAULT (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6)))
  ),
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  brief TEXT NOT NULL DEFAULT '',
  max_clips INTEGER NOT NULL DEFAULT 25,
  -- short (<30 s) | standard (30–60 s) | long (60–90 s)
  clip_length TEXT NOT NULL DEFAULT 'standard',
  model TEXT NOT NULL,
  -- The model's own note on what it found (and why there may be fewer clips).
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A proposed or rendered clip: a window of the source plus how to lay it out.
CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY DEFAULT (
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
    lower(hex(randomblob(6)))
  ),
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  -- Model's order of strength within the run (1 = strongest).
  rank INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  -- The opening line that stops the scroll, as spoken in the clip.
  hook TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  -- Window on the source, seconds.
  start_s REAL NOT NULL,
  end_s REAL NOT NULL,
  -- JSON: [{ from, to, layout, subject_x?, frame? }] relative to start_s.
  -- layout: speaker (face fills the frame) | screen (16:9 frame over a blurred
  -- copy of itself). Null until the frames are analysed.
  layout TEXT,
  captions INTEGER NOT NULL DEFAULT 1,
  show_title INTEGER NOT NULL DEFAULT 1,
  -- proposed → analysing → rendering → saving → rendered | failed;
  -- rejected = dropped.
  status TEXT NOT NULL DEFAULT 'proposed',
  error TEXT,
  -- The platform render job producing this clip. Renders run on the server
  -- and outlive any page: the clip advances when it is next read.
  render_job_id TEXT,
  output_key TEXT,
  output_size INTEGER,
  rendered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_clips_source ON clips(source_id, rank);
CREATE INDEX IF NOT EXISTS idx_runs_source ON runs(source_id, created_at);
