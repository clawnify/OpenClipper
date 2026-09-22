# OpenClipper — agent guide

This app turns **long videos into short vertical clips** (9:16, for YouTube
Shorts, Reels and TikTok). A user adds a long video — a podcast, tutorial or
talk, up to 30 GB and 4 hours — and OpenClipper watches and listens to the
whole video, picks the strongest self-contained moments (a sound demo or a
striking picture can carry one, not only speech), cuts them without splitting
a word, lays each one out for vertical and burns in captions.

Base URL: this app's own origin. All endpoints are under `/api`.

## Applying the deploy answers

- **brand_name** — nothing to wire; it's how the user refers to their channel.
- **content** and **audience** — combine them into one or two sentences and set
  `DEFAULT_BRIEF` in `src/client/source.tsx` (for example: *"Music producers on
  YouTube Shorts. Favour quick wins with an audible before/after; skip the
  product pitch."*). The brief pre-fills the "Who are the clips for?" box on
  every video, and it steers which moments the model picks.

## The flow

1. **Add a video.** `POST /api/sources/upload { name, size, language? }` returns
   `{ source, upload_url }`: a one-time resumable (tus) URL the file is sent to
   directly — the bytes never pass through this app. Or `POST
   /api/sources/import { url, name?, language? }` with a direct https link to
   the file; the media service fetches it.
2. **Wait until ready.** Poll `GET /api/sources/{id}` (every ~5 s). `status`
   goes `uploading → processing → preparing → ready` (or `failed`, with
   `error`). Preparing = transcribing and getting the video ready to be
   watched; a 2-hour video takes 10–25 minutes. A video with no sound gets no
   transcript but still gets clips.
3. **Find clips.** `POST /api/sources/{id}/find { brief?, max_clips?,
   clip_length? }` — `max_clips` is a ceiling (1–50; default about one per
   three minutes of video), `clip_length` is `short` (<30 s), `standard`
   (30–60 s, default) or `long` (60–90 s). Answers `202 { run }` at once: the
   whole video is watched in one pass, which takes a few minutes. Poll `GET
   /api/sources/{id}` until `run.status` is `done` (the clips are there,
   strongest first) or `failed` (`run.error`). It may return fewer clips than
   asked — that is the quality floor working, not an error. `run.notes` says
   what it found.
4. **Review.** `PATCH /api/clips/{id}` with any of `{ start_s, end_s, title,
   captions, show_title, rejected }`. Moving the window resets the clip's
   layout; any change to a rendered clip marks it for re-rendering.
5. **Render.** `POST /api/clips/{id}/render` → `202` with the clip in
   `rendering`. Each clip already knows how it is shot (a person fills the
   frame → a 9:16 crop around them; a screen → the whole frame over a blurred
   copy), and the layout switches at the cut when the shot changes mid-clip.
   Renders run on the platform one at a time per workspace and survive the
   caller going away: poll `GET /api/sources/{id}` until the clip is
   `rendered` (with `file_url`) or `failed`. Submit as many as you like.
6. **Download.** `GET {file_url}?download=1`.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sources` | List videos (with clip counts) |
| POST | `/api/sources/upload` | Start a browser upload → `{ source, upload_url }` |
| POST | `/api/sources/import` | Import from an https link → `{ source }` |
| GET | `/api/sources/{id}` | One video + its clips + latest run (advances processing) |
| PATCH | `/api/sources/{id}` | Rename `{ name }` |
| DELETE | `/api/sources/{id}` | Delete the video, its clips and their files |
| GET | `/api/sources/{id}/playback` | Signed HLS + thumbnail (`{time}` → seconds) URLs |
| POST | `/api/sources/{id}/find` | Start finding moments → `202 { run }` |
| PATCH | `/api/clips/{id}` | Trim, retitle, toggle captions/title, drop or restore |
| POST | `/api/clips/{id}/analyze` | Re-read how the clip is shot (after a big trim) |
| POST | `/api/clips/{id}/render` | Start rendering to MP4 → `202`, the clip |
| GET | `/api/clips/{id}/file` | The MP4 (`?download=1` to download) |

Errors are JSON `{ error, detail }`; show `detail` to the user as-is.

## Limits worth knowing

- Clips run 6–95 seconds after trimming; finding aims at the chosen length.
- Captions come from the transcript, in the language chosen at upload (12
  languages: en, es, fr, de, it, pt, nl, pl, cs, ru, ja, ko).
- A workspace holds up to 50 hours of source video; delete old videos to add more.
