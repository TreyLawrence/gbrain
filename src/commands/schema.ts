// v0.38 Phase C — `gbrain schema` CLI surface.
//
// Five essential subcommands ship in v0.38:
//   gbrain schema active                 — show resolved pack + tier source
//   gbrain schema list                   — list installed packs
//   gbrain schema show [<pack>]          — pretty-print manifest
//   gbrain schema validate [<pack>]      — validate manifest shape
//   gbrain schema use <pack>             — activate pack (file-plane)
//
// Deferred to v0.39+:
//   init, fork, edit, diff, detect, suggest, review-candidates,
//   review-orphans, graph, lint, explain
//
// The active pack drives type inference, link verbs, expert routing,
// extractable types, enrichment rubrics, and per-source closure for
// search. See `src/core/schema-pack/load-active.ts` for the boundary
// helper that all engines + operations consume.

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  loadActivePack,
  resolveActivePackNameOnly,
  loadPackFromFile,
  parseSchemaPackManifest,
  SchemaPackManifestError,
  SchemaPackLoaderError,
  UnknownPackError,
  __setPackLocatorForTests,
  _resetPackLocatorForTests,
} from '../core/schema-pack/index.ts';
import { gbrainPath, loadConfig, configPath } from '../core/config.ts';

export async function runSchema(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case 'active':   return runActive(args.slice(1));
    case 'list':     return runList(args.slice(1));
    case 'show':     return runShow(args.slice(1));
    case 'validate': return runValidate(args.slice(1));
    case 'use':      return runUse(args.slice(1));
    case undefined:
    case '--help':
    case '-h':
      return printHelp();
    default:
      console.error(`Unknown schema subcommand: ${sub}`);
      console.error('Run `gbrain schema --help` for available commands.');
      process.exit(2);
  }
}

function printHelp(): void {
  console.log(`gbrain schema — active schema pack management

Subcommands:
  active                  Show resolved pack + which tier provided it
  list                    List installed packs (bundled + ~/.gbrain/schema-packs/)
  show [<pack>]           Pretty-print a manifest (default: active pack)
  validate [<pack>]       Validate manifest shape against the v0.38 schema
  use <pack>              Activate pack (writes ~/.gbrain/config.json schema_pack)

v0.38 ships the schema-pack engine + these five inspection/activation
commands. detect, suggest, init, fork, edit, graph, lint, explain,
review-candidates, review-orphans, and diff land in v0.39.

Resolution chain (D13 7-tier, tier 1 trust-gated):
  1. Per-call --schema-pack flag (CLI only)
  2. GBRAIN_SCHEMA_PACK env var
  3. Per-source DB config schema_pack.source.<id>
  4. Brain-wide DB config schema_pack
  5. gbrain.yml schema: section
  6. ~/.gbrain/config.json schema_pack
  7. Default: gbrain-base
`);
}

async function runActive(_args: string[]): Promise<void> {
  const cfg = loadConfig();
  const resolution = resolveActivePackNameOnly({ cfg, remote: false });
  const pack = await loadActivePack({ cfg, remote: false });
  console.log(`Active pack: ${pack.manifest.name} v${pack.manifest.version}`);
  console.log(`Source: ${resolution.source}`);
  console.log(`Pack identity: ${pack.identity}`);
  console.log(`Page types: ${pack.manifest.page_types.length}`);
  console.log(`Link verbs: ${pack.manifest.link_types.length}`);
  console.log(`Takes kinds: ${pack.manifest.takes_kinds.join(', ')}`);
  if (pack.manifest.description) {
    console.log(`\n${pack.manifest.description}`);
  }
}

function runList(_args: string[]): void {
  const bundled = ['gbrain-base'];
  const installedDir = gbrainPath('schema-packs');
  const installed: string[] = [];
  if (existsSync(installedDir)) {
    for (const entry of readdirSync(installedDir)) {
      const candidates = ['pack.yaml', 'pack.yml', 'pack.json'];
      for (const c of candidates) {
        if (existsSync(join(installedDir, entry, c))) {
          installed.push(entry);
          break;
        }
      }
    }
  }
  console.log('Bundled packs:');
  for (const name of bundled) console.log(`  ${name}`);
  if (installed.length > 0) {
    console.log('\nInstalled packs (~/.gbrain/schema-packs/):');
    for (const name of installed) console.log(`  ${name}`);
  } else {
    console.log('\nNo user-installed packs (~/.gbrain/schema-packs/ empty or missing).');
  }
}

async function runShow(args: string[]): Promise<void> {
  const packName = args[0];
  let manifest;
  if (packName) {
    const path = packPathByName(packName);
    if (!path) {
      console.error(`Unknown pack: ${packName}`);
      console.error('Run `gbrain schema list` to see available packs.');
      process.exit(1);
    }
    manifest = loadPackFromFile(path);
  } else {
    const pack = await loadActivePack({ cfg: loadConfig(), remote: false });
    manifest = pack.manifest;
  }
  console.log(`# ${manifest.name} v${manifest.version}`);
  if (manifest.description) console.log(`# ${manifest.description}`);
  console.log(`# extends: ${manifest.extends ?? 'null (no parent)'}`);
  console.log();
  console.log(`Page types (${manifest.page_types.length}):`);
  for (const pt of manifest.page_types) {
    const flags: string[] = [];
    if (pt.extractable) flags.push('extractable');
    if (pt.expert_routing) flags.push('expert');
    const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
    const prefixStr = pt.path_prefixes.length > 0 ? ` (${pt.path_prefixes.join(', ')})` : '';
    const aliasStr = pt.aliases.length > 0 ? ` aliases:[${pt.aliases.join(', ')}]` : '';
    console.log(`  ${pt.name} :: ${pt.primitive}${prefixStr}${aliasStr}${flagStr}`);
  }
  console.log();
  console.log(`Link verbs (${manifest.link_types.length}):`);
  for (const lt of manifest.link_types) {
    const inferenceStr = lt.inference
      ? lt.inference.page_type
        ? ` (page_type: ${lt.inference.page_type})`
        : lt.inference.regex
          ? ` (regex)`
          : ''
      : '';
    console.log(`  ${lt.name}${inferenceStr}`);
  }
  console.log();
  console.log(`Takes kinds: ${manifest.takes_kinds.join(', ')}`);
  console.log(`Enrichable types: ${manifest.enrichable_types.map(e => e.type).join(', ') || '(none)'}`);
}

function runValidate(args: string[]): void {
  const packName = args[0];
  let path: string | null;
  if (packName) {
    path = packPathByName(packName);
    if (!path) {
      console.error(`Unknown pack: ${packName}`);
      process.exit(1);
    }
  } else {
    path = packPathByName('gbrain-base');
    if (!path) {
      console.error('No active pack — provide a pack name.');
      process.exit(1);
    }
  }
  try {
    const manifest = loadPackFromFile(path);
    console.log(`✓ ${manifest.name} v${manifest.version}: valid manifest`);
    console.log(`  Path: ${path}`);
    console.log(`  Page types: ${manifest.page_types.length}`);
    console.log(`  Link verbs: ${manifest.link_types.length}`);
    console.log(`  Takes kinds: ${manifest.takes_kinds.length}`);
  } catch (e) {
    if (e instanceof SchemaPackManifestError) {
      console.error(`✗ Invalid manifest at ${path}`);
      console.error(`  Code: ${e.code}`);
      console.error(`  ${e.message}`);
      process.exit(1);
    } else if (e instanceof SchemaPackLoaderError) {
      console.error(`✗ Loader error at ${e.path}`);
      console.error(`  ${e.message}`);
      process.exit(1);
    } else {
      throw e;
    }
  }
}

function runUse(args: string[]): void {
  const packName = args[0];
  if (!packName) {
    console.error('Usage: gbrain schema use <pack-name>');
    process.exit(2);
  }
  const path = packPathByName(packName);
  if (!path) {
    console.error(`Unknown pack: ${packName}`);
    console.error('Run `gbrain schema list` to see available packs.');
    process.exit(1);
  }
  // Validate before activating — refuse to set a broken pack.
  try {
    loadPackFromFile(path);
  } catch (e) {
    console.error(`Refusing to activate ${packName}: ${(e as Error).message}`);
    process.exit(1);
  }
  // Write to file-plane config (~/.gbrain/config.json schema_pack field).
  // Tier 6 in the resolution chain — tiers 1-5 (per-call, env, DB) can
  // still override this without editing the file.
  const cfg = loadConfig() ?? { engine: 'pglite' as const };
  const updated = { ...cfg, schema_pack: packName };
  const cfgPath = configPath();
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
  console.log(`✓ Active schema pack set to: ${packName}`);
  console.log(`  Written to: ${cfgPath}`);
  console.log(`\nRun \`gbrain schema active\` to verify resolution.`);
}

function packPathByName(name: string): string | null {
  if (name === 'gbrain-base') {
    // Resolve bundled YAML — try a few locations.
    const here = dirname(new URL(import.meta.url).pathname);
    const candidates = [
      join(here, '..', 'core', 'schema-pack', 'base', 'gbrain-base.yaml'),
      join(here, '..', '..', 'src', 'core', 'schema-pack', 'base', 'gbrain-base.yaml'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return null;
  }
  const baseDir = gbrainPath('schema-packs', name);
  for (const c of ['pack.yaml', 'pack.yml', 'pack.json']) {
    const candidate = join(baseDir, c);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Test seam — let unit tests inject the locator if needed.
export const _testHelpers = {
  __setPackLocatorForTests,
  _resetPackLocatorForTests,
  packPathByName,
};
