package comparison

import java.time.LocalDate

/**
 * The environment block, supplied by the driver rather than discovered here.
 *
 * The JavaScript side already computes CPU model, core count, memory and the
 * actor-ts commit, and every arm of a run executes on the same machine in the
 * same session — so re-deriving them here would risk two arms describing one
 * machine differently (a JVM has no portable way to read a CPU model at all).
 * The driver passes them in; anything missing degrades to a value that is
 * visibly a fallback rather than a plausible-looking guess.
 */
final case class EnvironmentBlock(
    cpuModel: String,
    logicalCores: Int,
    memoryBytes: Long,
    os: String,
    date: String,
    actorTsVersion: String,
    actorTsCommit: String,
)

object EnvironmentBlock:

  def fromDriver(): EnvironmentBlock = EnvironmentBlock(
    env("ACTOR_TS_COMPARISON_CPU", "unknown"),
    env("ACTOR_TS_COMPARISON_CORES", Runtime.getRuntime.availableProcessors().toString).toInt,
    env("ACTOR_TS_COMPARISON_MEMORY_BYTES", "0").toLong,
    env("ACTOR_TS_COMPARISON_OS", s"${System.getProperty("os.name")} ${System.getProperty("os.version")}"),
    env("ACTOR_TS_COMPARISON_DATE", LocalDate.now().toString),
    env("ACTOR_TS_COMPARISON_VERSION", "unknown"),
    env("ACTOR_TS_COMPARISON_COMMIT", "unknown"),
  )

  private def env(name: String, fallback: String): String =
    val value = System.getenv(name)
    if value == null || value.isBlank then fallback else value

end EnvironmentBlock
