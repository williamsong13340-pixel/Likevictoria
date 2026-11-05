// Fixture for the analyzer test: some members and functions here are deliberately useless.
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
