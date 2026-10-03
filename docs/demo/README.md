# Audit demo GIFs

These GIFs replay observed phases from a real `jankurai audit --full --mode standard`
against an authored sample repository. The measured PASS/FAIL and score are never
substituted. This is a terminal-style rendering of recorded events, not a screen
recording or an audit of this hub checkout.

| File | Role | Geometry |
| --- | --- | --- |
| [audit-readme.gif](audit-readme.gif) | README preview | 960×540 |
| [audit-1080p.gif](audit-1080p.gif) | Full-resolution recording | 1920×1080 |
| [audit-demo.json](audit-demo.json) | Palette, hashes, timing and outcome | — |

Public paths are `docs/demo/audit-readme.gif` and `docs/demo/audit-1080p.gif`.
Both use an exact 16-color palette without dithering or dimming and remain smaller
than 50,000,000 bytes. Native 16/32/64px glyph faces avoid bitmap upscaling.

## Verify and rebuild

The normal integration lane builds its selected auditor, generates a real sample,
and verifies both the fresh render with its complete capture and the committed catalog. Public `npm run demo:verify`,
`just demo` and fast CI use the independent Node LZW decoder to compare every decoded
RGB hash and duration. They need no Python runtime and never write into the catalog.
The decoder supports the producer's full-frame, noninterlaced, fixed-palette format;
unsupported offsets/interlace, malformed/truncated data and excessive decoded sizes
fail explicitly instead of being interpreted as a different displayed image.

Normal integration also cross-checks both GIFs with a separately implemented,
hash-pinned Pillow 12.3.0 decoder and runs eight negative/positive controls. This
second implementation guards pixel fidelity independently of the Node decoder.

```sh
node scripts/demo/generate-demo.mjs "$PWD/.fusion/target/debug/jankurai" "$PWD/target/audit-demo"
node scripts/demo/verify-audit-gif.mjs "$PWD/target/audit-demo/rendered"
node scripts/demo/publish-demo.mjs "$PWD/target/audit-demo/rendered" "$PWD/docs/demo"
npm run demo:verify
```

Generation records wherever the producer ran, so it rewrites the capture's
absolute auditor, sample and output paths to `/jankurai-audit-demo` placeholders
before rendering (`scripts/demo/redact-capture.mjs`, also runnable on a published
catalog). Rendering displays only `basename(repository)`, so no pixel changes;
every digest that binds the capture is recomputed, and an absolute path the
redaction map does not cover fails generation instead of being published.

Generation requires an explicit absolute auditor path and a new output directory.
It creates an intentionally incomplete sample, captures the process and fresh
report, renders both GIFs, and independently decodes their pixels. There is no
auditor PATH fallback, synthetic score, badge fallback or producer-side delay.
An explicitly expected sample FAIL stays FAIL; missing execution, malformed data,
unexpected process failure or contradictory policy outcomes fail generation.

CI writes only under `target/audit-demo/` and uploads the result. The publisher is
an explicit local catalog refresh; normal CI never rewrites tracked previews.
It requires the matching `recording/` sibling containing the raw report, recording,
stdout/stderr, authored input inventory and validated producer state. It verifies
that complete capture in exclusive staging, rechecks source and destination
identities, and installs all nine public files. Existing README and unrelated
files survive. Predictable old `.publishing` paths are never opened or removed.

Publication retains a durable journal with before-images, verified candidate bytes
and original destination files. Interruption can leave a mixed local catalog;
its operation lock and journal remain for manual reviewed recovery. Future
publication refuses that existing lock. This is not atomic catalog visibility or
automatic rollback. Inspect the journal and preserve unknown edits before recovery;
never clear a lock or restore old files blindly. Successful publication also
retains its journal and before-images, reporting their path for review.

## Timeline and capture

Playback follows actual observed timestamps rounded to GIF's 10ms ticks. Between
phases, a 10fps elapsed clock and activity spinner update without inventing phase
completion, percentages or file counts. Long recordings cap clock updates at 300;
the manifest discloses that interval and a 2-second final hold. A fixed recording
renders identical bytes. Fresh executions naturally have different timing and IDs.

A full check accepts either the complete flat catalog or the generator’s `rendered/`
with its exact `recording/` sibling. Partial flat captures, arbitrary sibling
layouts and redirected evidence files/directories fail without fallback.

The GIFs accompany exact `audit-recording.json`, `report.json`, `stdout.txt`,
`stderr.txt`, `sample-inputs.json` and `producer-audit-state.json`. Verification
binds their digests and outcomes to the manifest. This is presentation consistency,
not opaque supervised evidence for `jankurai ci run` or release qualification.

The authored sample is removed only after its full input inventory is verified
unchanged. The released auditor also writes `target/jankurai/audit-state.json`
even with `--full --no-score-history`, with no supported redirect/disable flag.
Generation validates this exact bounded regular output against its reviewed writer
schema, report/binary identity and execution window, preserves the bytes outside
the sample and lists it separately. Other files/directories, links or changed
inputs refuse cleanup and remain preserved.

The committed Jankurai Audit Mono atlas derives from DejaVu Sans Mono and retains
its complete notice in `scripts/demo/FONT-LICENSE.txt`. The exact source font hash
is in `audit-mono.json`; `generate-audit-font.py` reproduces the native glyphs using
Pillow 12.3.0 and that font. Normal rendering requires no font download or npm
rendering package. Synthetic tests are explicitly labeled and never become README
audit recordings.
