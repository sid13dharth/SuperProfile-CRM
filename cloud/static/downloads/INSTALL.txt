# SuperProfile CRM — lead lookup (Instagram, YouTube, Skool)

Open an Instagram profile, a YouTube channel or video, or a Skool community or
member profile, and a glass panel tells you whether that creator is a lead in our
CRM, what stage they're at and who owns them.
You can also add a missing email without leaving the page.

**Chrome or Edge on desktop.** About a minute.

---

## 1. Download and unzip

In the CRM sidebar click **Chrome extension** — it always downloads the latest
version.


Unzip somewhere **permanent** — Documents is fine, Downloads is not.

Chrome reads this folder from disk every time it starts. Delete or move it and
the extension stops working.

## 2. Load it

1. New tab → type `chrome://extensions` → Enter
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** (top left)
4. Pick the folder you unzipped — the one containing `manifest.json`

You should see **SuperProfile CRM — lead lookup** with the latest version.

### Already have an older version?

Reloading on its own will **not** update you — Chrome reads the folder on your
disk, and nothing fetches a new copy. Replace the files first:

1. In the CRM sidebar click **Chrome extension** and unzip the download
2. Copy the files **into the folder you loaded before**, replacing all of them
3. `chrome://extensions` → click the **circular arrow** ↻ on the card
4. Reload your Instagram / YouTube / Skool tab (Ctrl+R)

If you unzip somewhere new instead, **Remove** the old card and **Load
unpacked** the new folder — the old entry still points at the old files.

Check the version in the panel header. From 1.6.1 on, the panel itself tells you
when a newer version is out, with a download link.

## 3. Log into the CRM

Open the CRM in the same browser and sign in as you normally would:

https://superprofile-leadgen.superprofile-crm.workers.dev

**That's the whole setup.** The extension uses your own CRM login, so there is
no key to paste and anything you change is recorded as you.

## 4. Try it

Open any `instagram.com/<someone>`, `youtube.com/@channel` (or one of their
videos), or `skool.com/<community>` / `skool.com/@person`. The panel appears top
right. On a Skool member's profile it shows the community they own.

| Left edge | Meaning |
|---|---|
| Red | Already a lead |
| Yellow | A lead, but no email yet |
| Green | New — not in the CRM |
| Grey | Something's wrong — usually you're signed out |

The panel shows their stage, **Added by** (who sourced the lead), **Lead Owner**
(the teammate who owns it), email, when we last contacted them and when they
last replied, plus their follower count and recent reel views.

If they have ever posted a video for us you also get a green **★ Partner**
block: how many videos, the latest one's views, likes and comments, a link to
the post, and a button into that creator's videos in the CRM.

Buttons change with the lead:

- **Open Conversation** — they've replied; opens the thread in the Unibox
- **Open in CRM** — no reply yet; opens their record
- **+ Add lead** — not in the CRM; opens the add form, username pre-filled
- **+ Add email** — in the CRM but no email on file; type it into the panel
- **Open videos in CRM** — a partner; opens the Videos tab filtered to them

The **›** slides the panel off to the right edge; click the small tab there to
bring it back (it stays tucked away across pages until you do). The **×** closes
it for this page only.

If the same person is a lead on another platform (same email), the panel lists
it under **Also a lead on**.

---

## If it doesn't work

**"Log in to the CRM in this browser"** — you're signed out. Open the CRM link
above, sign in, then reload the tab.

**Panel doesn't appear at all** — reload the tab (Ctrl+R). Content
scripts only attach when a page loads.

**You updated it and nothing changed** — on `chrome://extensions` click the
circular arrow on the card, *then* reload the tab. The version shown
in the panel header tells you which build you're on.

**Panel stuck on "Checking @someone…", or it says the background worker did
not respond** — Chrome's background worker got wedged. This is the common one,
and the reload arrow does **not** clear it. Do all three steps:

1. `chrome://extensions` → **Remove** the extension
2. **Quit Chrome completely** — every window, not just the tab. Chrome holds
   the broken registration open until the process actually exits.
3. Reopen Chrome → **Load unpacked** → pick the folder again

A giveaway that this is what you are hitting: on the extension card, clicking
the blue **service worker** link does nothing at all.

**Chrome nags about developer-mode extensions at startup** — expected for
unpacked extensions. Dismiss it; don't disable the extension.

---

## What it can and can't do

It reads lead data, and the only thing it writes is an email address on a lead
that doesn't have one. It cannot change stage, owner, manager, or delete
anything.

It runs only on `instagram.com`, `youtube.com` and `skool.com`, and talks only to our CRM worker.
