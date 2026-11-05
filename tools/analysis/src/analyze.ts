// Project-specific static analysis on top of TypeScript and Knip:
//  - unread-member: a property of an interface, type literal or class that production code
//    writes but never reads (reads in tests do not count), i.e. data with no effect;
//  - pass-through: a named function whose whole body forwards its parameters unchanged to
//    another function, i.e. an abstraction that adds nothing.
import { dirname, relative } from 'node:path';
import ts from 'typescript';

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: 'unread-member' | 'pass-through';
  readonly message: string;
}

const TEST_PATH = /(^|\/)test\/|\.test\.ts$/;

function createService(tsconfigPath: string): { service: ts.LanguageService; files: string[] } {
  const config = ts.getParsedCommandLineOfConfigFile(tsconfigPath, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  if (config === undefined) throw new Error(`cannot read ${tsconfigPath}`);
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => config.options,
    getScriptFileNames: () => config.fileNames,
    getScriptVersion: () => '0',
    getScriptSnapshot: (fileName) => {
      const text = ts.sys.readFile(fileName);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => dirname(tsconfigPath),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (path) => ts.sys.fileExists(path),
    // Workspace packages are symlinks; resolving them keeps one source file per module.
    realpath: (path) => (ts.sys.realpath ? ts.sys.realpath(path) : path),
    readFile: (path) => ts.sys.readFile(path),
    readDirectory: (path, extensions, exclude, include, depth) =>
      ts.sys.readDirectory(path, extensions, exclude, include, depth),
    directoryExists: (path) => ts.sys.directoryExists(path),
    getDirectories: (path) => ts.sys.getDirectories(path),
  };
  return {
    service: ts.createLanguageService(host, ts.createDocumentRegistry()),
    files: config.fileNames,
  };
}

/** Deepest node whose span contains `position`. */
function nodeAt(sourceFile: ts.SourceFile, position: number): ts.Node {
  let node: ts.Node = sourceFile;
  for (;;) {
    const child = node.forEachChild((c) =>
      c.getStart(sourceFile) <= position && position < c.getEnd() ? c : undefined,
    );
    if (child === undefined) return node;
    node = child;
  }
}

/** Whether a reference to a property reads its value (as opposed to declaring or writing it). */
function isValueRead(name: ts.Node): boolean {
  for (let n: ts.Node = name; !ts.isSourceFile(n); n = n.parent) {
    if (ts.isTypeNode(n)) return false;
  }
  const parent = name.parent;
  if (
    ts.isPropertySignature(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isShorthandPropertyAssignment(parent)
  ) {
    return parent.name !== name;
  }
  if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) {
    const assignment = parent.parent;
    return !(
      ts.isBinaryExpression(assignment) &&
      assignment.left === parent &&
      assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
    );
  }
  return true;
}

function containerName(member: ts.Node): string {
  const container = member.parent;
  if (
    (ts.isInterfaceDeclaration(container) || ts.isClassDeclaration(container)) &&
    container.name !== undefined
  ) {
    return container.name.text;
  }
  for (let n: ts.Node = container; !ts.isSourceFile(n); n = n.parent) {
    if (ts.isTypeAliasDeclaration(n)) return n.name.text;
  }
  return '(匿名类型)';
}

/** The callee if `fn` only forwards its parameters, in order and unchanged, to one call. */
function forwardedCallee(fn: ts.FunctionLikeDeclaration): string | undefined {
  const body = fn.body;
  if (body === undefined) return undefined;
  let expression: ts.Expression | undefined = ts.isBlock(body) ? undefined : body;
  if (ts.isBlock(body) && body.statements.length === 1) {
    const only = body.statements[0];
    if (only !== undefined && (ts.isReturnStatement(only) || ts.isExpressionStatement(only))) {
      expression = only.expression;
    }
  }
  if (expression === undefined || !ts.isCallExpression(expression)) return undefined;
  const args = expression.arguments;
  if (args.length !== fn.parameters.length) return undefined;
  const forwardsAll = fn.parameters.every((param, i) => {
    const arg = args[i];
    return (
      param.dotDotDotToken === undefined &&
      ts.isIdentifier(param.name) &&
      arg !== undefined &&
      ts.isIdentifier(arg) &&
      arg.text === param.name.text
    );
  });
  return forwardsAll ? expression.expression.getText() : undefined;
}

function functionName(node: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name !== undefined) {
    return node.name.getText();
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent)
  ) {
    return node.parent.name.getText();
  }
  return undefined;
}

export function analyzeProject(tsconfigPath: string): Finding[] {
  const root = dirname(tsconfigPath);
  const { service, files } = createService(tsconfigPath);
  const program = service.getProgram();
  if (program === undefined) throw new Error('TypeScript program could not be created');
  const isTest = (fileName: string): boolean => TEST_PATH.test(relative(root, fileName));
  const findings: Finding[] = [];

  const report = (node: ts.Node, rule: Finding['rule'], message: string): void => {
    const sourceFile = node.getSourceFile();
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({ file: relative(root, sourceFile.fileName), line: line + 1, rule, message });
  };

  const countReads = (member: ts.PropertySignature | ts.PropertyDeclaration): number => {
    const sourceFile = member.getSourceFile();
    const referenced = service.findReferences(
      sourceFile.fileName,
      member.name.getStart(sourceFile),
    );
    let reads = 0;
    for (const symbol of referenced ?? []) {
      for (const reference of symbol.references) {
        const file = program.getSourceFile(reference.fileName);
        if (file === undefined || file.isDeclarationFile || isTest(file.fileName)) continue;
        if (isValueRead(nodeAt(file, reference.textSpan.start))) reads++;
      }
    }
    return reads;
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) &&
      countReads(node) === 0
    ) {
      report(
        node,
        'unread-member',
        `${containerName(node)}.${node.name.getText()} 在生产代码中只被写入、从未被读取`,
      );
    }
    if (ts.isFunctionLike(node) && 'body' in node) {
      const name = functionName(node);
      const callee = forwardedCallee(node);
      if (name !== undefined && callee !== undefined) {
        report(
          node,
          'pass-through',
          `${name} 只是把参数原样转发给 ${callee}，应直接调用 ${callee}`,
        );
      }
    }
    node.forEachChild(visit);
  };

  for (const fileName of files) {
    const sourceFile = program.getSourceFile(fileName);
    if (sourceFile !== undefined && !isTest(fileName)) visit(sourceFile);
  }
  return findings;
}
