/**
 * gbrain capture — the single human-facing entrypoint for getting content
 * into the brain. Replaces the confusion of "do I call put_page, commit
 * a file, or wait for autopilot?" with one command that just works.
 *
 *   gbrain capture "thought to remember"
 *   gbrain capture --file ./notes/2026-05-20.md
 *   echo "from stdin" | gbrain capture --stdin
 *   gbrain capture "..." --slug inbox/specific
 *   gbrain capture "..." --quiet           # slug-only output for pipelines
 *
 * Behavior:
 *   - Local install: writes to ~/.gbrain/inbox/<slug>.md OR routes through
 *     put_page (which now writes through to disk via the v0.38 plumbing).
 *     Synchronous result with the slug, status, content_hash, and queue
 *     job id (when applicable).
 *   - Thin-client install: routes through callRemoteTool('put_page', ...)
 *     so the server's daemon handles ingestion. Same UX, transparent to
 *     the caller.
 *
 * Default slug: `inbox/YYYY-MM-DD-<sha8-of-content>`. Stable for same
 * content (the daemon's 24h content-hash dedup will catch duplicates if
 * you re-capture the same thought twice).
 *
 * Output:
 *   - Default: 5-line receipt block (slug, ingested_at, source_kind,
 *     content_hash, queue job id where applicable).
 *   - --quiet: just the slug on stdout for shell pipelines like
 *     `JOB=$(gbrain capture "..." --quiet)`.
 *   - --json: structured response for agents.
 */

import { readFileSync } from 'node:fs';
import matter from 'gray-matter';
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, isThinClient } from '../core/config.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';
import { computeContentHash } from '../core/ingestion/types.ts';
import { operations } from '../core/operations.ts';
import type { OperationContext } from '../core/operations.ts';

interface RunOpts {
  content?: string;
  filePath?: string;
  stdin?: boolean;
  slug?: string;
  type?: string;
  source?: string;
  quiet?: boolean;
  json?: boolean;
}

function parseArgs(args: string[]): RunOpts | { help: true; positional: string | undefined } {
  const opts: RunOpts = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true, positional: undefined };
    if (a === '--quiet' || a === '-q') { opts.quiet = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--stdin') { opts.stdin = true; continue; }
    if (a === '--file') {
      const v = args[++i];
      if (v) opts.filePath = v;
      continue;
    }
    if (a === '--slug') {
      const v = args[++i];
      if (v) opts.slug = v;
      continue;
    }
    if (a === '--type') {
      const v = args[++i];
      if (v) opts.type = v;
      continue;
    }
    if (a === '--source') {
      const v = args[++i];
      if (v) opts.source = v;
      continue;
    }
    if (a.startsWith('--')) continue; // unknown flag, ignore
    positional.push(a);
  }
  if (positional.length > 0) {
    opts.content = positional.join(' ');
  }
  return opts;
}

const HELP = `Usage: gbrain capture [content] [options]

The single entrypoint for getting content into the brain. One command,
local OR thin-client, synchronous receipt with the resulting page slug.

Modes (mutually exclusive — first match wins):
  gbrain capture "thought"          inline content
  gbrain capture --file PATH        read content from a file
  gbrain capture --stdin            read content from stdin (piped)

Options:
  --slug SLUG          Override the default inbox/YYYY-MM-DD-<hash6> slug
  --type TYPE          Override the page type (default: note)
  --source ID          Multi-source brains: write under a non-default source
  --quiet, -q          Print just the slug on stdout (for shell pipelines)
  --json               JSON output for agents
  --help, -h           Show this help

Examples:
  gbrain capture "remember to follow up on the X deal"
  echo "from a pipe" | gbrain capture --stdin
  gbrain capture --file ./notes/today.md --slug daily/2026-05-20
  JOB=$(gbrain capture "..." --quiet)
`;

function defaultSlug(content: string, now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const hashPrefix = computeContentHash(content).slice(0, 8);
  return `inbox/${y}-${m}-${d}-${hashPrefix}`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Derive a title from the first non-empty, non-`---` line of the body,
 * stripping leading markdown heading marks, capped at 80 chars.
 * Falls back to 'Capture' when no usable line exists.
 */
function deriveTitle(rawBody: string): string {
  const firstLine = rawBody
    .split('\n')
    .find((l) => l.trim().length > 0 && l.trim() !== '---') ?? '';
  return firstLine.replace(/^#+\s*/, '').slice(0, 80) || 'Capture';
}

/**
 * v0.38.3.0 (BUG-1): merge capture's auto-stamped fields with any existing
 * frontmatter in `rawBody`, rather than always prepending a second
 * frontmatter block. The pre-fix code stamped its own `---` block on top
 * of files that already had frontmatter, producing `title: '---'` (the
 * file's opening delimiter became the outer title) and two consecutive
 * frontmatter blocks the parser interpreted as the outer block + a body
 * starting with a horizontal rule.
 *
 * Precedence rules (user-wins by default):
 *   - `type`:         opts.type (CLI flag) > userFm.type > 'note'
 *   - `title`:        userFm.title > derived-from-body
 *   - `captured_via`: userFm.captured_via > opts.source > 'capture-cli'
 *                     (CV3/Phase 3c will narrow this to always 'capture-cli';
 *                     for Phase 2a we preserve current semantics)
 *   - `captured_at`:  userFm.captured_at > now (user can pre-stamp for retroactive
 *                     captures; see CQ2 test case 4)
 *   - Any other user-declared keys (description, tags, slug, etc.) pass through verbatim.
 *
 * For files WITHOUT existing frontmatter, preserves the original behavior:
 * stamps a fresh frontmatter block, and if the body doesn't already look
 * like markdown (no `#` heading), wraps it under a `# {title}` heading.
 */
export function mergeCaptureFrontmatter(rawBody: string, opts: RunOpts): string {
  const nowIso = new Date().toISOString();
  // Detect frontmatter: leading `---\n` or `---\r\n`, tolerating leading BOM/whitespace.
  // We do NOT use the more permissive `startsWith('---')` because a body that opens
  // with a horizontal-rule like `--- separator ---` would false-positive.
  const trimmedStart = rawBody.replace(/^﻿/, '');
  const hasFrontmatter = /^---\r?\n/.test(trimmedStart);

  if (!hasFrontmatter) {
    // No existing frontmatter: stamp a fresh block and (if body lacks markdown
    // structure) wrap under a derived heading.
    const title = deriveTitle(rawBody);
    const fm: Record<string, unknown> = {
      type: opts.type ?? 'note',
      title,
      captured_via: opts.source ?? 'capture-cli',
      captured_at: nowIso,
    };
    const looksMarkdown = /^#{1,6}\s/.test(rawBody.trimStart());
    const body = looksMarkdown ? rawBody : `# ${title}\n\n${rawBody}`;
    return matter.stringify(body, fm);
  }

  // Existing frontmatter: parse, merge user-wins, re-emit as a SINGLE block.
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(rawBody);
  } catch (e) {
    throw new Error(
      `malformed frontmatter in capture input: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const userFm = (parsed.data ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {
    // Spread user's declared keys first so 'description', 'tags', etc. pass through.
    ...userFm,
    // Then apply auto-fields with the precedence rules above. The explicit
    // assignment AFTER the spread is intentional: it lets us implement the
    // mixed precedence (CLI flag wins for `type`; user wins for `title`/
    // `captured_via`/`captured_at`) in one expression per key.
    type: opts.type ?? userFm.type ?? 'note',
    title: userFm.title ?? deriveTitle(parsed.content),
    captured_via: userFm.captured_via ?? opts.source ?? 'capture-cli',
    captured_at: userFm.captured_at ?? nowIso,
  };
  return matter.stringify(parsed.content, merged);
}

/**
 * Build the put_page content (frontmatter + body). The user's --type and
 * the auto-stamped capture provenance go in the frontmatter so future
 * tools (e.g. the inbox triage UI) can find captures.
 *
 * v0.38.3.0: delegates to `mergeCaptureFrontmatter` so files with existing
 * frontmatter merge instead of double-wrap (BUG-1).
 */
function buildContent(rawBody: string, opts: RunOpts): string {
  return mergeCaptureFrontmatter(rawBody, opts);
}

interface CaptureResult {
  slug: string;
  status?: string;
  chunks?: number;
  content_hash: string;
  written?: boolean;
  path?: string;
  source_kind: string;
  captured_at: string;
}

function printReceipt(result: CaptureResult, quiet: boolean, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (quiet) {
    console.log(result.slug);
    return;
  }
  console.log('captured:');
  console.log(`  slug:          ${result.slug}`);
  console.log(`  status:        ${result.status ?? 'unknown'}`);
  console.log(`  content_hash:  ${result.content_hash.slice(0, 16)}…`);
  if (result.path) {
    console.log(`  file:          ${result.path}`);
  }
  console.log(`  captured_at:   ${result.captured_at}`);
}

export async function runCapture(engine: BrainEngine | null, args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if ('help' in parsed) {
    console.log(HELP);
    return;
  }

  // Resolve the source content.
  let rawBody: string;
  if (parsed.stdin) {
    rawBody = await readStdin();
  } else if (parsed.filePath) {
    try {
      rawBody = readFileSync(parsed.filePath, 'utf8');
    } catch (e) {
      console.error(
        `gbrain capture: failed to read ${parsed.filePath}: ${e instanceof Error ? e.message : String(e)}`,
      );
      process.exit(1);
    }
  } else if (parsed.content) {
    rawBody = parsed.content;
  } else {
    console.error('gbrain capture: provide content positionally, --file PATH, or --stdin');
    console.error('Run `gbrain capture --help` for examples.');
    process.exit(1);
  }

  rawBody = rawBody.trim();
  if (rawBody.length === 0) {
    console.error('gbrain capture: refusing to capture empty content');
    process.exit(1);
  }

  const slug = parsed.slug ?? defaultSlug(rawBody);
  const fullContent = buildContent(rawBody, parsed);
  const capturedAt = new Date().toISOString();
  const contentHash = computeContentHash(fullContent);

  // Thin-client install: route through put_page over MCP. The server's
  // write-through plumbing handles disk persistence.
  const cfg = loadConfig();
  if (isThinClient(cfg)) {
    let raw: unknown;
    try {
      raw = await callRemoteTool(
        cfg!,
        'put_page',
        { slug, content: fullContent },
        { timeoutMs: 30_000 },
      );
    } catch (e) {
      console.error(
        `gbrain capture: remote put_page failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      console.error('Run `gbrain remote doctor` to diagnose the connection.');
      process.exit(1);
    }
    const remoteResult = unpackToolResult<{
      slug: string;
      status?: string;
      chunks?: number;
      write_through?: { written: boolean; path?: string };
    }>(raw);
    const result: CaptureResult = {
      slug: remoteResult.slug,
      status: remoteResult.status,
      chunks: remoteResult.chunks,
      content_hash: contentHash,
      written: remoteResult.write_through?.written ?? false,
      path: remoteResult.write_through?.path,
      source_kind: parsed.source ?? 'capture-cli',
      captured_at: capturedAt,
    };
    printReceipt(result, parsed.quiet ?? false, parsed.json ?? false);
    return;
  }

  // Local install: route through put_page operation directly so we
  // exercise the same write-through path the MCP server uses.
  if (!engine) {
    console.error('gbrain capture: engine not connected');
    process.exit(1);
  }
  const putPageOp = operations.find((o) => o.name === 'put_page');
  if (!putPageOp) {
    console.error('gbrain capture: put_page operation missing (gbrain build issue)');
    process.exit(1);
  }
  const ctx: OperationContext = {
    engine,
    config: cfg ?? { engine: 'pglite' as const },
    logger: {
      info: (msg: string) => { process.stderr.write(`[capture] ${msg}\n`); },
      warn: (msg: string) => { process.stderr.write(`[capture] WARN: ${msg}\n`); },
      error: (msg: string) => { process.stderr.write(`[capture] ERROR: ${msg}\n`); },
    },
    dryRun: false,
    remote: false,
    // OperationContext.sourceId is REQUIRED as of v0.34.1 D4 — match the
    // dispatcher's behavior of defaulting to 'default' when the caller
    // didn't pass --source.
    sourceId: parsed.source ?? 'default',
  };
  try {
    const result = (await putPageOp.handler(ctx, { slug, content: fullContent })) as {
      slug: string;
      status?: string;
      chunks?: number;
      write_through?: { written: boolean; path?: string; skipped?: string };
    };
    printReceipt(
      {
        slug: result.slug,
        status: result.status,
        chunks: result.chunks,
        content_hash: contentHash,
        written: result.write_through?.written ?? false,
        path: result.write_through?.path,
        source_kind: parsed.source ?? 'capture-cli',
        captured_at: capturedAt,
      },
      parsed.quiet ?? false,
      parsed.json ?? false,
    );
  } catch (e) {
    console.error(
      `gbrain capture: put_page failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }
}

/** Test seam. */
export const __testing = {
  defaultSlug,
  buildContent,
  mergeCaptureFrontmatter,
  deriveTitle,
  parseArgs,
};
