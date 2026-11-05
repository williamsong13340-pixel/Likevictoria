import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeProject } from '../src/analyze.ts';

describe('project static analysis', () => {
  const findings = analyzeProject(resolve(import.meta.dirname, 'fixtures/tsconfig.json'));
  const flagged = (rule: string): string[] =>
    findings.filter((f) => f.rule === rule).map((f) => f.message.split(' ')[0] ?? '');

  it('flags members that production code writes but never reads', () => {
    expect(flagged('unread-member').sort()).toEqual([
      'Counter.count',
      'Settings.readInTestOnly',
      'Settings.typeOnly',
      'Settings.writtenOnly',
    ]);
  });

  it('flags functions that only forward their parameters', () => {
    expect(flagged('pass-through')).toEqual(['forward']);
  });

  it('reports repository-relative locations', () => {
    const counter = findings.find((f) => f.message.startsWith('Counter.count'));
    expect(counter?.file).toBe('src/sample.ts');
    expect(counter?.line).toBe(35);
  });
});
