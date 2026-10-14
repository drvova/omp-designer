# The workshop, and the way back

`/designer-workshop <goal>` opens a loop: one open decision per turn, two to four
concrete options with what each buys and costs, the chosen one applied and the
updated artefact shown. The loop lives in `skills/workshop.md`; this document is
about the part that used to be missing — how a decision made by the reader gets
back into the session.

## What the reader clicks

The canvas server (`designer-canvas.mjs --serve`, or `designer_check` with
`serve: true`) serves the project. It reads the plan document the workshop writes
and renders the open question as a panel on the canvas:

- the question, and one button per option with its label and detail;
- the last few decisions already made, so a reload never invites a redo;
- a note saying what clicking does.

The plan document carries the machine-readable half in a fenced block:

````markdown
```json workshop
{ "question": "Pricing on the home page, or its own route?",
  "options": [
    { "id": "inline", "label": "Keep it on the home page", "detail": "one scroll, no extra route" },
    { "id": "route", "label": "Give it its own route", "detail": "room to grow" }
  ] }
```
````

`WORKSHOP.md` is looked for at the project root (lowercase too). A block that does
not parse, or one with no options, renders as a plain note saying so — the panel
never offers a button whose click cannot be recorded.

## What a click does

`POST /workshop/decide` with `{ "optionId": "route" }`:

1. reads the open question again and rejects any option that is not on the page
   (`400`, and nothing is written — a stray POST cannot put junk in the record);
2. appends `{ id, question, optionId, label, detail, at }` to
   `.designer/workshop-decisions.jsonl` beside the project;
3. rebuilds the canvas and pushes a reload to every open viewer, so the panel shows
   the decision as settled.

The log is append-only and inside the project, so the decision survives a restart
and travels with the work — the same reason cc keeps the record on the page rather
than in a session.

## What the session sees

At prompt-assembly time the extension reads the decisions, drops the ones it has
already injected, and adds a section to the turn:

```
## The reader decided on the workshop page
The reader chose **Give it its own route** (room to grow) for "Pricing on the home page, or its own route?".
Apply it to the work and show the updated artefact. Do not ask for it again.
```

The ids it injected are remembered per project for the life of the session, the
injection is traced (`workshop_decisions_applied`), and a decision is never replayed:
the loop moves forward or it is not a loop. It is never re-asked either — the
injected section says so in the words the model reads. Setting the
`--designer-workshop=false` flag (or `workshop: false` in the flag file) suppresses
both the fragment and the decisions, for a session that should not be in workshop
mode at all.

## What is deliberately not here

- **No polling.** Nothing watches the log on a timer; the decision is read where
  every other turn-time input is read, at prompt assembly.
- **No page → tool channel.** cc's page calls back into the app it is hosted in.
  A local page has no such host, so the click goes to the only server it can reach:
  the canvas, which is already serving the project.
- **No re-ask.** If the reader clicks twice, both decisions are recorded (the log
  is a log), but only the ones the session has not seen are injected, and the panel
  shows what was settled.
