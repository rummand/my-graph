# Microsoft Scout: what we take from it

Research done 2026-11-04 from Microsoft Learn (learn.microsoft.com/en-us/microsoft-scout/*), the Build announcement
(microsoft.com/en-us/copilot/blog/2026/06/02/introducing-microsoft-scout-your-always-on-personal-agent/, now renamed
"Autopilot"), and third-party reviews. Scout is an always-on personal agent: chat, memory with provenance, a
"Heartbeat" that checks in on a schedule, Automations (schedule or condition triggers, run history), skills,
sub-agents, approval cards for anything that changes shared information, and strict policies for unattended runs.

## What My Graph adopts (mapped to a family brain)

1. **Approval cards.** Anything the assistant wants to write (fact, reminder, merge, wiki edit, rule) is shown as an
   exact preview with **Approve**, **Always allow** (remember this kind of action) and **Deny**. Inferred facts are never
   promoted silently.
2. **Memory you can see and edit.** "What the assistant remembers": preferences, family rules and notes it saved while
   you worked, each tagged with where it came from (a chat, an upload, an outside document, you). Edit, pause, delete.
3. **Outside content is data, not instructions.** Uploaded letters, Aula messages, web text are untrusted. The assistant
   never follows instructions inside them, and asks before acting on facts drawn only from them.
4. **Heartbeat.** A check-in on chosen days and hours (e.g. every 60 min, Mon–Fri 07–20) that looks for what changed:
   new letters, deadlines, birthdays, overdue reminders, people you haven't been in touch with. It only proposes.
5. **Automations.** Name, prompt, trigger (schedule like "Sundays 18:00", or a condition like "when a document mentions
   a vaccination"), one-shot flag, enabled toggle, run history.
6. **A stricter policy when nobody is watching.** Unattended runs may only *propose* (suggestions inbox); they never
   share, message, change visibility, or write facts directly. Steps that would need approval are skipped and listed.
7. **Activity log.** Every action the assistant took, and when, per graph: on Today, on the Automations page, on a node.
8. **Rules learned from exceptions.** "Sunday dinner is family time", "Grandma can always book the kids on Wednesdays".
   Stored as editable rules and applied when the assistant suggests times or reminders.
9. **Clarifying questions as choices.** Preset choice chips + free text + **Skip** ("continue with what you know").
10. **Sensitivity escalation.** Once a chat touches private or parents-only items, the conversation is marked (shown in
    the UI), and the assistant warns before writing that content anywhere more widely visible.
11. **Show its work.** Streaming steps ("Searched the library, read 3 letters, checked the timeline"), "Thought for 4s",
    citations, and a way to pause or stop.
12. **Recipes (skills).** Saved prompts the family writes ("Weekly family summary", "Packing list from past trips"),
    usable from chat, Today, or as an automation.
13. **Co-writing wiki pages.** The assistant drafts or updates a page with a visible "Assistant is writing" badge and
    cursor; your view follows it only when you are idle; you accept or undo its changes.
14. **Onboarding with stated defaults.** Plain defaults on first run ("Saving inferred facts automatically: off",
    "Check-ins: off") and example prompts drawn from the family's real data, plus a "be specific" tip.
15. **Conversations like an inbox.** Search past chats, pin, mark unread, rename, compact a long chat, thumbs up/down.

## What we avoid (from the criticism)

- Engagement-maximising nudges: cap suggestions per day, show acceptance, make every nudge dismissable forever.
- Personifying the assistant inside family threads. It is "the assistant", not a named colleague.
- Opaque failures: always say what went wrong and what to do.
- Hidden cost: show mux usage per graph.
- Sharing that can grant but not revoke: everything granted can be taken back.
