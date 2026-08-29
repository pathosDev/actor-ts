package comparison

import java.util.Arrays

/**
 * The measurement protocol, mirrored by hand from
 * `benchmarks/lib/harness.ts` and `benchmarks/lib/stats.ts`.
 *
 * "Mirrored by hand" is the honest description and the reason the published
 * tables keep cross-language rows in their own section: the JavaScript arms all
 * run through *literally the same* harness code, while this one only reproduces
 * its behaviour. Deliberately not JMH — JMH is a better microbenchmark harness
 * than this will ever be, but it measures differently (forked JVMs, blackholes,
 * its own warmup policy), and a comparison whose two sides use different
 * methodologies cannot be read as one table. Symmetry beats sophistication here.
 *
 * Everything below matches the TypeScript original exactly, including the
 * percentile rule (`sorted[floor(n * p)]`, clamped) and the population — not
 * sample — standard deviation. Diverging on either would move numbers for
 * reasons that have nothing to do with the frameworks.
 *
 * It also matches the sibling `../pekko-java` arm line for line, which matters
 * more here than the Scala idiom would: the pair exists to price the language
 * binding, so any difference in the *measurement* would be attributed to the
 * binding by mistake. The idiomatic-Scala freedom is spent in `Actors.scala`,
 * where it is the subject, not here, where it would be noise.
 */
object Harness:

  /**
   * Smoke mode collapses every case to a single unwarmed iteration, matching
   * `ACTOR_TS_BENCH_SMOKE` on the JavaScript side.
   *
   * Without this the flag reached this arm and did nothing: the process ran the
   * full workload and then overwrote a real measurement with it. That is the
   * failure the JavaScript side guards against by refusing to write at all in
   * smoke mode, and a cross-language arm has to honour the same rule or the
   * flag is a trap rather than a check.
   */
  val SmokeMode: Boolean = "1" == System.getenv("ACTOR_TS_BENCH_SMOKE")

  /** One measured row, shaped exactly like the JSON the JavaScript arms write. */
  final case class ScenarioResult(
      scenario: String,
      caseName: String,
      unit: String,
      iterations: Int,
      opsPerIteration: Int,
      warmupIterations: Int,
      totalNs: Long,
      opsPerSecond: Double,
      perOperationNs: Double,
      meanNs: Double,
      stddevNs: Double,
      minNs: Double,
      maxNs: Double,
      p50Ns: Double,
      p95Ns: Double,
      p99Ns: Double,
      expectedOperations: Long,
      completedOperations: Long,
      notes: Option[String],
  )

  /**
   * Warm up, then measure, asserting after every single call that the system
   * completed exactly the work it was asked for.
   *
   * That assert is the point of the whole exercise. A published figure from
   * this project was once roughly 10x too high because a harness counted the
   * work it requested rather than the work that happened (#1027), and nothing
   * about a foreign framework makes it immune — every runtime here has queues
   * that can drop and futures that can time out.
   *
   * `operation` returns the operations the system was OBSERVED to complete.
   */
  def measure(
      scenario: String,
      caseName: String,
      unit: String,
      iterations: Int,
      opsPerIteration: Int,
      warmupIterations: Int,
      notes: Option[String],
  )(operation: () => Long): ScenarioResult =

    val effectiveIterations = if SmokeMode then 1 else iterations
    val effectiveWarmup = if SmokeMode then 0 else warmupIterations

    // Warmup comes from the workload rather than a formula. A JIT-compiled
    // runtime measured after a handful of iterations is measured
    // mid-compilation: raising this arm's warmup from 100 to 3 000 moved its
    // ask rate by 33 % and its tell rate by 11 %.
    var warmed = 0
    while warmed < effectiveWarmup do
      requireComplete(scenario, caseName, opsPerIteration, operation())
      warmed += 1

    System.gc()

    val samples = new Array[Long](effectiveIterations)
    var observedTotal = 0L
    val totalStart = System.nanoTime()
    var i = 0
    while i < effectiveIterations do
      val started = System.nanoTime()
      val completed = operation()
      samples(i) = System.nanoTime() - started
      observedTotal += requireComplete(scenario, caseName, opsPerIteration, completed)
      i += 1
    val totalNs = System.nanoTime() - totalStart

    val totalOps = effectiveIterations.toLong * opsPerIteration
    val perOperationNs = totalNs.toDouble / totalOps
    val opsPerSecond = 1e9 / perOperationNs

    val sorted = samples.clone()
    Arrays.sort(sorted)
    var mean = 0.0
    for s <- sorted do mean += s
    mean /= sorted.length
    var variance = 0.0
    for s <- sorted do variance += (s - mean) * (s - mean)
    variance /= sorted.length

    ScenarioResult(
      scenario, caseName, unit, effectiveIterations, opsPerIteration,
      effectiveWarmup, totalNs, opsPerSecond, perOperationNs,
      // `.toDouble` spelled out: Scala warns on the implicit widening that Java
      // performs silently here.  Same value, same precision at these
      // magnitudes — the warning is about the general case, not this one.
      mean, math.sqrt(variance), sorted(0).toDouble, sorted(sorted.length - 1).toDouble,
      percentile(sorted, 0.50), percentile(sorted, 0.95), percentile(sorted, 0.99),
      totalOps, observedTotal, notes,
    )
  end measure

  private def requireComplete(scenario: String, caseName: String, expected: Int, completed: Long): Long =
    if completed != expected then
      throw IllegalStateException(
        s"pekko-scala / $scenario / $caseName: completed $completed of $expected operations. " +
          "A comparison row may not be published for work that did not happen (#1027)."
      )
    completed

  /** `sorted[floor(n * p)]`, clamped — the rule `stats.ts` uses. */
  private def percentile(sorted: Array[Long], p: Double): Double =
    sorted(math.min(sorted.length - 1, math.floor(sorted.length * p).toInt)).toDouble

end Harness
