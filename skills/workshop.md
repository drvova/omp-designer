---
name: workshop
description: "Build a design together with the user, one decision at a time. Use when asked to workshop a design, explore options, or run a decide-and-revise loop before building."
when_to_use: Load when the user wants to work through a design together — 'let's design this', 'what do you think', 'explore options', 'help me decide' — or when the workshop mode was opened for this project.
---

A workshop is a decision loop, not a questionnaire. You show the shape of the
thing, the user makes one decision, you apply it and show the updated thing, and
that repeats until nothing is left to decide. Then they say build.

## The loop

1. **Draft first.** Before asking anything, put up a first version of the artefact
   — a real page, a board, or a written plan with the parts you are confident
   about. A workshop starts from something concrete they can react to, not from an
   empty list of questions.
2. **One decision per turn.** Exactly one open question, even when you can see
   four. Bundled questions get bundled answers, and the trade-offs between them
   are lost.
3. **Options, not blanks.** Offer two to four concrete choices, each with what it
   buys and what it costs in the product's terms ("a single-page story keeps the
   focus on the product photograph; separate pages give each capability room but
   ask the visitor to navigate"). Never ask an open question when a choice can be
   framed; never present a choice you would not defend.
4. **Apply, then show.** The next turn opens with the decision already applied and
   the artefact updated. If a decision is what the user did not pick, say what you
   kept and why in one line, so it can be revisited.
5. **Record the open set.** Keep the decisions made and the ones still open where
   the project can see them (a plan document, a `WORKSHOP.md` beside the work), so
   the loop survives a break and a later reader can see what was settled.
6. **Stop when settled.** When no decision is left, say so and ask for the build in
   one line. Do not keep inventing questions to extend the workshop.

## Narrate the deliverable, never the machinery

Talk about the workshop, not what runs it.

- Good: "The type and palette are settled; the one thing left is whether the
  pricing table sits on the home page or its own route."
- Bad: "Loading the workshop skill, then publishing an updated artefact."
- Never announce internal steps: skill loads, fragment selection, which file the
  page is written to, how the decisions are stored. The user hears what changed
  and what is next. Internals only when they ask, or when something broke and the
  detail is what explains it.

Vary the wording each round. A recurring stock phrase is what makes a workshop
feel like a template, and the first line is where it shows worst.

## What "applied" means here

In this environment the artefact is the project: update the real files, rebuild the
canvas (`designer-canvas`), and let the driver capture it when a visual decision
changed. A decision that only exists in the conversation is not applied. If the
user wants to see it before committing, say which files changed and show the
canvas; do not create a parallel draft that can drift from the project.

## When the workshop ends

- Every open decision answered → ask for the build (one line, no ceremony).
- The user says build at any point → stop workshopping and build. The remaining
  open decisions become assumptions; state them where the work is, and proceed.
- The user wants to stop the loop → close it, and say what is settled and what
  remains open so nothing is silently lost.
