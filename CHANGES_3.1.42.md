# v3.1.42 — Wake trainer: stream PROGRESS events from augment/train substeps

After v3.1.41 fixed the synthetic-clip sample-rate mismatch,
the user re-trained and got a familiar symptom: phone stuck at
30% "Sending samples to desktop...", no further progress
events for 2-5 minutes, then a flurry of events all at once
when the augment substep finally exits.

**The bug:** `scripts/train_wake_phrase.py::_run_openwakeword_substep`
ran each openWakeWord substep via `subprocess.run(..., stdout=PIPE,
stderr=STDOUT)`. That buffers the ENTIRE subprocess stdout until
exit. PROGRESS:: events from inside the 2-5 minute
`--augment_clips` and `--train_model` substeps never reached
main.js while the subprocess was running. The phone saw nothing
between "Sending samples to desktop..." and the final
wake_training_result.

**The fix:** switch to `subprocess.Popen(...)` with a
background line-reader that streams each stdout line as it
arrives. Each line is forwarded to the parent as both the
prefixed `[train-OWW]` debug line AND as the raw PROGRESS::
event, so main.js's existing PROGRESS:: parser catches it
as soon as the subprocess prints it.

The augment substep is the slow one (~2-5 min on the 2070
for 24K clips × feature extraction). Tqdm's `\r`-terminated
progress bars are unaffected because we read line-by-line
in text mode and `\r` doesn't terminate a line — tqdm
still appears as part of the line until newline.

**Lesson:** `subprocess.run(stdout=PIPE)` is the wrong
shape for any subprocess that emits status events during
its run. Use Popen + a line iterator (or communicate() with
a generator) for any long-running step that needs to stream
progress. subprocess.run is fine for sub-second calls where
you only care about the exit code.

**Files:**

- `scripts/train_wake_phrase.py` — `_run_openwakeword_substep`
  switched from `subprocess.run` to `subprocess.Popen` +
  line-by-line forwarding.
- `package.json` — 3.1.41 → 3.1.42

**No mobile-side change required.** v3.2.7 already shows
the right progress bar given any PROGRESS:: events that
arrive.