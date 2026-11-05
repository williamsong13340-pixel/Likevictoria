// Runs the project-specific static analysis on the whole repository.
import { resolve } from 'node:path';
import { analyzeProject } from './analyze.ts';

const RULE_LABELS = {
  'unread-member': '无用字段',
  'pass-through': '纯转发',
} as const;

const findings = analyzeProject(resolve(import.meta.dirname, '../../../tsconfig.json'));
for (const finding of findings) {
  console.log(`${finding.file}:${finding.line}  [${RULE_LABELS[finding.rule]}] ${finding.message}`);
}
if (findings.length > 0) {
  console.error(`\n静态分析发现 ${findings.length} 个问题`);
  process.exitCode = 1;
} else {
  console.log('静态分析通过：没有只写不读的字段，没有纯转发的包装函数');
}
