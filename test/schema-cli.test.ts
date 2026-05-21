// v0.38 Phase C: gbrain schema CLI smoke tests.
//
// Tests the runSchema dispatch + each subcommand's output shape via
// the public CLI entrypoint. Hermetic — uses Bun's subprocess to run
// the CLI like a user would.

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');

function gbrain(args: string[]): { stdout: string; stderr: string; code: number } {
  const result = spawnSync('bun', ['run', 'src/cli.ts', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status ?? -1,
  };
}

describe('gbrain schema CLI (Phase C)', () => {
  test('schema with no subcommand shows help text', () => {
    // Note: `schema --help` is intercepted by the CLI's parent help system
    // and prints generic help (`gbrain --help` for full command list). The
    // schema-specific help fires when no subcommand is provided.
    const r = gbrain(['schema']);
    expect(r.stdout + r.stderr).toMatch(/schema|active|list|show|validate|use/i);
  });

  test('schema list shows gbrain-base bundled', () => {
    const r = gbrain(['schema', 'list']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Bundled packs:');
    expect(r.stdout).toContain('gbrain-base');
  });

  test('schema show gbrain-base prints manifest details', () => {
    const r = gbrain(['schema', 'show', 'gbrain-base']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('gbrain-base v1.0.0');
    expect(r.stdout).toContain('Page types (22)');
    expect(r.stdout).toContain('Link verbs (12)');
    expect(r.stdout).toContain('Takes kinds: fact, take, bet, hunch');
    expect(r.stdout).toContain('person :: entity');
    expect(r.stdout).toContain('company :: entity');
  });

  test('schema validate gbrain-base passes', () => {
    const r = gbrain(['schema', 'validate', 'gbrain-base']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('✓');
    expect(r.stdout).toContain('valid manifest');
  });

  test('schema active reports default resolution', () => {
    const r = gbrain(['schema', 'active']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Active pack:');
    expect(r.stdout).toContain('Pack identity:');
  });

  test('schema show unknown-pack errors with hint', () => {
    const r = gbrain(['schema', 'show', 'nonexistent-pack']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('Unknown pack');
    expect(r.stderr).toContain('schema list');
  });

  test('unknown subcommand exits with hint', () => {
    const r = gbrain(['schema', 'frobnicate']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unknown schema subcommand');
  });

  test('schema use without arg shows usage hint', () => {
    const r = gbrain(['schema', 'use']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Usage:');
  });
});
