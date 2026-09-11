# SuperProfile CRM — Instagram lookup (Chrome extension)

Open any Instagram profile and a panel shows whether that handle is a lead in the
CRM, what stage they are at, who owns them, and their Instagram numbers.

Read-only. It cannot change anything in the CRM.

## Install (per person, ~1 minute)

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose this `extension` folder.
3. Click the extension's icon, paste the **team key**, press **Save & test**.
   It should say *"Saved — connected to the CRM."*
4. Open any `instagram.com/<handle>` and the panel appears top-right.

The `×` hides the panel until the next profile.

## What the colour on the left edge means

| Edge | Meaning |
|---|---|
| Green | In the CRM |
| Grey | Not a lead yet |
| Amber | Something is wrong — usually a missing or rejected key |

## How it is wired

- `content.js` runs on instagram.com, works out the handle from the URL and
  draws the panel. Instagram is a single-page app, so it watches `pushState` /
  `replaceState` / `popstate` rather than only running on load — without that it
  would only work after a manual refresh.
- `background.js` does the actual network call. Fetching from the service worker
  (not the content script) means the request is exempt from CORS and the key is
  never handed to a page that Instagram's own scripts share.
- The CRM endpoint is `GET /api/ext/lead?handle=…`, authenticated with an
  `x-ext-key` header.

## Why a key and not your CRM login

The CRM session cookie is `SameSite=Lax`, so the browser will not send it on a
request that originates from instagram.com. Loosening that would remove the
CSRF protection for the whole CRM, so the extension uses a separate shared key
instead — the same pattern the CRM already uses for `/api/lookup`.

## Rotating the key

```bash
cd leadgen_platform/cloud
CLOUDFLARE_API_TOKEN=$(cat cf_token.txt) npx wrangler secret put EXT_KEY
```

Secrets apply to the running Worker immediately — no redeploy. Everyone then
re-pastes the new key in the extension options.

## Known limits

- Read-only by design. "Add lead" and editing stage are deliberately not here.
- A shared key means actions cannot be attributed to a person. Fine while it
  only reads; revisit if write actions are ever added.
- Unpacked extensions make Chrome show a "disable developer mode extensions"
  prompt on restart. An unlisted Chrome Web Store listing removes that.
- Only matches Instagram. Other networks would need their own URL parsing.
