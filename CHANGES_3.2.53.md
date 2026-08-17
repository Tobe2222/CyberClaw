# v3.2.53 — debug logging for HTTP chat path

## 1. Why

**the user's report (2026-08-02 22:25):**
> "he claims to still not see the images. And then i tried
> again with a single picture but that did not show after i
> sent it, in the bubble. I then tried sending one without
> text at all but it would not send then."

Screenshot showed Clawsuu saying "Nope. Still nothing on my
end. If your client says it sent, the file isn't actually
making it through to me..." after a paste of a single
screenshot. Also a single-image send produced no user
bubble, and an image-only send (no text) didn't send at
all.

## 2. What we know

- My standalone curl test (the user's exact shape:
  `messages[0].content: [{type:text,text:""},{type:image_url,image_url:{url:"data:image/png;base64,..."}}]`)
  works. The model returned "I see a tiny thumbnail came
  through — like 22 pixels of garbage." (correctly
  describing my 1×1 PNG). Image bytes reach the model.
- The desktop's `mobile-attachment-batch` log fired with
  `attachments: 9` (batching worked — one call, not nine).
- The model still replied "Still nothing on my end."

So the bytes ARE going out, but the model is reporting
"nothing on my end." Either:

1. The model is confused because of the multimodal message
   shape (it's been talking about a different topic
   involving screenshots not arriving).
2. The data URI is being malformed somehow for real
   screenshots (250-330KB base64).
3. Something about how the renderer's chat pipeline
   handles the empty-message-with-attachments case.

We need visibility. The previous code had no logging on the
HTTP success path — only on failures. Adding logs so the
next test will show what the desktop actually sent and
received.

## 3. What this commit adds

Two log lines in `sendChatMessageViaHttp`:

1. **Pre-request:** `[chat:send/http] POST <url> (body=<size>b,
   attachments=<n>)`. Shows the request body size and
   attachment count so we can see if the body is huge
   (~9 images at 250-330KB each base64-encoded is several MB
   in the body).
2. **Post-response:** `[chat:send/http] response status=<code>
   keys=<object-keys>`. Shows the response was received and
   what shape it has.
3. **Multimodal content count** when the response itself
   has multimodal content: `[chat:send/http] multimodal reply
   content parts=<n>`.

That's enough to debug what the desktop sends vs what the
gateway forwards. The next test paste will reveal where the
mismatch is.

## Files changed

- `src/main.js` — three console.log calls in
  `sendChatMessageViaHttp`.
- `package.json` — version 3.2.52 → 3.2.53

**v3.2.53 (desktop, debug-only).**

## 4. Three separate problems in this report

The user also reported two issues I haven't addressed yet:

- **Single-image send produced no user bubble.** This is
  the mobile-side rendering of `attachments` on a single-
  message send. Looking at HomeScreen.tsx line ~3148, the
  user message is appended to messagesByAgent with
  `attachments: attachments.map(...)` — but the bubble
  rendering only renders attachments if the message has
  them. Need to verify the mobile's render path. NOT in
  this commit (debug logging first).
- **Image-only send (no text) didn't send.** This was the
  early-return guard in `__sendChatMessageImpl`:
  `if (!message && (!attachments || attachments.length === 0)) return;`
  — fixed in v3.2.51 (empty message + non-empty attachments
  is now valid). Should be working. If the user's seeing this
  still, might be the focus-check on TextInput not auto-
  attaching (v3.10.129) — but a manually-attached image
  should also work via the 📎 button. Investigating next.