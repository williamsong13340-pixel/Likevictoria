import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeProject } from '../src/analyze.ts';

describe('project static analysis', () => {
  const findings = analyzeProject(resolve(import.meta.dirname, 'fixtures/tsconfig.json'));
  const flagged = (rule: string): string[] =>
    findings
      .filter((f) => f.rule === rule)
      .map((f) => f.message.split(' ')[0] ?? '')
      .sort();

  it('flags members that production code writes but never reads', () => {
    expect(flagged('unread-member')).toEqual([
      'Clock.ticks', // read only to compute its own next value
      'Counter.count',
      'Settings.readInTestOnly',
      'Settings.typeOnly', // a type-level use is not a read
      'Settings.writtenOnly',
      'TABLE.unusedEntry',
      'Tally.total', // `+=` is a write
    ]);
  });

  it('flags functions that only forward their arguments, in any syntactic shape', () => {
    expect(flagged('pass-through')).toEqual([
      'alias', // a renamed method; the arrow fields that bind `this` are exempt
      'area', // the static Square.area; the instance one overrides its base and is exempt
      'awaited',
      'cast',
      'discarded',
      'forward',
      'go',
      'helper', // Square.area overrides its base and is exempt; helper is not required
      'makePoint',
      'run',
      'spread',
    ]);
  });

  it('reports repository-relative locations', () => {
    const lines = readFileSync(
      resolve(import.meta.dirname, 'fixtures/src/sample.ts'),
      'utf8',
    ).split('\n');
    const counter = findings.find((f) => f.message.startsWith('Counter.count'));
    expect(counter?.file).toBe('src/sample.ts');
    expect(lines[(counter?.line ?? 0) - 1]).toContain('private count');
  });
});
