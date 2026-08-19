package comparison;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;

/**
 * Emits the result file in the schema defined by
 * {@code benchmarks/comparison/js/result-file.ts}.
 *
 * <p>The schema is a specification rather than a consequence of the TypeScript
 * implementation, which is exactly why this arm can satisfy it by hand.
 * {@code report.ts} refuses a file whose {@code schemaVersion} it does not
 * recognise, whose completed work disagrees with what was requested, or whose
 * batch sizes disagree with {@code js/workload.ts} — so a mistake here fails
 * the publication step rather than reaching a table.
 */
final class ResultFile {

    private static final int SCHEMA_VERSION = 1;

    private ResultFile() {}

    static void write(
            List<Harness.ScenarioResult> results,
            EnvironmentBlock environment,
            Path path) throws IOException {

        JsonWriter json = new JsonWriter();
        json.beginObject();

        json.name("schemaVersion").value(SCHEMA_VERSION);

        json.name("framework").beginObject()
                // The binding is part of the identity: the same framework at the
                // same version is also measured through its Scala 3 API, and two
                // arms called "pekko" would collide on the published file name.
                // `Main.outputPath()` spells the derived name out — keep them in
                // step.
                .name("name").value("pekko-java")
                .name("version").value(pekkoVersion())
                .name("language").value("Java")
                // Apache-2.0 — the licence is the reason this arm exists next to the other
                // JVM one, which is BUSL-1.1. Same lineage, different terms, and that
                // difference decides real adoption questions.
                .name("license").value("Apache-2.0")
                .endObject();

        json.name("runtime").beginObject()
                .name("name").value("jvm")
                .name("version").value(System.getProperty("java.version")
                        + " (" + System.getProperty("java.vm.name") + ")")
                .endObject();

        json.name("environment").beginObject()
                .name("cpuModel").value(environment.cpuModel())
                .name("logicalCores").value(environment.logicalCores())
                .name("memoryBytes").value(environment.memoryBytes())
                .name("os").value(environment.os())
                .name("date").value(environment.date())
                .name("actorTsVersion").value(environment.actorTsVersion())
                .name("actorTsCommit").value(environment.actorTsCommit())
                .endObject();

        json.name("scenarios").beginArray();
        for (Harness.ScenarioResult result : results) {
            json.beginObject()
                    .name("scenario").value(result.scenario())
                    .name("case").value(result.caseName())
                    .name("unit").value(result.unit())
                    .name("iterations").value(result.iterations())
                    .name("opsPerIteration").value(result.opsPerIteration())
                    .name("warmupIterations").value(result.warmupIterations())
                    .name("totalNs").value(result.totalNs())
                    .name("opsPerSecond").value(result.opsPerSecond())
                    .name("perOperationNs").value(result.perOperationNs())
                    .name("meanNs").value(result.meanNs())
                    .name("stddevNs").value(result.stddevNs())
                    .name("minNs").value(result.minNs())
                    .name("maxNs").value(result.maxNs())
                    .name("p50Ns").value(result.p50Ns())
                    .name("p95Ns").value(result.p95Ns())
                    .name("p99Ns").value(result.p99Ns())
                    .name("expectedOperations").value(result.expectedOperations())
                    .name("completedOperations").value(result.completedOperations());
            // ΔRSS is deliberately absent: a JVM heap against a JavaScript heap
            // measures the collector's appetite, not the framework's footprint.
            if (result.notes() != null) {
                json.name("notes").value(result.notes());
            }
            json.endObject();
        }
        json.endArray();

        json.name("skippedScenarios").beginArray().endArray();

        json.endObject();
        json.writeTo(path);

        System.out.println("  wrote " + path);
    }

    /** Read from the package the classpath actually resolved, not from the pom. */
    private static String pekkoVersion() {
        Package pekkoPackage = org.apache.pekko.actor.typed.ActorSystem.class.getPackage();
        String version = pekkoPackage == null ? null : pekkoPackage.getImplementationVersion();
        return version == null ? "unknown" : version;
    }
}
