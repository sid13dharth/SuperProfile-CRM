# SuperProfile Team CRM

**A CRM and Chrome extension that work as one system: every lead, from the first message to a closed deal.**

An in-house CRM that SuperProfile's global partnerships team uses every day to find creators, reach out, reply, negotiate and close partnerships. Designed and built by **Siddharth Pradeep** (Team Lead, Global Partnerships & Growth) with **Claude Code**, without a dedicated engineering team.

| 20K+ | 5K+ | 60K+ | 100+ |
|:---:|:---:|:---:|:---:|
| leads in one shared database | creator conversations | emails of outreach history | campaigns connected |

---

## Why it exists

As our global outreach grew, the work was spread across 30+ spreadsheets, a cold-email tool and a separate inbox. That caused four problems:

- **Duplicate outreach.** Teammates contacted the same creator twice, because nobody could see who had already spoken to whom.
- **Missed replies.** Replies sat in a different tool from the lead's details, so they got missed or answered late.
- **No funnel view.** We couldn't see where deals stalled, so we couldn't tell which campaigns were working.
- **Lost context.** When someone left, their leads and history left with them.

Off-the-shelf CRMs didn't fit an outreach-heavy, creator-partnership workflow, so we built our own.

## What it does

```
Find a lead → Check it's new → Reach out → Reply in one inbox → Negotiate → Close or mark lost
```

- **Shared lead database.** Every lead has an owner, a pipeline stage and its full history in one record.
- **Duplicate check.** The CRM flags a creator the team already knows the moment someone tries to add them.
- **Unified inbox.** Email replies sync in automatically, and the team answers them next to the lead's details.
- **Pipeline and deals.** Leads move through Leads → Responses → Closed / Failed, with rates, deliverables and reasons for lost deals recorded.
- **Funnel and activity views.** These show which campaigns and segments convert and what each teammate is working on.
- **Chrome extension (part of the same system).** It works on **Instagram, YouTube and Skool**. On any lead's profile page, teammates can add the lead in one click, see past conversations and the full history the company has with them, without leaving the page.

## Impact

**For the team:** no more double outreach, faster replies, clear ownership of every lead, and a single tool for new hires and interns to start in.

**For the company:** GTM decisions backed by real funnel data (we double down on what converts and cut weak segments), live visibility into pipeline health for leadership, and a permanent record of every conversation, rate and outcome. It costs little to run and has no per-seat CRM fees.

## How it was built

Built with AI (Claude Code) and shipped in **20+ iterations** based on teammates' day-to-day feedback.

<details>
<summary>Technical overview</summary>

- **Stack:** Cloudflare Workers (backend + API), Cloudflare D1 (SQL database), and a lightweight JavaScript web app.
- **Integrations:** Instantly (email campaigns and reply sync) and HikerAPI (Instagram profile data).
- **Extension:** a Chrome extension (Manifest V3) that runs on Instagram, YouTube and Skool profile pages and talks to the CRM.
- **Layout:** `cloud/src` is the backend, `cloud/static` the web app, `cloud/migrate_v*.sql` the database migrations, and `extension/` the browser extension.

</details>
