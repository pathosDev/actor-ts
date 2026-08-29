package comparison

import java.nio.charset.StandardCharsets
import java.nio.file.{Files, Path}
import scala.collection.mutable

/**
 * A small JSON writer, so the only third-party code in this arm is the framework
 * under test.
 *
 * Pulling in a JSON library to emit one file would put an unrelated dependency
 * on the classpath of a benchmark whose subject is partly what a classpath
 * costs. The output must match the schema in
 * `benchmarks/comparison/js/result-file.ts` exactly — `report.ts` validates it
 * and refuses anything it does not recognise.
 *
 * Numbers go through `StringBuilder.append`, which is `Double.toString` /
 * `Long.toString` underneath — the same formatting the sibling Java arm
 * produces, so the two files differ in their measurements and nowhere else.
 */
final class JsonWriter:

  private val out = StringBuilder()

  /** One flag per open scope: has anything been written in it yet? */
  private val firstInScope = mutable.ArrayBuffer[Boolean]()

  def beginObject(): JsonWriter =
    separate()
    out.append('{')
    firstInScope += true
    this

  def endObject(): JsonWriter =
    out.append('}')
    firstInScope.remove(firstInScope.size - 1)
    this

  def beginArray(): JsonWriter =
    separate()
    out.append('[')
    firstInScope += true
    this

  def endArray(): JsonWriter =
    out.append(']')
    firstInScope.remove(firstInScope.size - 1)
    this

  def name(name: String): JsonWriter =
    separate()
    out.append(quote(name)).append(':')
    // The value that follows is part of this member, so it must not emit a
    // separator of its own.
    firstInScope(firstInScope.size - 1) = true
    this

  def value(value: String | Null): JsonWriter =
    out.append(if value == null then "null" else quote(value.nn))
    markWritten()
    this

  def value(value: Long): JsonWriter =
    out.append(value)
    markWritten()
    this

  def value(value: Double): JsonWriter =
    // Non-finite doubles are not valid JSON. They could only arrive here from a
    // division by an empty sample set, which is a bug worth seeing rather than
    // silently writing `null` into a throughput column.
    if value.isNaN || value.isInfinite then
      throw IllegalStateException(s"refusing to write a non-finite number: $value")
    out.append(value)
    markWritten()
    this

  private def separate(): Unit =
    if firstInScope.nonEmpty && !firstInScope(firstInScope.size - 1) then out.append(',')
    markWritten()

  private def markWritten(): Unit =
    if firstInScope.nonEmpty then firstInScope(firstInScope.size - 1) = false

  def writeTo(path: Path): Unit =
    Files.createDirectories(path.getParent)
    Files.writeString(path, out.toString + System.lineSeparator(), StandardCharsets.UTF_8)

end JsonWriter

private def quote(raw: String): String =
  val sb = StringBuilder(raw.length + 2)
  sb.append('"')
  for c <- raw do
    if c == '"' then sb.append('\\').append('"')
    else if c == '\\' then sb.append('\\').append('\\')
    else if c == '\n' then sb.append('\\').append('n')
    else if c == '\r' then sb.append('\\').append('r')
    else if c == '\t' then sb.append('\\').append('t')
    else if c < 0x20 then sb.append("\\u%04x".format(c.toInt))
    else sb.append(c)
  sb.append('"')
  sb.toString
