package comparison;

import java.time.LocalDate;

/**
 * The environment block, supplied by the driver rather than discovered here.
 *
 * <p>The JavaScript side already computes CPU model, core count, memory and the
 * actor-ts commit, and every arm of a run executes on the same machine in the
 * same session — so re-deriving them in Java would risk two arms describing one
 * machine differently (a JVM has no portable way to read a CPU model at all).
 * The driver passes them in; anything missing degrades to a value that is
 * visibly a fallback rather than a plausible-looking guess.
 */
public record EnvironmentBlock(
        String cpuModel, int logicalCores, long memoryBytes,
        String os, String date, String actorTsVersion, String actorTsCommit) {

    public static EnvironmentBlock fromDriver() {
        return new EnvironmentBlock(
                env("ACTOR_TS_COMPARISON_CPU", "unknown"),
                Integer.parseInt(env("ACTOR_TS_COMPARISON_CORES",
                        String.valueOf(Runtime.getRuntime().availableProcessors()))),
                Long.parseLong(env("ACTOR_TS_COMPARISON_MEMORY_BYTES", "0")),
                env("ACTOR_TS_COMPARISON_OS",
                        System.getProperty("os.name") + " " + System.getProperty("os.version")),
                env("ACTOR_TS_COMPARISON_DATE", LocalDate.now().toString()),
                env("ACTOR_TS_COMPARISON_VERSION", "unknown"),
                env("ACTOR_TS_COMPARISON_COMMIT", "unknown"));
    }

    private static String env(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }
}
