# Two paths: sequencing the single-user sale and the team product

Captured 2026-06-10. Companion to `2026-06-09-go-to-market-design.md` (Path A,
the v1 single-user sale) and `2026-06-09-how-to-sell-to-enterprise.md` (Path B,
the enterprise build-list). This doc records the relationship between them and
the sequencing decision.

## Decision

v1 first. The single-user build ships and sells exactly per the go-to-market
design before any team work begins. The team path is a thesis to validate with
the v1 launch, not a parallel track.

## The two paths are different businesses

Path A sells a tool: a packaged build, $29 one-time, no servers, no pager.
Path B sells coordination: seats, a shared host that must stay up, authn/authz,
multi-tenancy, audit, eventually SSO and SOC 2. The buyer changes from a person
with $29 to a manager with procurement. Path B is not a bigger Path A — it is a
different company, and committing to it means choosing to run infrastructure
for money. The enterprise doc's checklist produces near-zero value until most
of it exists; it is a year of work with no intermediate sale.

## What makes the team path credible (when its time comes)

The wedge: review assignment. Orden's review unit is a rendered document with
an annotation rail, and a document — unlike a tmux pane — is handable. "Assign
this session's plan to a colleague for review" maps onto the muscle memory
teams already have from PR review, lifted to the intent/evidence level where
review burden is migrating anyway. Terminal-farm competitors cannot follow:
their shareable unit is a branch or a pane. Orden's artifacts (plans, writeups,
annotations) were born collaboration-shaped.

The value center: the centralized brain. Skills, ADRs, and project pages as a
shared, versioned library that agents consume over MCP — the org's agent
operating manual. Teams today scatter this across per-repo agent files and
personal skill folders, so every developer's agent behaves differently. A
governed context layer that makes agent behavior consistent across an org is
what an engineering leader budgets for. The kanban is not the value; teams
have boards. They do not have this.

The architecture already left the seams: the Host spine means a remote shared
NodeHost is the same interface the UI speaks today; `Identity` exists;
`LockService` is stubbed with a comment that real locking arrives with collab.

## The bridge is small teams, not enterprise

If Path B activates, the first product is not the enterprise checklist. It is
the 2-10 person team, self-serve, no procurement: a shared host on their own
infrastructure, seats, the shared vault, review assignment. Enterprise
(sections 1-7 of the enterprise doc) comes after teams pull in that direction,
not before.

## The launch is the instrument

The v1 launch doubles as the team-thesis experiment, free. The signal to watch
in launch feedback: unprompted "can I share this with my team / assign this to
someone?" comments. Their presence and frequency decide whether Path B opens;
their absence is also an answer.

## Standing constraint: protect the vault schema

The asset that compounds across both paths is the vault schema. Sessions,
cards, documents, and annotations are already the objects a team version would
share. Keep them clean and share-shaped, and the team product stays a refactor
instead of a rewrite. This is the only Path B consideration allowed to
influence Path A work.
