# OpenClipper

[![Deploy with Clawnify](https://app.clawnify.com/deploy-button.svg)](https://app.clawnify.com/deploy?repo=clawnify/OpenClipper)

Turn a long video into short vertical clips. Add a podcast, tutorial or talk (hours long, up to 30 GB) and OpenClipper finds the strongest moments, cuts them on clean sentence boundaries, lays each one out for 9:16 and burns in captions. Every clip is yours to trim, retitle, drop or re-render.

## Why

Clipping tools score clips with a "virality" number and meter you by the credit. The part that actually costs a team days is simpler and more honest: find the moments that stand on their own, start each on its hook, end it on a finished thought, and frame it for a phone. OpenClipper does that, shows you why it picked each moment, and leaves the final call to you.

## Features

- **Long videos, any size**: resumable uploads straight from the browser (up to 30 GB and 4 hours) or import from a link. The source never passes through the app, and a clip only reads its own seconds of it.
- **Whole-video judgment**: the model reads the entire timed transcript at once, so the picks are the strongest in the video rather than the first good ones, and never two clips of the same idea. It returns fewer clips when the video doesn't have enough strong moments.
- **Clean cuts**: every clip is snapped to where speech starts and stops, so nothing opens or closes mid-word.
- **Layout per shot**: a person filling the frame gets a 9:16 crop around them; a screen recording or slides stays whole, centred over a blurred copy of itself. When the shot changes mid-clip, the layout switches at the cut.
- **Captions and titles**: burned-in captions from the transcript, one line at a time, and an on-screen title for the first seconds. Both can be switched off per clip.
- **Review, then render**: trim in half-second steps, retitle, drop or restore, render one clip or all of them, download.
- **Agent-ready**: a REST API and an `agent.md`, so an AI agent can take a video from upload to finished clips without a human in the loop.

## How it works

1. The video is uploaded to the platform's media service, which transcodes it and transcribes it.
2. `google/gemini-3.8-flash` reads the whole timed transcript and proposes moments, with a title, the hook line and one sentence on why each works.
3. Each moment is snapped to the transcript's speech boundaries.
4. Frames sampled through each clip tell the model where a person fills the shot and where a screen does.
5. The clip is rendered to a 1080×1920 MP4 on the managed edit service and stored in the app.

## Run it locally

```bash
pnpm install
pnpm dev
```

`pnpm dev` runs `clawnify dev`, which generates the local Worker config in `.clawnify/`, creates a local database from `schema.sql`, and serves the app at `http://localhost:5173`.

The media and render services need an org token, and finding clips needs an OpenRouter key. Put both in `.clawnify/.dev.vars`, next to the generated config (that is where the local server reads them), then restart `pnpm dev`:

```bash
printf 'CLAWNIFY_TOKEN=clw_...\nOPENROUTER_API_KEY=sk-or-...\n' > .clawnify/.dev.vars
```

`pnpm test` runs the unit tests for the transcript, layout and edit logic.

## License

MIT
