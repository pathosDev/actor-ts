package comparison;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * A small JSON writer, so the only third-party code in this arm is the framework
 * under test.
 *
 * <p>Pulling in Jackson or Gson to emit one file would put an unrelated library
 * on the classpath of a benchmark whose subject is partly what a classpath
 * costs. The output must match the schema in
 * {@code benchmarks/comparison/js/result-file.ts} exactly — {@code report.ts}
 * validates it and refuses anything it does not recognise.
 */
public final class JsonWriter {

    private final StringBuilder out = new StringBuilder();

    /** One flag per open scope: has anything been written in it yet? */
    private final List<Boolean> firstInScope = new ArrayList<>();

    public JsonWriter beginObject() {
        separate();
        out.append('{');
        firstInScope.add(Boolean.TRUE);
        return this;
    }

    public JsonWriter endObject() {
        out.append('}');
        firstInScope.remove(firstInScope.size() - 1);
        return this;
    }

    public JsonWriter beginArray() {
        separate();
        out.append('[');
        firstInScope.add(Boolean.TRUE);
        return this;
    }

    public JsonWriter endArray() {
        out.append(']');
        firstInScope.remove(firstInScope.size() - 1);
        return this;
    }

    public JsonWriter name(String name) {
        separate();
        out.append(quote(name)).append(':');
        // The value that follows is part of this member, so it must not emit a
        // separator of its own.
        firstInScope.set(firstInScope.size() - 1, Boolean.TRUE);
        return this;
    }

    public JsonWriter value(String value) {
        out.append(value == null ? "null" : quote(value));
        markWritten();
        return this;
    }

    public JsonWriter value(long value) {
        out.append(value);
        markWritten();
        return this;
    }

    public JsonWriter value(double value) {
        // Non-finite doubles are not valid JSON. They could only arrive here from
        // a division by an empty sample set, which is a bug worth seeing rather
        // than silently writing `null` into a throughput column.
        if (Double.isNaN(value) || Double.isInfinite(value)) {
            throw new IllegalStateException("refusing to write a non-finite number: " + value);
        }
        out.append(value);
        markWritten();
        return this;
    }

    private void separate() {
        if (!firstInScope.isEmpty() && Boolean.FALSE.equals(firstInScope.get(firstInScope.size() - 1))) {
            out.append(',');
        }
        markWritten();
    }

    private void markWritten() {
        if (!firstInScope.isEmpty()) {
            firstInScope.set(firstInScope.size() - 1, Boolean.FALSE);
        }
    }

    private static String quote(String raw) {
        StringBuilder sb = new StringBuilder(raw.length() + 2);
        sb.append('"');
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c == '"') {
                sb.append('\\').append('"');
            } else if (c == '\\') {
                sb.append('\\').append('\\');
            } else if (c == '\n') {
                sb.append('\\').append('n');
            } else if (c == '\r') {
                sb.append('\\').append('r');
            } else if (c == '\t') {
                sb.append('\\').append('t');
            } else if (c < 0x20) {
                sb.append(String.format("\\u%04x", (int) c));
            } else {
                sb.append(c);
            }
        }
        sb.append('"');
        return sb.toString();
    }

    public void writeTo(Path path) throws IOException {
        Files.createDirectories(path.getParent());
        Files.writeString(path, out + System.lineSeparator(), StandardCharsets.UTF_8);
    }
}
