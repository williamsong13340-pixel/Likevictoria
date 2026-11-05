// Fixture for the analyzer test: some members and functions here are deliberately useless.

/** Settings for the fixture; see {@link Settings.used}. */
export interface Settings {
  readonly used: number;
  readonly writtenOnly: number;
  readonly readInTestOnly: number;
  readonly destructured: number;
  readonly typeOnly: number;
}

export type Width = Settings['typeOnly'];

export const SETTINGS: Settings = {
  used: 1,
  writtenOnly: 2,
  readInTestOnly: 3,
  destructured: 4,
  typeOnly: 5,
};

export function total({ destructured }: Settings): number {
  return SETTINGS.used + destructured;
}

function add(a: number, b: number): number {
  return a + b;
}

export function forward(a: number, b: number): number {
  return add(a, b);
}

export const shifted = (a: number): number => add(a, 1);

export class Counter {
  private count = 0;
  bump(): void {
    this.count = 1;
  }
}

// Writes that look like reads.
export interface Tally {
  total: number;
}
export function record(t: Tally): void {
  t.total += 1;
}

export interface Clock {
  readonly ticks: number;
}
export function tick(c: Clock): Clock {
  return { ticks: c.ticks + 1 };
}

// Object constants.
const TABLE = { usedEntry: 1, unusedEntry: 2 };
export const picked = TABLE.usedEntry;

const LABELS = { a: 'x', b: 'y' };
export const label = (key: 'a' | 'b'): string => LABELS[key];

// More forwarding shapes.
function sum(...values: number[]): number {
  return values.reduce((s, v) => s + v, 0);
}
export const spread = (...values: number[]): number => sum(...values);
export class Runner {
  run = (a: number, b: number): number => add(a, b);
}
export const api = { go: (a: number, b: number): number => add(a, b) };
export function cast(a: number, b: number): number {
  return add(a, b) as number;
}
class Point {
  x: number;
  constructor(x: number) {
    this.x = x;
  }
}
export const makePoint = (x: number): Point => new Point(x);

// Not forwarding: a default argument adds something, and a contract may require the method.
export function withDefault(a: number, b = 2): number {
  return add(a, b);
}
export interface Shape {
  area(w: number, h: number): number;
}
export class Rect implements Shape {
  area(w: number, h: number): number {
    return add(w, h);
  }
}
