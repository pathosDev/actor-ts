import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { DEFAULT_PHASE_TIMEOUT_MS } from '../../../src/Constants.js';
import { Phases } from '../../../src/CoordinatedShutdown.js';
import { endpointsPath } from '../../../src/discovery/KubernetesApiSeedProvider.js';

/**
 * The Kubernetes recipe runs as printed (#1012, #1013).
 *
 * `operations/deployment/kubernetes.mdx` is the page people copy into a
 * cluster, and it had drifted from the code it drives in two independent ways:
 *
 * - **Discovery (#1013).**  The Role granted `pods` while
 *   `KubernetesApiSeedProvider` reads one `Endpoints` object, so the request
 *   answered 403 and the cluster never formed; the app sample read
 *   `K8S_SERVICE_NAME` and the manifest never set it, and set a
 *   `K8S_LABEL_SELECTOR` that nothing reads.
 * - **Shutdown budget (#1012).**  The manifest gave 30 s of grace and spent 10
 *   of them in `preStop`, while the coordinated shutdown it triggers runs its
 *   phases one after another, each up to `default-phase-timeout`.
 *
 * So the page is held to the source, in both languages:
 *
 * - the Role grants `get` on the resource `endpointsPath` addresses;
 * - every variable the app sample reads is set in the manifest, and every
 *   variable the manifest sets is read by the sample or by `src/`;
 * - the service name the sample passes to the provider is the headless
 *   Service the manifest defines;
 * - `terminationGracePeriodSeconds` covers the `preStop` sleep plus one
 *   phase timeout for every row of the page's phase table, the table names
 *   only canonical phases and at least the ones the framework wires for the
 *   page's app, and no other value of the setting is quoted as the recipe's.
 *
 * What this cannot see: a task the page's app registers that the table does
 * not list, and whether a phase the table lists really holds a task.
 */

const REPOSITORY_ROOT = join(import.meta.dir, '..', '..', '..');
const DOCUMENTATION_ROOT = join(REPOSITORY_ROOT, 'docs', 'src', 'content', 'docs');

const PAGES = [
  { language: 'en', path: join(DOCUMENTATION_ROOT, 'operations', 'deployment', 'kubernetes.mdx') },
  { language: 'de', path: join(DOCUMENTATION_ROOT, 'de', 'operations', 'deployment', 'kubernetes.mdx') },
] as const;

/**
 * Phases the framework itself fills for the page's app — two `bind()` calls
 * and a `Cluster.join` — whatever the operator registers:
 * `HttpExtension` (service-unbind), `Cluster.join` (sharding hand-off and
 * leave), and the built-in terminator (actor-system-terminate).
 */
const WIRED_FOR_THE_PAGE_APP: ReadonlyArray<string> = [
  Phases.ServiceUnbind,
  Phases.ClusterShardingShutdownRegion,
  Phases.ClusterLeave,
  Phases.ActorSystemTerminate,
];

/**
 * Manifest variables nothing in the framework or the sample reads, each with
 * why it is there anyway.
 */
const USER_VARIABLES: Readonly<Record<string, string>> = {
  DB_PASSWORD: 'the application\'s own credential — what the "Secrets as a mounted file" section replaces',
};

function readNormalised(path: string): string {
  return readFileSync(path, 'utf8').split(/\r?\n/).join('\n');
}

function fences(text: string, language: string): string[] {
  return [...text.matchAll(new RegExp(`^\`\`\`${language}\\n([\\s\\S]*?)^\`\`\``, 'gm'))].map((m) => m[1]!);
}

/** The manifest: the first `yaml` fence, split into its documents. */
function manifestDocuments(text: string): string[] {
  return fences(text, 'yaml')[0]!.split(/^---$/m);
}

function documentOfKind(documents: ReadonlyArray<string>, kind: string): string[] {
  return documents.filter((document) => new RegExp(`^kind: ${kind}$`, 'm').test(document));
}

function metadataName(document: string): string {
  return /^metadata:\n\s+name: (\S+)/m.exec(document)![1]!;
}

/** `- name: X` entries with their literal `value:` when the next line has one. */
function environment(statefulSet: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const match of statefulSet.matchAll(/^\s+- name: ([A-Z][A-Z0-9_]*)\n(?:\s+value: "?([^"\s#]+)"?)?/gm)) {
    out.set(match[1]!, match[2]);
  }
  return out;
}

/** The app sample: the `ts` fence that constructs the seed provider. */
function appSample(text: string): string {
  return fences(text, 'ts').find((fence) => fence.includes('new KubernetesApiSeedProvider('))!;
}

/** The rows of the phase table under the grace-period heading. */
function phaseTableRows(text: string): string[] {
  const start = text.indexOf('### `terminationGracePeriodSeconds`');
  const section = text.slice(start, text.indexOf('\n### ', start + 1));
  return [...section.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]!);
}

function sourceTextUnder(directory: string): string {
  let out = '';
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out += sourceTextUnder(path);
    else if (entry.name.endsWith('.ts')) out += readFileSync(path, 'utf8');
  }
  return out;
}

describe('Kubernetes recipe (#1012, #1013)', () => {
  // The framework reads its variables by literal name, so a substring search
  // over the source is enough to tell a read variable from a dead one.
  const source = sourceTextUnder(join(REPOSITORY_ROOT, 'src'));

  for (const page of PAGES) {
    const text = readNormalised(page.path);
    const documents = manifestDocuments(text);
    const statefulSet = documentOfKind(documents, 'StatefulSet')[0]!;
    const env = environment(statefulSet);
    const sample = appSample(text);

    test(`${page.language}: the Role grants get on the resource the provider requests`, () => {
      const resource = endpointsPath('namespace', 'service').split('/')[5];
      expect(resource).toBe('endpoints');
      const role = documentOfKind(documents, 'Role')[0]!;
      expect(/resources: \[([^\]]*)\]/.exec(role)![1]!.split(',').map((s) => s.trim().replace(/"/g, ''))).toContain(resource);
      expect(/verbs: \[([^\]]*)\]/.exec(role)![1]).toContain('"get"');
      const binding = documentOfKind(documents, 'RoleBinding')[0]!;
      expect(/roleRef:\n\s+kind: Role\n\s+name: (\S+)/.exec(binding)![1]).toBe(metadataName(role));
    });

    test(`${page.language}: every variable the app sample reads is set in the manifest`, () => {
      const read = [...sample.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!);
      expect(read.length).toBeGreaterThanOrEqual(3);
      expect(read.filter((name) => !env.has(name))).toEqual([]);
    });

    test(`${page.language}: every variable the manifest sets is read by the sample or by src/`, () => {
      const unread = [...env.keys()].filter((name) =>
        !sample.includes(`process.env.${name}`) && !(name in USER_VARIABLES) && !source.includes(name));
      expect(unread).toEqual([]);
    });

    test(`${page.language}: the provider is pointed at the headless Service`, () => {
      const headless = documentOfKind(documents, 'Service').filter((document) => /clusterIP: None/.test(document));
      expect(headless.length).toBe(1);
      const variable = /\.withServiceName\(process\.env\.([A-Z][A-Z0-9_]*)!\)/.exec(sample)![1]!;
      expect(env.get(variable)).toBe(metadataName(headless[0]!));
    });

    test(`${page.language}: the grace period covers preStop plus every phase in the table`, () => {
      const grace = Number(/terminationGracePeriodSeconds: (\d+)/.exec(statefulSet)![1]);
      const preStop = Number(/"sleep (\d+)"/.exec(statefulSet)![1]);
      const rows = phaseTableRows(text);
      const canonical: ReadonlyArray<string> = Object.values(Phases);
      expect(rows.filter((phase) => !canonical.includes(phase))).toEqual([]);
      expect(WIRED_FOR_THE_PAGE_APP.filter((phase) => !rows.includes(phase))).toEqual([]);
      expect(grace).toBeGreaterThanOrEqual(preStop + rows.length * (DEFAULT_PHASE_TIMEOUT_MS / 1000));
    });

    test(`${page.language}: the page quotes no other grace period as the recipe's`, () => {
      const grace = /terminationGracePeriodSeconds: (\d+)/.exec(statefulSet)![1];
      const quoted = [...text.matchAll(/terminationGracePeriodSeconds: (\d+)(.*)$/gm)]
        .filter((m) => !m[2]!.includes('✗'))
        .map((m) => m[1]);
      expect(quoted.filter((value) => value !== grace)).toEqual([]);
    });
  }
});
