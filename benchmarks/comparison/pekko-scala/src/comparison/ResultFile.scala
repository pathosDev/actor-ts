package comparison

import java.nio.file.Path

/**
 * The on-disk result, matching `benchmarks/comparison/js/result-file.ts`.
 *
 * `report.ts` validates every field it reads and refuses a file it does not
 * recognise, so this is a schema rather than a convention.
 */
object ResultFile:

  private val SchemaVersion = 1L

  def write(path: Path, environment: EnvironmentBlock, results: Seq[Harness.ScenarioResult]): Unit =
    val json = JsonWriter()
    json.beginObject()

    json.name("schemaVersion").value(SchemaVersion)

    json.name("framework").beginObject()
      // The binding is part of the identity: the same framework at the same
      // version is measured beside this through its Java API, and two arms
      // called "pekko" would collide on the published file name.
      // `Main.outputPath()` spells the derived name out — keep them in step.
      .name("name").value("pekko-scala")
      .name("version").value(pekkoVersion())
      // "Scala 3" rather than a bare "Scala": the artifacts this arm resolves
      // carry a `_3` suffix and the sibling Java arm resolves the `_2.13` build
      // of the same release, so the generation is the distinguishing fact.
      .name("language").value("Scala 3")
      // Apache-2.0 — the licence is the reason this arm exists next to the
      // other JVM lineage, which is BUSL-1.1. Same lineage, different terms,
      // and that difference decides real adoption questions.
      .name("license").value("Apache-2.0")
      .endObject()

    json.name("runtime").beginObject()
      .name("name").value("jvm")
      .name("version").value(
        s"${System.getProperty("java.version")} (${System.getProperty("java.vm.name")})"
      )
      .endObject()

    json.name("environment").beginObject()
      .name("cpuModel").value(environment.cpuModel)
      .name("logicalCores").value(environment.logicalCores.toLong)
      .name("memoryBytes").value(environment.memoryBytes)
      .name("os").value(environment.os)
      .name("date").value(environment.date)
      .name("actorTsVersion").value(environment.actorTsVersion)
      .name("actorTsCommit").value(environment.actorTsCommit)
      .endObject()

    json.name("scenarios").beginArray()
    for result <- results do
      json.beginObject()
        .name("scenario").value(result.scenario)
        .name("case").value(result.caseName)
        .name("unit").value(result.unit)
        .name("iterations").value(result.iterations.toLong)
        .name("opsPerIteration").value(result.opsPerIteration.toLong)
        .name("warmupIterations").value(result.warmupIterations.toLong)
        .name("totalNs").value(result.totalNs)
        .name("opsPerSecond").value(result.opsPerSecond)
        .name("perOperationNs").value(result.perOperationNs)
        .name("meanNs").value(result.meanNs)
        .name("stddevNs").value(result.stddevNs)
        .name("minNs").value(result.minNs)
        .name("maxNs").value(result.maxNs)
        .name("p50Ns").value(result.p50Ns)
        .name("p95Ns").value(result.p95Ns)
        .name("p99Ns").value(result.p99Ns)
        .name("expectedOperations").value(result.expectedOperations)
        .name("completedOperations").value(result.completedOperations)
      // ΔRSS is deliberately absent: a JVM heap against a JavaScript heap
      // measures the collector's appetite, not the framework's footprint.
      result.notes.foreach(note => json.name("notes").value(note))
      json.endObject()
    json.endArray()

    json.name("skippedScenarios").beginArray().endArray()

    json.endObject()
    json.writeTo(path)

    println(s"  wrote $path")
  end write

  /** Read from the package the classpath actually resolved, not from the build file. */
  private def pekkoVersion(): String =
    val fromManifest = Option(classOf[org.apache.pekko.actor.typed.ActorSystem[?]].getPackage)
      .flatMap(p => Option(p.getImplementationVersion))
    // The `_3` artifacts do not always carry an Implementation-Version in their
    // manifest the way the `_2.13` ones do, so the framework's own constant is
    // the fallback rather than the string "unknown" — a version column that
    // reads "unknown" tells a reader nothing about what was measured.
    fromManifest.getOrElse(org.apache.pekko.Version.current)

end ResultFile
