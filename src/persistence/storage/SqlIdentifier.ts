/**
 * Assert that `name` is a safe SQL/CQL identifier (table name, keyspace, …).
 *
 * Identifiers cannot be passed as bound parameters, so backends interpolate
 * them straight into DDL/DML.  An identifier sourced from configuration must
 * therefore be validated or it becomes an injection vector (SECURITY_AUDIT.md
 * #6).  Shared by the SQLite and Cassandra backends; Postgres/MariaDB carry
 * their own equivalent in their client modules.
 */
export function assertSafeIdentifier(name: string, what: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `unsafe ${what} identifier ${JSON.stringify(name)} — must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
    );
  }
  return name;
}
