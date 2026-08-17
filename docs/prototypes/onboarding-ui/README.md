# Onboarding UI prototype — THROWAWAY

Question this answers: **what should a customer onboarding UI for the gateway look
like?** (mint a connector token, set a routing target, check status — the three
things AGENTS.md says onboarding needs today via raw HTTP/env vars.)

No real UI exists in this repo, and no frontend framework to embed into, so this is
a standalone static HTML file (sub-shape B) rather than a variant on an existing
page. All data is mocked in-memory in the file itself — nothing here calls the real
gateway.

## Run it

Open the file directly, no server needed:

```bash
open docs/prototypes/onboarding-ui/index.html
```

Switch variants with the floating bottom bar, arrow keys, or `?variant=A|B|C` in
the URL.

## Variants

- **A — Wizard**: linear, one decision per screen (mint token → set target →
  install snippet → confirm status). Best if onboarding should feel guided and
  hard to get wrong.
- **B — Dashboard**: all three steps visible at once in a grid, no forced order.
  Best for a power user who wants to see/change everything without stepping
  through a flow.
- **C — Terminal-first**: a transcript pane showing the actual `curl` commands
  each button issues, with a thin button rail. Best if the target audience
  already lives in a shell and just wants a faster way to get the right command
  plus a live nudge that it worked.

## Status

Not yet reviewed with a human. Once a direction (or a hybrid) is picked, capture
the decision here and in the implementation issue, then this whole directory goes
to a throwaway branch — not into main.
