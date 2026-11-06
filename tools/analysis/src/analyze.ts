// Project-specific static analysis on top of TypeScript and Knip:
//  - unread-member: a property of an interface, type literal, class or plain object constant
//    that production code writes but never reads (reads in tests, reads that only compute the
//    property's own next value, and type-level uses do not count), i.e. data with no effect;
//  - pass-through: a named function whose whole body forwards its parameters unchanged to
//    another function or constructor, i.e. an abstraction that adds nothing. Exempt: arrow
//    functions that call a method reached through `this` (they bind it), wrappers that await
//    what may be a plain value or discard what may be a promise (they change the type; an `any`
//    value counts as a promise), and members a base class or an implemented interface requires.
// Known gaps: local variables that are written but never read are left to TypeScript's
// noUnusedLocals; an interface member read only through a computed key (`table[key]`) is
// reported as unread, while an object constant with any computed read is not checked at all.
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
  // ts.sys supplies file access, including realpath: workspace packages are symlinks, and
  // resolving them keeps one source file per module.
  const host: ts.LanguageServiceHost = {
    ...ts.sys,
    getCompilationSettings: () => config.options,
    getScriptFileNames: () => config.fileNames,
    getScriptVersion: () => '0',
    getScriptSnapshot: (fileName) => {
      const text = ts.sys.readFile(fileName);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => dirname(tsconfigPath),
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  };
  return {
    service: ts.createLanguageService(host, ts.createDocumentRegistry()),
    files: config.fileNames,
  };
}

/**
 * The name node that a reference span points at, or undefined when the span is not a code
 * node (for example a `{@link Type.member}` inside a JSDoc comment).
 */
function referencedNode(sourceFile: ts.SourceFile, span: ts.TextSpan): ts.Node | undefined {
  let node: ts.Node = sourceFile;
  for (;;) {
    const child = node.forEachChild((c) =>
      c.getStart(sourceFile) <= span.start && span.start < c.getEnd() ? c : undefined,
    );
    if (child === undefined) break;
    node = child;
  }
  if (node === sourceFile) return undefined;
  const start = node.getStart(sourceFile);
  const exact = start === span.start && node.getWidth(sourceFile) === span.length;
  const quoted = ts.isStringLiteral(node) && start + 1 === span.start;
  return exact || quoted ? node : undefined;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** Whether a reference reads the property's value, rather than declaring or writing it. */
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
    const outer = parent.parent;
    if (
      ts.isBinaryExpression(outer) &&
      outer.left === parent &&
      isAssignmentOperator(outer.operatorToken.kind)
    ) {
      return false;
    }
    if (
      (ts.isPrefixUnaryExpression(outer) || ts.isPostfixUnaryExpression(outer)) &&
      (outer.operator === ts.SyntaxKind.PlusPlusToken ||
        outer.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * A read inside `{ member: ... }`, where that property assignment writes the same member, only
 * computes the member's own next value (`{ ticks: c.ticks + 1 }`).
 */
function updatesItself(read: ts.Node, writesOfMember: ReadonlySet<ts.Node>): boolean {
  for (let n: ts.Node = read.parent; !ts.isSourceFile(n); n = n.parent) {
    if (ts.isPropertyAssignment(n)) return writesOfMember.has(n.name);
  }
  return false;
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
    if (ts.isTypeAliasDeclaration(n) || ts.isVariableDeclaration(n)) return n.name.getText();
  }
  return '(匿名类型)';
}

function unwrap(expression: ts.Expression): ts.Expression {
  let e = expression;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** Whether a value of this expression's type may be a promise (`any`, `unknown` and unions included). */
function mayBeThenable(checker: ts.TypeChecker, node: ts.Node): boolean {
  const type = checker.getTypeAtLocation(node);
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true;
  return (type.isUnion() ? type.types : [type]).some((t) => t.getProperty('then') !== undefined);
}

/**
 * Whether every value of this expression's type is a promise; an `any` value is taken to be one,
 * an `unknown` one is not (it has no `then`).
 */
function isThenable(checker: ts.TypeChecker, node: ts.Node): boolean {
  const type = checker.getTypeAtLocation(node);
  if ((type.flags & ts.TypeFlags.Any) !== 0) return true;
  return (type.isUnion() ? type.types : [type]).every((t) => t.getProperty('then') !== undefined);
}

/** The object at the start of a chain like `this.service!.handle` or `this.first().handle`. */
function rootOf(expression: ts.Expression): ts.Expression {
  let e = expression;
  while (
    ts.isPropertyAccessExpression(e) ||
    ts.isElementAccessExpression(e) ||
    ts.isCallExpression(e) ||
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** The callee if `fn` only forwards its parameters, in order and unchanged, to one call. */
function forwardedCallee(fn: ts.SignatureDeclaration, checker: ts.TypeChecker): string | undefined {
  if (!('body' in fn)) return undefined;
  const body = fn.body;
  if (body === undefined) return undefined;
  let expression: ts.Expression | undefined = ts.isBlock(body) ? undefined : body;
  if (ts.isBlock(body) && body.statements.length === 1) {
    const only = body.statements[0];
    if (only !== undefined && (ts.isReturnStatement(only) || ts.isExpressionStatement(only))) {
      expression = only.expression;
    }
  }
  if (expression === undefined) return undefined;
  let call = unwrap(expression);
  // Awaiting a promise or discarding a plain value changes nothing; awaiting what may be a plain
  // value turns the result into a promise, and discarding what may be a promise is what a callback
  // must do with one.
  for (;;) {
    if (ts.isAwaitExpression(call) && isThenable(checker, call.expression)) {
      call = unwrap(call.expression);
    } else if (ts.isVoidExpression(call) && !mayBeThenable(checker, call.expression)) {
      call = unwrap(call.expression);
    } else {
      break;
    }
  }
  if (!ts.isCallExpression(call) && !ts.isNewExpression(call)) return undefined;
  // An arrow function that calls a method reached through `this` binds the receiver, as a
  // handler stored in a field must.
  const callee = call.expression;
  if (ts.isArrowFunction(fn) && rootOf(callee).kind === ts.SyntaxKind.ThisKeyword) {
    return undefined;
  }
  const args = call.arguments ?? [];
  if (args.length !== fn.parameters.length) return undefined;
  const forwardsAll = fn.parameters.every((param, i) => {
    const arg = args[i];
    if (param.initializer !== undefined || !ts.isIdentifier(param.name) || arg === undefined) {
      return false;
    }
    if (param.dotDotDotToken !== undefined) {
      return (
        ts.isSpreadElement(arg) &&
        ts.isIdentifier(arg.expression) &&
        arg.expression.text === param.name.text
      );
    }
    return ts.isIdentifier(arg) && arg.text === param.name.text;
  });
  if (!forwardsAll) return undefined;
  return ts.isNewExpression(call) ? `new ${callee.getText()}` : callee.getText();
}

function functionName(node: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name !== undefined) {
    return node.name.getText();
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (
      ts.isVariableDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertyAssignment(parent)
    ) {
      return parent.name.getText();
    }
  }
  return undefined;
}

/**
 * Whether a base class or an implemented interface requires this class member to exist. A static
 * member can only be required by the static side of a base class.
 */
function satisfiesContract(node: ts.Node, checker: ts.TypeChecker): boolean {
  const member = ts.isMethodDeclaration(node)
    ? node
    : ts.isPropertyDeclaration(node.parent)
      ? node.parent
      : undefined;
  if (member === undefined || !ts.isClassLike(member.parent)) return false;
  const owner = member.parent;
  const isStatic = (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0;
  // The member's own symbol, found through the class type so that computed names work too. A
  // class expression may be anonymous; its constructor type still leads to the class symbol.
  const classSymbol =
    owner.name === undefined
      ? checker.getTypeAtLocation(owner).getSymbol()
      : checker.getSymbolAtLocation(owner.name);
  if (classSymbol === undefined) return false;
  const ownType = isStatic
    ? checker.getTypeOfSymbolAtLocation(classSymbol, owner)
    : checker.getDeclaredTypeOfSymbol(classSymbol);
  const own = ownType.getProperties().find((property) => property.declarations?.includes(member));
  if (own === undefined) return false;
  return (owner.heritageClauses ?? []).some(
    (clause) =>
      (!isStatic || clause.token === ts.SyntaxKind.ExtendsKeyword) &&
      clause.types.some((base) =>
        checker
          .getPropertiesOfType(checker.getTypeAtLocation(isStatic ? base.expression : base))
          .some((property) => property.escapedName === own.escapedName),
      ),
  );
}

export function analyzeProject(tsconfigPath: string): Finding[] {
  const root = dirname(tsconfigPath);
  const { service, files } = createService(tsconfigPath);
  const program = service.getProgram();
  if (program === undefined) throw new Error('TypeScript program could not be created');
  const checker = program.getTypeChecker();
  const isTest = (fileName: string): boolean => TEST_PATH.test(relative(root, fileName));
  const findings: Finding[] = [];

  const report = (node: ts.Node, rule: Finding['rule'], message: string): void => {
    const sourceFile = node.getSourceFile();
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({ file: relative(root, sourceFile.fileName), line: line + 1, rule, message });
  };

  /** Code nodes (outside declaration files) that refer to the symbol named by `name`. */
  const referencesTo = (name: ts.Node): ts.Node[] => {
    const sourceFile = name.getSourceFile();
    const nodes: ts.Node[] = [];
    for (const symbol of service.findReferences(sourceFile.fileName, name.getStart(sourceFile)) ??
      []) {
      for (const reference of symbol.references) {
        const file = program.getSourceFile(reference.fileName);
        if (file === undefined || file.isDeclarationFile) continue;
        const node = referencedNode(file, reference.textSpan);
        if (node !== undefined) nodes.push(node);
      }
    }
    return nodes;
  };

  const isUnread = (name: ts.PropertyName): boolean => {
    const references = referencesTo(name);
    const writes = new Set(references.filter((node) => ts.isPropertyAssignment(node.parent)));
    return !references.some(
      (node) =>
        !isTest(node.getSourceFile().fileName) && isValueRead(node) && !updatesItself(node, writes),
    );
  };

  const reportUnread = (member: ts.Node, owner: string, name: ts.PropertyName): void => {
    report(member, 'unread-member', `${owner}.${name.getText()} 在生产代码中只被写入、从未被读取`);
  };

  /** Entries of `const X = { ... }` when every use of X is a plain `X.entry` access. */
  const checkObjectConstant = (declaration: ts.VariableDeclaration): void => {
    const initializer = declaration.initializer && unwrap(declaration.initializer);
    if (
      declaration.type !== undefined ||
      initializer === undefined ||
      !ts.isObjectLiteralExpression(initializer) ||
      !ts.isIdentifier(declaration.name) ||
      (declaration.parent.flags & ts.NodeFlags.Const) === 0
    ) {
      return;
    }
    const uses = referencesTo(declaration.name).filter((node) => node !== declaration.name);
    const onlyNamedAccess = uses.every(
      (node) => ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node,
    );
    if (!onlyNamedAccess) return;
    for (const property of initializer.properties) {
      if (
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        isUnread(property.name)
      ) {
        reportUnread(property, declaration.name.text, property.name);
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if ((ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) && isUnread(node.name)) {
      reportUnread(node, containerName(node), node.name);
    }
    if (ts.isVariableDeclaration(node)) checkObjectConstant(node);
    if (ts.isFunctionLike(node) && !satisfiesContract(node, checker)) {
      const name = functionName(node);
      const callee = forwardedCallee(node, checker);
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
