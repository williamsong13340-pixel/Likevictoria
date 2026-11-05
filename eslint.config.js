import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import { builtinModules } from 'node:module';
import tseslint from 'typescript-eslint';

const DETERMINISM = '模拟内核必须是确定性的：随机数用带种子的生成器，时间用游戏时钟';
const LOCALE = '模拟内核的结果不能依赖主机的区域设置与时区';
const MATH_ALIAS =
  'Math 只能以 Math.函数名 的形式直接调用，不能赋值、传递、解构或用计算属性访问（这会绕过 Math.random 的禁令）';
// Globals through which the kernel could reach wall-clock time, entropy, the host, the garbage
// collector or a scheduler, or reach Math.random without naming it.
const NONDETERMINISTIC_GLOBALS = [
  'Date',
  'performance',
  'crypto',
  'process',
  'globalThis',
  'global',
  'window',
  'self',
  'require',
  'module',
  'eval',
  'Function',
  'Reflect',
  'WeakRef',
  'FinalizationRegistry',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'AbortSignal',
  'MessageChannel',
  'BroadcastChannel',
  'Worker',
  'Atomics',
  'SharedArrayBuffer',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'navigator',
  'location',
  'document',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'requestAnimationFrame',
];

export default defineConfig(
  { ignores: ['**/node_modules/', 'tools/analysis/test/fixtures/'] },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
  },
  {
    files: ['**/*.{ts,mts,cts}'],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['packages/sim/src/**/*.{ts,mts,cts,js,mjs,cjs}'],
    rules: {
      'no-console': 'error',
      // The common ways to reach wall-clock time, entropy or the host. This guards against
      // mistakes; it is not a sandbox.
      'no-restricted-globals': [
        'error',
        ...NONDETERMINISTIC_GLOBALS.map((name) => ({ name, message: DETERMINISM })),
        { name: 'Intl', message: LOCALE },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: builtinModules.map((name) => ({ name, message: DETERMINISM })),
          patterns: [{ group: ['node:*'], message: DETERMINISM }],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: DETERMINISM },
        // `[].constructor.constructor` reaches the Function constructor.
        { property: 'constructor', message: DETERMINISM },
        ...['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'localeCompare'].map(
          (property) => ({ property, message: LOCALE }),
        ),
      ],
      'no-restricted-syntax': [
        'error',
        { selector: 'ImportExpression', message: DETERMINISM },
        { selector: ':not(MemberExpression) > Identifier[name="Math"]', message: MATH_ALIAS },
        { selector: 'MemberExpression[object.name="Math"][computed=true]', message: MATH_ALIAS },
        ...[
          'Literal[value=/^(good|law|building|pm|tech|need)\\./]',
          'TemplateLiteral > TemplateElement[value.raw=/^(good|law|building|pm|tech|need)\\./]',
        ].map((selector) => ({
          selector,
          message:
            '模拟代码不能硬编码内容 ID：通过配方、需求类别或标签访问内容（见 docs/05-content-catalog.md）',
        })),
      ],
    },
  },
);
