# How to sell Orden to enterprise

Captured 2026-06-09. A structured breakdown of what would need to be built or changed
to turn Orden from a single-user tool into an enterprise product.

## 1. Multi-tenancy & identity

Orden today is **single-user, single-vault**. Enterprise needs:

- **User identity & auth** — SSO (SAML/OIDC), MFA, SCIM provisioning
- **Multi-tenancy** — per-org vaults with namespace isolation; a tenant can have N
  users
- **RBAC** — org admin, project member, viewer, agent-operator roles

## 2. Team collaboration (the C0–C4 path from the design docs)

Already planned in `2026-05-29-collaboration-options.md` but not built:

- **Identity + presence** — who's online, what are they viewing
- **Pessimistic document locking** — "being edited by X," stale-lock takeover
- **Shared Kanban + annotation stores** — synced multi-client state
- **Session co-watch + co-drive with handoff** — multiple viewers, one driver
- **(Optional) CRDT co-editing** — Yjs + y-prosemirror if simultaneous typing in one
  prose document becomes a real need

## 3. Enterprise agent infrastructure

- **Org-wide agent policy** — which models & harnesses, which tools, spending caps
  per session/project
- **Cost tracking & attribution** — API spend by user/project/session, budget alerts
- **Concurrent session limits & queuing** — resource pools, GPU/API rate limits at
  org scale
- **Agent audit trail** — full session transcripts, tool-call logs, compliance
  exports
- **Secrets & credential management** — org-level credential vault, per-project env
  injection, redaction from transcripts

## 4. Enterprise deployment options

- **Self-hosted on-prem** — Docker/K8s, air-gapped, behind a corporate VPN
- **Cloud-hosted SaaS** — multi-tenant; isolated vaults, encrypted at rest
- **VPC / private networking** — IP allowlisting, private-link, no public exposure
- **Data residency** — region-pinned storage, export/import for compliance

## 5. Admin console & governance

- **Org dashboard** — usage, active sessions, spend, license utilization
- **User & team provisioning** — invite flow, SCIM, group sync
- **Policy engine** — block certain project types, restrict model access, enforce
  review gates
- **Audit log** — full event stream: who did what, when, on which project

## 6. Enterprise integrations

- **IdP** — Okta, Azure AD, Google Workspace
- **Source control** — GitHub Enterprise, GitLab, Bitbucket (beyond local/ssh remotes)
- **Ticketing** — Jira, Linear, Asana (bidirectional card sync)
- **Communication** — Slack/Teams notifications, annotation delivery to humans
  outside Orden

## 7. Commercial / business layer

- **Licensing** — seat-based subscriptions, usage-based billing, feature tiers
- **SLA** — uptime guarantees, support tiers, dedicated support
- **Onboarding** — org setup wizard, data migration from existing tools
- **Compliance certs** — SOC 2, ISO 27001, GDPR data processing agreements
