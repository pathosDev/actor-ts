# Real-network multi-node integration tests (#313)

The `tests/unit/` and `tests/multi-node/` suites cover correctness
against the in-memory transport — synthetic partitions, fast
deterministic message ordering, no kernel involvement.  That's
the right shape for tight feedback loops but it doesn't catch:

- TCP-layer timing (slow handshakes, socket buffer behaviour)
- OS scheduler pressure under real concurrency
- Kernel-buffer / Nagle-algorithm interactions
- Real-DNS resolution and dual-stack peculiarities

This directory ships a Docker-compose setup that brings up 5
cluster-node containers + 1 controller container on a bridge
network, partitions them with `iptables` inside their own
namespaces, and runs scenarios against the resulting topology.

## Run it locally

You need Docker (Docker Desktop on macOS/Windows, or Docker
Engine on Linux).  Nothing else.

```bash
bun run test:integration
```

That builds the image, brings up all six containers, runs every
scenario in `scenarios/`, and exits with the controller's
status code (0 = all pass, 1 = at least one failed).

To clean up afterwards (volumes, networks, dangling containers):

```bash
bun run test:integration:teardown
```

## What's in the box

```
tests/integration/
├── Dockerfile.node                        # Bun + iproute2 + iptables image
├── docker-compose.integration.yml         # 5 nodes + 1 controller
├── node-runner.ts                         # per-node Bun entrypoint
├── controller.ts                          # scenario runner
├── lib/
│   ├── partition.ts                       # iptables + tc helpers
│   └── control-routes.ts                  # HTTP surface for the helpers
└── scenarios/
    ├── types.ts                                  # Scenario / ControllerCtx + helpers
    ├── 01-membership-convergence.ts              # smoke test — every node sees all peers
    ├── 02-split-brain.ts                         # 2:3 partition, majority survives, then heal
    ├── 03-receptionist-convergence.ts            # workers under one ServiceKey gossip to all 5 nodes
    └── 04-ddata-latency-storm.ts                 # majority-quorum LWWRegister writes survive 50ms tc-netem
```

## Architecture

Each cluster-node container runs `node-runner.ts`, which:

1. Boots an `ActorSystem` with `JsonLogger` (so the docker logs
   are jq-friendly).
2. Joins the cluster via real `TcpTransport` on port `9000`,
   bound on `0.0.0.0` and identified by the compose hostname
   (e.g. `node-b`).
3. Exposes the management HTTP at `:8080`, auth-protected with
   `BearerTokenAuth` (the `MGMT_TOKEN` env var).
4. Exposes a small **test-control** HTTP at `:8090` —
   `/test/ping`, `/test/members`, `/test/partition?peer=X`,
   `/test/heal?peer=X`, `/test/delay?ms=N`, `/test/clear`.  No
   auth on this one; it's only reachable from the compose
   bridge network.

The controller container has no NET_ADMIN — it makes HTTP calls
into the node containers to read state and to install / heal
partitions.

Partitions are realised as **`iptables` drops inside each
container's network namespace** — symmetric (both directions
between A and B) so there's no half-open weirdness, and scoped
so a container can only affect its own peers.  Latency
injection uses `tc qdisc add ... netem delay`.

## CI

`.github/workflows/integration.yml` runs the same `bun run
test:integration` command on pull requests targeting `main`
(i.e. the release PR) and on a nightly schedule.  Routine
`develop` pushes and feature PRs do NOT run it automatically —
it's expensive and the fast unit suite catches most
regressions.  Manually re-run via the GitHub Actions UI when a
change touches transport / cluster / downing code.

## Adding a scenario

1. Drop a new file in `scenarios/` exporting `scenario: Scenario`.
2. Add the import to `controller.ts`'s `scenarios` list.
3. Test locally with `bun run test:integration`.

The `Scenario.run(ctx)` function receives a `ControllerCtx`
with `nodes: string[]`, `mgmtToken`, `controlPort`, `mgmtPort`.
Use `waitFor` from `scenarios/types.ts` for any "wait until X"
step — it gives a deterministic deadline message on failure
rather than a flaky 30-second timeout.

## Local debugging

Bring up the cluster without running the controller:

```bash
docker compose -f tests/integration/docker-compose.integration.yml up -d node-a node-b node-c node-d node-e
```

Then probe manually:

```bash
# What does node-c see?
curl -s http://localhost:8090/test/members | jq      # → ECONNREFUSED on the host
# Inside the network instead:
docker compose -f tests/integration/docker-compose.integration.yml exec node-a \
  curl -fsS http://node-c:8090/test/members | jq

# Partition node-c from node-d:
docker compose -f tests/integration/docker-compose.integration.yml exec node-c \
  curl -fsS -X POST http://node-c:8090/test/partition?peer=node-d
```

The control port is intentionally NOT published on the host —
operator-style debugging goes via `docker compose exec`.  This
keeps the surface honest: nothing in the scenarios reaches
through the host, so the same configuration runs identically in
CI and locally.
