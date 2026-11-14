/**
 * Reliable delivery with the order of every message hop under fast-check's
 * control (#1370).
 *
 * `ManualScheduler` decides *when* a timer fires.  It has no say in *which
 * message arrives first*, and the claims `src/delivery/` makes are ordering
 * claims: an acknowledgment racing a retransmit loses no message, a duplicate
 * never re-runs the handler, the sequence never gaps.  No amount of repeating
 * an ordinary test explores those races — the dispatcher's `setImmediate`
 * keeps choosing the same order — so this harness takes the choice away from
 * the event loop and hands it to `fc.scheduler()`.
 *
 * The producer and the consumer are the real controllers, spawned under
 * `/user` of a real `ActorSystem` with virtual time.  What is fake is the wire
 * between them: the producer's `consumer` ref and each delivery's `replyTo`
 * are replaced by {@link ScheduledNetwork} hops, and a hop delivers only when
 * the scheduler releases its promise.  So a delivery, its retransmit and the
 * acknowledgment of either are three independent in-flight messages whose
 * arrival order the framework picks, shrinks on failure, and records in the
 * replay path it prints.
 *
 * The consumer's handler is synchronous on purpose.  Its serialisation is the
 * cell's job (#643), and a handler promise held by the scheduler would keep
 * the consumer busy, which `_settle` — the step that lets an actor turn land
 * after each release — would read as an exchange that never ends.
 *
 * Lives under `tests/util/` so the per-commit property and the deeper nightly
 * run (`tests/nightly/`) drive one harness with different run counts.
 */
import fc from 'fast-check';
import type { ActorRef } from '../../src/ActorRef.js';
import { MessageBoundaryOptions } from '../../src/diagnostics/MessageBoundaryOptions.js';
import { LogLevel, NoopLogger } from '../../src/Logger.js';
import { ConsumerController } from '../../src/delivery/ConsumerController.js';
import { ProducerController } from '../../src/delivery/ProducerController.js';
import type { ProducerSend } from '../../src/delivery/ProducerController.js';
import type { Acknowledgment, Delivery } from '../../src/delivery/Messages.js';
import { TestKit } from '../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../src/testkit/TestKitOptions.js';

/** Virtual milliseconds between a send and its retransmit. */
export const SCHEDULED_RESEND_TIMEOUT_MS = 1_000;

/** Upper bound on drain rounds — each one releases everything and fires one resend period. */
const MAXIMUM_DRAIN_ROUNDS = 64;

/** Send `body` through the producer; the model counts what was sent. */
type SendStep = { readonly kind: 'send'; readonly body: number };
/** Let one resend period pass, so every un-acknowledged sequence is transmitted again. */
type ResendStep = { readonly kind: 'resend' };

/** One command of the generated workload. */
export type DeliveryStep = SendStep | ResendStep;

/** What the generated case is made of, besides the scheduler. */
export type DeliveryScenario = {
  readonly steps: readonly DeliveryStep[];
  /** Consumed in transmission order while the network is lossy: `true` loses that hop. */
  readonly losses: readonly boolean[];
  readonly windowSize: number;
};

/**
 * The wire, with every hop released by the scheduler.
 *
 * Loss is drawn from the scenario rather than from the scheduler, because the
 * scheduler only orders — it never drops.  The draws are consumed in
 * transmission order, which is itself fixed by the interleaving, so a replay
 * path reproduces the losses as well.
 */
class ScheduledNetwork {
  private transmissions = 0;
  /** Off for the drain, so the run converges once the workload is done. */
  lossy = true;
  readonly transmittedSequences: number[] = [];

  constructor(
    private readonly scheduler: fc.Scheduler,
    private readonly losses: readonly boolean[],
  ) {}

  carry(label: string, deliver: () => void): void {
    if (this.lossy && this.losses.length > 0) {
      const lost = this.losses[this.transmissions % this.losses.length] ?? false;
      this.transmissions++;
      if (lost) return;
    }
    void this.scheduler.schedule(Promise.resolve(label), label).then(() => deliver());
  }
}

/** Everything the run observed, checked against the reference model. */
type Observations = {
  /** Bodies the consumer's handler ran for, in the order it ran them. */
  readonly handled: number[];
  /** body → how many times `confirm` was called and with what. */
  readonly confirmations: Map<number, Array<Error | null>>;
  /** Violations seen while running, which are only checkable at the moment they happen. */
  readonly violations: string[];
};

/** The real side of the model run. */
type DeliveryReal = {
  readonly kit: TestKit;
  readonly network: ScheduledNetwork;
  readonly producer: ActorRef<ProducerSend<number>>;
  readonly observations: Observations;
};

/**
 * The reference model, which is deliberately small: the protocol's promise is
 * that every send is handled exactly once and confirmed exactly once, so the
 * model only has to remember what was sent.
 */
type DeliveryModel = { sent: number[] };

class SendCommand implements fc.AsyncCommand<DeliveryModel, DeliveryReal> {
  constructor(private readonly body: number) {}
  check(): boolean { return true; }
  async run(model: DeliveryModel, real: DeliveryReal): Promise<void> {
    model.sent.push(this.body);
    const { confirmations, handled, violations } = real.observations;
    real.producer.tell({
      kind: 'reliable-delivery.send',
      body: this.body,
      confirm: (error) => {
        // "No message lost when an ack races a redelivery" is checkable only
        // here: a success confirmation for a body the handler never saw is a
        // loss, whatever happens afterwards.
        if (error === null && !handled.includes(this.body)) {
          violations.push(`body ${this.body} was confirmed before its handler ran`);
        }
        const outcomes = confirmations.get(this.body) ?? [];
        outcomes.push(error);
        confirmations.set(this.body, outcomes);
      },
    });
    await real.kit.system._settle();
  }
  toString(): string { return `send(${this.body})`; }
}

class ResendCommand implements fc.AsyncCommand<DeliveryModel, DeliveryReal> {
  check(): boolean { return true; }
  async run(_model: DeliveryModel, real: DeliveryReal): Promise<void> {
    await real.kit.advance(SCHEDULED_RESEND_TIMEOUT_MS);
  }
  toString(): string { return 'resend'; }
}

const commandFor = (step: DeliveryStep): fc.AsyncCommand<DeliveryModel, DeliveryReal> =>
  step.kind === 'send' ? new SendCommand(step.body) : new ResendCommand();

/**
 * The scheduler every run uses: after each release, let the actor turns the
 * released hop armed run to completion before the next decision.
 */
export const deliveryScheduler = (): fc.Arbitrary<fc.Scheduler> =>
  fc.scheduler({
    act: async (release) => {
      await release();
      await settleEverySystem();
    },
  });

/**
 * A scheduler replaying one fixed release order, with the same settle step as
 * {@link deliveryScheduler} — what an example test pins a shrunk interleaving
 * with.  Task ids count from 1 in the order tasks were scheduled, which is the
 * `task${n}` numbering a failure report prints.
 */
export const deliverySchedulerFor = (ordering: number[]): fc.Scheduler =>
  fc.schedulerFor(ordering, {
    act: async (release) => {
      await release();
      await settleEverySystem();
    },
  });

/** Systems of the run in progress — `act` is built before the run creates its own. */
const liveKits = new Set<TestKit>();

async function settleEverySystem(): Promise<void> {
  for (const kit of liveKits) await kit.system._settle();
}

/**
 * Workloads: up to `maximumSends` distinct bodies interleaved with resend
 * periods, a loss pattern, and a window narrow enough that queueing behind it
 * is part of what gets explored.
 */
export const deliveryScenario = (maximumSends: number): fc.Arbitrary<DeliveryScenario> =>
  fc.record({
    sendCount: fc.integer({ min: 1, max: maximumSends }),
    resends: fc.array(fc.nat({ max: maximumSends }), { maxLength: 3 }),
    losses: fc.array(fc.boolean(), { maxLength: 8 }),
    windowSize: fc.integer({ min: 1, max: 4 }),
  }).map(({ sendCount, resends, losses, windowSize }) => {
    const steps: DeliveryStep[] = [];
    for (let body = 0; body < sendCount; body++) {
      for (const at of resends) if (at === body) steps.push({ kind: 'resend' });
      steps.push({ kind: 'send', body });
    }
    return { steps, losses, windowSize };
  });

/**
 * One generated case: run the workload under the scheduler, drain the network
 * with loss switched off, then hold the observations against the model.
 *
 * Returns the list of violated claims, empty when the protocol held.  The
 * property asserts it is empty; an example test can assert on it directly.
 */
export async function runScheduledDelivery(
  scheduler: fc.Scheduler,
  scenario: DeliveryScenario,
): Promise<string[]> {
  // The delivery protocol is in-process by construction — a send carries its
  // `confirm` function and every delivery a reply ref — so the kit's default
  // structured-clone check would refuse the protocol's own messages.
  const boundaryOptions = MessageBoundaryOptions.create().withStructuredClone('off');
  const kitOptions = TestKitOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withMessageBoundary(boundaryOptions);
  const { kit } = TestKit.withManualScheduler('scheduled-delivery', kitOptions);
  liveKits.add(kit);
  const network = new ScheduledNetwork(scheduler, scenario.losses);
  const observations: Observations = { handled: [], confirmations: new Map(), violations: [] };
  try {
    const consumer = kit.system.spawn(
      () => new ConsumerController<number>({
        handler: (body) => { observations.handled.push(body); },
        // The sweep reads the wall clock; nothing here is idle long enough to
        // matter, and an eviction would be a permitted duplicate, not a defect.
        producerIdleTtlMs: Number.POSITIVE_INFINITY,
      }),
      'consumer',
    );
    let producerRef: ActorRef<ProducerSend<number> | Acknowledgment> | null = null;
    const acknowledgmentHop = {
      tell: (acknowledgment: Acknowledgment): void => {
        network.carry(`ack seq=${acknowledgment.seq}`, () => producerRef?.tell(acknowledgment));
      },
    } as unknown as ActorRef<Acknowledgment>;
    const deliveryHop = {
      tell: (delivery: Delivery<number>): void => {
        network.transmittedSequences.push(delivery.seq);
        network.carry(
          `delivery seq=${delivery.seq}`,
          () => consumer.tell({ ...delivery, replyTo: acknowledgmentHop }),
        );
      },
    } as unknown as ActorRef<Delivery<number>>;
    producerRef = kit.system.spawn(
      () => new ProducerController<number>({
        consumer: deliveryHop,
        resendTimeout: SCHEDULED_RESEND_TIMEOUT_MS,
        windowSize: scenario.windowSize,
      }),
      'producer',
    );
    const real: DeliveryReal = {
      kit,
      network,
      producer: producerRef as ActorRef<ProducerSend<number>>,
      observations,
    };

    await fc.scheduledModelRun(
      scheduler,
      () => ({ model: { sent: [] }, real }),
      scenario.steps.map(commandFor),
    );

    // Drain: no more loss, release everything in flight in an order the
    // scheduler still chooses, and let resend periods pass until every send
    // is settled.  A run that never settles is reported, not waited out.
    network.lossy = false;
    const sent = scenario.steps.filter((step): step is SendStep => step.kind === 'send').map((step) => step.body);
    for (let round = 0; round < MAXIMUM_DRAIN_ROUNDS; round++) {
      await scheduler.waitIdle();
      if (sent.every((body) => observations.confirmations.has(body))) break;
      await kit.advance(SCHEDULED_RESEND_TIMEOUT_MS);
    }
    await scheduler.waitIdle();

    return [...observations.violations, ...checkAgainstModel(sent, observations, network)];
  } finally {
    liveKits.delete(kit);
    await kit.system.terminate();
  }
}

/** The protocol's three claims, against what the run actually did. */
function checkAgainstModel(sent: readonly number[], observations: Observations, network: ScheduledNetwork): string[] {
  const violations: string[] = [];
  for (const body of sent) {
    const runs = observations.handled.filter((handled) => handled === body).length;
    if (runs === 0) violations.push(`body ${body} was never handled — lost`);
    if (runs > 1) violations.push(`body ${body} was handled ${runs} times — a duplicate got through`);
    const outcomes = observations.confirmations.get(body) ?? [];
    if (outcomes.length !== 1 || outcomes[0] !== null) {
      violations.push(`body ${body} was confirmed ${JSON.stringify(outcomes.map((o) => o?.message ?? 'ok'))}, expected exactly one success`);
    }
  }
  // Sequence numbers are 1..n with no gap: every number up to the highest one
  // ever transmitted was transmitted, and there are exactly as many as sends.
  const sequences = [...new Set(network.transmittedSequences)].sort((a, b) => a - b);
  const expected = sent.map((_, index) => index + 1);
  if (JSON.stringify(sequences) !== JSON.stringify(expected)) {
    violations.push(`transmitted sequences ${JSON.stringify(sequences)}, expected ${JSON.stringify(expected)}`);
  }
  return violations;
}
