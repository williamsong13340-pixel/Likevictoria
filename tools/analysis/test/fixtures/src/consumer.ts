import { api, Handlers, makePoint, Panel, Rect, Runner, type Shape } from './sample.ts';

const shape: Shape = new Rect();
export const results = [
  api.go(1, 2),
  new Runner().run(1, 2),
  makePoint(1).x,
  shape.area(1, 2),
  new Handlers().bound(1),
  new Panel().onChange(1),
];
