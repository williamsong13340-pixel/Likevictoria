import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const DETERMINISM = '模拟内核必须是确定性的：随机数用带种子的生成器，时间用游戏时钟';

export default defineConfig(
  { ignores: ['**/node_modules/', 'tools/analysis/test/fixtures/'] },
  {
    files: ['**/*.js'],
    extends: [js.configs.recommended],
  },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['packages/sim/src/**/*.ts'],
    rules: {
      'no-console': 'error',
      // Every source of wall-clock time or entropy, however it is reached.
      'no-restricted-globals': [
        'error',
        ...['Date', 'performance', 'crypto', 'process', 'globalThis', 'window', 'self'].map(
          (name) => ({ name, message: DETERMINISM }),
        ),
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: DETERMINISM },
      ],
      'no-restricted-syntax': [
        'error',
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
