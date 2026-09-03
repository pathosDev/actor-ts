# Security policy

`actor-ts` is a distributed actor framework: it opens sockets, parses
wire frames, deserializes untrusted payloads and persists application
state. Bugs in any of that are security bugs. This page says how to
report one, what the project treats as in scope, and what the release
pipeline does to keep the shipped closure honest.

## Supported versions

The project is **pre-1.0** and there are no maintenance branches. Fixes
land on `develop` and ship in the next release; nothing is backported.

| Version                   | Supported |
| ------------------------- | --------- |
| Latest published `0.x.y`  | ✅ Yes    |
| Any earlier `0.x.y`       | ❌ No — upgrade to the latest release |

If you are pinned to an older version and cannot upgrade, say so in the
report: it does not change what gets fixed, but it does change what
mitigation advice is useful to you. See the
[version policy](https://github.com/pathosDev/actor-ts/blob/main/docs/src/content/docs/reference/version-policy.mdx)
for what "pre-1.0" implies about breaking changes.

## Reporting a vulnerability

**Do not open a public issue for anything that is exploitable against a
deployed system.**

Use GitHub's private vulnerability reporting: the repository's
**Security** tab → **Report a vulnerability**. That opens a draft
advisory visible only to you and the maintainer, and it is the channel
that produces a CVE and a published advisory at the end.

> **If that button is not there**, private reporting has not been
> enabled on the repository yet. In that case open a normal issue with
> the `[Security] ` prefix that says only *"I have a finding in
> `<subsystem>` and need a private channel"* — **no reproduction, no
> payload, no affected version** — and wait for a reply before sending
> details. An empty placeholder issue discloses nothing.

Please include, once you are on a private channel:

- the affected version (or commit) and the runtime (Bun / Node / Deno),
- a reproduction — a failing test or a short script is worth more than
  prose,
- the impact you believe it has, and under which of the deployment
  shapes below,
- any mitigation you already found.

**I will respond as quickly as I can.** This is a single-maintainer
project: there is no security team and no paid SLA, so no fixed window is
promised here rather than promised and missed. Reports are read, and a
serious one is worked before feature work. If yours has gone quiet longer
than feels right, ping the tracker with a content-free nudge — that is a
reasonable thing to do, not a rude one.

### Findings you can file in the open

Not everything needs the private path. Defense-in-depth items, audit
follow-ups, hardening suggestions and anything already public go
straight into the tracker with the
[security template](https://github.com/pathosDev/actor-ts/blob/main/.github/ISSUE_TEMPLATE/security_report.yml),
which applies the `security` label and a `severity:` label. That is how
the existing audit catalogue was filed, and it is the preferred route
when you are unsure — a public issue that should have been private can
be converted; a private report costs a round trip.

## Scope

The framework ships **insecure-by-default transports on purpose**, with
the secure configuration documented next to them. That makes the scope
boundary specific rather than obvious, so it is written out here.

### Out of scope — documented defaults

- **The cluster transport defaults to plain TCP with no peer
  authentication.** This is a deliberate default for a private network,
  documented in
  [Cluster security](https://github.com/pathosDev/actor-ts/blob/main/docs/src/content/docs/operations/security/cluster-security.mdx).
  "I ran a cluster on a hostile network without TLS and a stranger
  joined it" is the documented behaviour, not a vulnerability.
- Anything requiring an attacker who already has code execution in the
  actor system's own process, or read access to its configuration and
  key material.
- Denial of service by an operator against their own system — an
  unbounded mailbox that a local caller fills, a dispatcher starved by
  application code.
- Vulnerabilities in the example applications under `examples/`, which
  are illustrations and are not published to npm. Report them, but as
  ordinary bugs.

### In scope — everything the mitigations promise

- **A documented mitigation that does not deliver what it says.** If
  TLS is configured as the docs describe and peers still are not
  authenticated, that is a vulnerability, and one that has happened
  here before.
- Anything reachable from untrusted input on a socket: wire-frame
  parsing, HTTP routing and middleware, WebSocket framing, broker
  payloads, deserialization.
- Missing or bypassable bounds on untrusted input — frame-size limits,
  header limits, decompression ratios.
- Cryptographic mistakes: predictable identifiers where unpredictability
  is load-bearing, key handling, at-rest encryption and key rotation.
- Persistence: reading or writing another entity's stream, replay of a
  fenced writer, injection through a persistence backend.
- Anything that lets a cluster member escalate beyond what membership is
  supposed to grant.

## What the pipeline checks

These run in CI on every change, and are what a downstream consumer is
relying on when they install a published version:

| Gate | Where | What it catches |
| --- | --- | --- |
| **CodeQL** (`javascript-typescript`) | `.github/workflows/codeql.yml` — pull requests, pushes to `main`/`develop`, weekly | Injection, path traversal, unsafe deserialization and the rest of the `security-extended` query suite. Results land in the repository's code-scanning alerts. |
| **`bun audit`** | `.github/workflows/package-health.yml` — same triggers plus a weekly cron | Published advisories against the versions `bun.lock` actually pins. |
| **SHA-pinned actions** | `tests/unit/ci/WorkflowHygiene.test.ts` | A mutable action tag being repointed under a job that holds a publishing credential. |
| **npm provenance** | `.github/workflows/publish.yml` | Ties the published tarball to the workflow run and commit that built it. |
| **CycloneDX SBOM** | `.github/workflows/publish.yml` | Attached to every GitHub Release, so a consumer can diff the closure without reconstructing it. |

`bun audit` reads `bun.lock`. GitHub's dependency graph does not resolve
that file — it records the unresolved ranges from `package.json` — which
is why Dependabot's alerts on this repository have only ever come from
the npm lockfiles under `examples/`, and why `actions/dependency-review-action`
is deliberately *not* used here.

## Accepted advisories

The audit gate fails on any high or critical advisory, and **there are
no accepted ones**: the `lint:audit` script carries no `--ignore` flag.

It used to. The gate landed with a baseline of eleven suppressed
advisory IDs — every high advisory the lockfile carried at the time —
so that it could land green rather than land red and be ignored, with
[#779](https://github.com/pathosDev/actor-ts/issues/779) tracking the
refresh that would remove them. Six more were published upstream
afterwards, all against `fast-uri` and all against a lockfile nobody
had touched; those were never suppressed, and the gate did what a gate
is for and went red.

The refresh has now landed and clears both halves. All nineteen high
advisories in the closure turned out to be reachable by an **in-range**
bump:
`@fastify/static`, `brace-expansion`, `fast-uri` (both major lines),
`find-my-way` and `ws` all had a fixed release inside the range
`package.json` already declared. So only `bun.lock` moved. No
dependency range was widened, no `overrides` entry was added, and a
consumer installing `actor-ts` resolves the fixed versions from the
published manifest exactly as this repository does.

If a suppression is ever needed again it belongs back here as a table —
advisory, package, severity, and the path it is reached through — and
adding one is a deliberate act, not a way to get a change through.
`tests/unit/ci/SecurityPolicy.test.ts` asserts that this section and the
`lint:audit` ignore list name the same set of advisories, so one cannot
be silenced without appearing here, and a row cannot linger here after
its suppression is dropped.
