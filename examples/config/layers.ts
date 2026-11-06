/**
 * Layered configuration (#1785): a project `reference.conf` with the
 * project's defaults, an `application.conf` that overrides single keys of
 * it, and a `.env` file that supplies a secret to `${DB_PASSWORD}`.
 *
 *   bun run examples/config/layers.ts
 *   DB_PASSWORD=from-the-shell bun run examples/config/layers.ts
 *
 * The files are under `layers/` and named in code, so the example runs from
 * any directory; a project of its own names none of them and gets
 * `./reference.conf`, `./application.conf` and `./.env` from its working
 * directory.  The dump at the end is what `actor-ts.diagnostics.
 * log-config-on-start = on` writes at startup: every key with the layer it
 * came from and the variable behind it, and a value a credential-named
 * variable supplied withheld.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ActorSystem, ActorSystemOptions, configDumpLines, LogLevel, NoopLogger } from '../../src/index.js';

const layers = join(dirname(fileURLToPath(import.meta.url)), 'layers');

async function main(): Promise<void> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withReferenceConfigFile(join(layers, 'reference.conf'))
    .withConfigFile(join(layers, 'application.conf'))
    .withEnvironmentFile(join(layers, 'example.env'))
    // No secrets file in this example — and none read from wherever it runs.
    .withSecretsFile(false);
  const system = ActorSystem.create('config-layers', systemOptions);
  try {
    const config = system.config;
    console.log('GREETING        :', config.getString('my-app.greeting'));
    console.log('POOL SIZE       :', config.getInt('my-app.pool-size'), '(no value in application.conf, so reference.conf\'s)');
    console.log('DB HOST         :', config.getString('my-app.db.host'));
    console.log('PASSWORD LENGTH :', config.getString('my-app.db.password').length, 'characters, never printed');
    console.log();
    console.log('What the boot dump prints for these keys:');
    for (const line of configDumpLines(config).split('\n')) {
      if (line.startsWith('  my-app.')) console.log(line);
    }
  } finally {
    await system.terminate();
  }
}

void main();
