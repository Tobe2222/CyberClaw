# v3.1.43 — Wake trainer: fine-grained PROGRESS events from augment/train substeps

After v3.1.42 streamed the subprocess stdout, the user could
see the tqdm bars in the desktop log, but the phone still
saw no PROGRESS:: events during the 2-10 minute augment and
5-minute DNN training substeps. Result: the bar still froze
at 30% "Sending samples to desktop..." for the full 15
minutes, then jumped to the next stage in one step.

**Root cause:** the `train_wake_phrase.py` parent only emits
PROGRESS:: events at stage boundaries
(`emit_progress("augmenting", 55, ...)` before, `emit_progress("augmenting", 70, ...)` after). The 2-10 minutes of
"Computing features" inside the augment subprocess never
reach the parent as PROGRESS:: — only as tqdm bars on the
subprocess's stdout.

**Fix:** `_run_openwakeword_substep` now takes three new
optional parameters:

- `progress_stage` — the stage name to emit
  (e.g. "augmenting", "training")
- `progress_pct_range` — a `(low, high)` tuple. Inner tqdm
  percentage 0-100 maps linearly to this range, so the
  augmenting substep fills 55%→70% and the training substep
  fills 75%→88% of the phone bar
- `progress_label` — a short label for the message
  ("Augmenting + features", "Training DNN on cuda:0")

For each subprocess stdout line, the function regex-extracts
the tqdm percentage and re-emits a PROGRESS:: event. Events
are throttled to whole-percent deltas to keep the WebSocket
load sane (multiple tqdm bars run concurrently during
augment; without throttling we'd send 60+ events/sec).

The result: the phone bar now moves smoothly from 55%→70%
during the 10-minute augment substep, and from 75%→88%
during the 5-minute training substep. The user sees
continuous feedback instead of a frozen bar.

**Also addressed the "no logging" complaint** (Tobe's words):
the status message now includes the inner percentage, so the
phone shows e.g. "Augmenting + features (52% complete)" in
addition to the bar moving. The user can read the status text
even if the bar isn't moving for some reason.

**Files:**

- `scripts/train_wake_phrase.py` — `_run_openwakeword_substep`
  accepts progress_stage / progress_pct_range / progress_label;
  call sites for the augmenting and training substeps pass them
  in.
- `package.json` — 3.1.42 → 3.1.43

**No mobile-side change required.** The trainer already maps
`stage='augmenting'` and `stage='training'` to the right
labels and progress bar fill.
