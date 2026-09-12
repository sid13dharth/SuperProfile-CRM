# SuperProfile CRM — Instagram lookup

Open any Instagram profile and a panel tells you whether that handle is a lead
in our CRM, what stage they're at, who owns them, and their Instagram numbers.
You can also add a missing email without leaving the page.

**Chrome or Edge on desktop.** About a minute.

---

## 1. Unzip

Unzip somewhere **permanent** — Documents is fine, Downloads is not.

Chrome reads this folder from disk every time it starts. Delete or move it and
the extension stops working.

## 2. Load it

1. New tab → type `chrome://extensions` → Enter
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** (top left)
4. Pick the folder you unzipped — the one containing `manifest.json`

You should see **SuperProfile CRM — Instagram lookup, version 1.3.0**.

## 3. Log into the CRM

Open the CRM in the same browser and sign in as you normally would:

https://superprofile-leadgen.superprofile-crm.workers.dev

**That's the whole setup.** The extension uses your own CRM login, so there is
no key to paste and anything you change is recorded as you.

## 4. Try it

Open any `instagram.com/<someone>`. The panel appears top right.

| Left edge | Meaning |
|---|---|
| Green | In the CRM |
| Grey | Not a lead yet |
| Amber | Something's wrong — usually you're signed out |

Buttons change with the lead:

- **Open Conversation** — they've replied; opens the thread in the CRM
- **Open in CRM** — no reply yet; opens their record
- **+ Add lead** — not in the CRM; opens the add form, username pre-filled
- **+ Add email** — in the CRM but no email on file; type it into the panel

The **×** hides the panel until the next profile.

---

## If it doesn't work

**"Log in to the CRM in this browser"** — you're signed out. Open the CRM link
above, sign in, then reload the Instagram tab.

**Panel doesn't appear at all** — reload the Instagram tab (Ctrl+R). Content
scripts only attach when a page loads.

**You updated it and nothing changed** — on `chrome://extensions` click the
circular arrow on the card, *then* reload the Instagram tab. The version shown
in the panel header tells you which build you're on.

**Chrome nags about developer-mode extensions at startup** — expected for
unpacked extensions. Dismiss it; don't disable the extension.

---

## What it can and can't do

It reads lead data, and the only thing it writes is an email address on a lead
that doesn't have one. It cannot change stage, owner, manager, or delete
anything.

It runs only on `instagram.com` and talks only to our CRM worker.
