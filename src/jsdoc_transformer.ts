/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

/**
 * @fileoverview jsdoc_transformer contains the logic to add JSDoc comments to TypeScript code.
 *
 * One of tsickle's features is to add Closure Compiler compatible JSDoc comments containing type
 * annotations, inheritance information, etc., onto TypeScript code. This allows Closure Compiler to
 * make better optimization decisions compared to an untyped code base.
 *
 * The entry point to the annotation operation is jsdocTransformer below. It adds synthetic comments
 * to existing TypeScript constructs, for example:
 *     const x: number = 1;
 * Might get transformed to:
 *     /.. \@type {number} ./
 *     const x: number = 1;
 * Later TypeScript phases then remove the type annotation, and the final emit is JavaScript that
 * only contains the JSDoc comment.
 *
 * To handle certain constructs, this transformer also performs AST transformations, e.g. by adding
 * CommonJS-style exports for type constructs, expanding `export *`, parenthesizing casts, etc.
 */

import {addSyntheticTrailingComment} from 'typescript';

import {hasExportingDecorator} from './decorators';
import {moduleNameAsIdentifier} from './externs';
import * as googmodule from './googmodule';
import * as jsdoc from './jsdoc';
import {ModuleTypeTranslator} from './module_type_translator';
import * as transformerUtil from './transformer_util';
import * as ts from './typescript';

/** AnnotatorHost contains host properties for the JSDoc-annotation process. */
export interface AnnotatorHost {
  /**
   * If provided a function that logs an internal warning.
   * These warnings are not actionable by an end user and should be hidden
   * by default.
   */
  logWarning?: (warning: ts.Diagnostic) => void;
  pathToModuleName: (context: string, importPath: string) => string;
  /**
   * If true, convert every type to the Closure {?} type, which means
   * "don't check types".
   */
  untyped?: boolean;
  /** If provided, a set of paths whose types should always generate as {?}. */
  typeBlackListPaths?: Set<string>;
  /**
   * Convert shorthand "/index" imports to full path (include the "/index").
   * Annotation will be slower because every import must be resolved.
   */
  convertIndexImportShorthand?: boolean;
  /**
   * If true, do not modify quotes around property accessors.
   */
  disableAutoQuoting?: boolean;
  /**
   * Whether tsickle should insert goog.provide() calls into the externs generated for `.d.ts` files
   * that are external modules.
   */
  provideExternalModuleDtsNamespace?: boolean;

  /** host allows resolving file names to modules. */
  host: ts.ModuleResolutionHost;
  /** Used together with the host for file name -> module name resolution. */
  options: ts.CompilerOptions;
}

function addCommentOn(node: ts.Node, tags: jsdoc.Tag[], escapeExtraTags?: Set<string>) {
  const comment = jsdoc.toSynthesizedComment(tags, escapeExtraTags);
  const comments = ts.getSyntheticLeadingComments(node) || [];
  comments.push(comment);
  ts.setSyntheticLeadingComments(node, comments);
  return comment;
}

/** @return true if node has the specified modifier flag set. */
export function isAmbient(node: ts.Node): boolean {
  let current: ts.Node|undefined = node;
  while (current) {
    if (transformerUtil.hasModifierFlag(current, ts.ModifierFlags.Ambient)) return true;
    current = current.parent;
  }
  return false;
}

type HasTypeParameters =
    ts.InterfaceDeclaration|ts.ClassLikeDeclaration|ts.TypeAliasDeclaration|ts.SignatureDeclaration;

/** Adds an \@template clause to docTags if decl has type parameters. */
export function maybeAddTemplateClause(docTags: jsdoc.Tag[], decl: HasTypeParameters) {
  if (!decl.typeParameters) return;
  // Closure does not support template constraints (T extends X), these are ignored below.
  docTags.push({
    tagName: 'template',
    text: decl.typeParameters.map(tp => transformerUtil.getIdentifierText(tp.name)).join(', ')
  });
}

/**
 * Adds heritage clauses (\@extends, \@implements) to the given docTags for decl. Used by
 * jsdoc_transformer and externs generation.
 */
export function maybeAddHeritageClauses(
    docTags: jsdoc.Tag[], mtt: ModuleTypeTranslator,
    decl: ts.ClassLikeDeclaration|ts.InterfaceDeclaration) {
  if (!decl.heritageClauses) return;
  const isClass = decl.kind === ts.SyntaxKind.ClassDeclaration;
  const classHasSuperClass =
      isClass && decl.heritageClauses.some(hc => hc.token === ts.SyntaxKind.ExtendsKeyword);
  for (const heritage of decl.heritageClauses!) {
    if (!heritage.types) continue;
    if (isClass && heritage.token !== ts.SyntaxKind.ImplementsKeyword && !isAmbient(decl)) {
      // If a class has "extends Foo", that is preserved in the ES6 output
      // and we don't need to do anything.  But if it has "implements Foo",
      // that is a TS-specific thing and we need to translate it to the
      // the Closure "@implements {Foo}".
      // However for ambient declarations, we only emit externs, and in those we do need to
      // add "@extends {Foo}" as they use ES5 syntax.
      continue;
    }
    for (const impl of heritage.types) {
      let tagName = decl.kind === ts.SyntaxKind.InterfaceDeclaration ? 'extends' : 'implements';

      const sym = mtt.typeChecker.getSymbolAtLocation(impl.expression);
      if (!sym) {
        // It's possible for a class declaration to extend an expression that
        // does not have have a symbol, for example when a mixin function is
        // used to build a base class, as in `declare MyClass extends
        // MyMixin(MyBaseClass)`.
        //
        // Handling this correctly is tricky. Closure throws on this
        // `extends <expression>` syntax (see
        // https://github.com/google/closure-compiler/issues/2182). We would
        // probably need to generate an intermediate class declaration and
        // extend that. For now, just omit the `extends` annotation.
        mtt.debugWarn(decl, `could not resolve supertype: ${impl.getText()}`);
        docTags.push({
          tagName: '',
          text: 'NOTE: tsickle could not resolve supertype, ' +
              'class definition may be incomplete.\n'
        });
        continue;
      }
      let alias: ts.Symbol = sym;
      if (sym.flags & ts.SymbolFlags.TypeAlias) {
        // It's implementing a type alias.  Follow the type alias back
        // to the original symbol to check whether it's a type or a value.
        const type = mtt.typeChecker.getDeclaredTypeOfSymbol(sym);
        if (!type.symbol) {
          // It's not clear when this can happen, but if it does all we
          // do is fail to emit the @implements, which isn't so harmful.
          continue;
        }
        alias = type.symbol;
      }
      if (alias.flags & ts.SymbolFlags.Alias) {
        alias = mtt.typeChecker.getAliasedSymbol(alias);
      }
      const typeTranslator = mtt.newTypeTranslator(impl.expression);
      if (typeTranslator.isBlackListed(alias)) {
        continue;
      }
      // We can only @implements an interface, not a class.
      // But it's fine to translate TS "implements Class" into Closure
      // "@extends {Class}" because this is just a type hint.
      if (alias.flags & ts.SymbolFlags.Class) {
        if (!isClass) {
          // Only classes can extend classes in TS. Ignoring the heritage clause should be safe,
          // as interfaces are @record anyway, so should prevent property disambiguation.

          // Problem: validate that methods are there?
          continue;
        }
        if (classHasSuperClass && heritage.token !== ts.SyntaxKind.ExtendsKeyword) {
          // Do not emit an @extends for a class that already has a proper ES6 extends class. This
          // risks incorrect optimization, as @extends takes precedence, and Closure won't be
          // aware of the actual type hierarchy of the class.
          continue;
        }
        tagName = 'extends';
      } else if (alias.flags & ts.SymbolFlags.Value) {
        // If the symbol was already in the value namespace, then it will
        // not be a type in the Closure output (because Closure collapses
        // the type and value namespaces).  Just ignore the implements.
        continue;
      }
      // typeToClosure includes nullability modifiers, so call symbolToString directly here.
      docTags.push({tagName, type: typeTranslator.symbolToString(alias, true)});
    }
  }
}

/**
 * createMemberTypeDeclaration emits the type annotations for members of a class. It's necessary in
 * the case where TypeScript syntax specifies there are additional properties on the class, because
 * to declare these in Closure you must declare these separately from the class.
 *
 * createMemberTypeDeclaration produces an if (false) statement containing property declarations, or
 * null if no declarations could or needed to be generated (e.g. no members, or an unnamed type).
 * The if statement is used to make sure the code is not executed, otherwise property accesses could
 * trigger getters on a superclass. See test_files/fields/fields.ts:BaseThatThrows.
 */
function createMemberTypeDeclaration(
    mtt: ModuleTypeTranslator,
    typeDecl: ts.ClassDeclaration|ts.InterfaceDeclaration): ts.IfStatement|null {
  // Gather parameter properties from the constructor, if it exists.
  const ctors: ts.ConstructorDeclaration[] = [];
  let paramProps: ts.ParameterDeclaration[] = [];
  const nonStaticProps: Array<ts.PropertyDeclaration|ts.PropertySignature> = [];
  const staticProps: Array<ts.PropertyDeclaration|ts.PropertySignature> = [];
  const unhandled: ts.NamedDeclaration[] = [];
  const abstractMethods: ts.FunctionLikeDeclaration[] = [];
  for (const member of typeDecl.members) {
    if (member.kind === ts.SyntaxKind.Constructor) {
      ctors.push(member as ts.ConstructorDeclaration);
    } else if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
      const isStatic = transformerUtil.hasModifierFlag(member, ts.ModifierFlags.Static);
      if (isStatic) {
        staticProps.push(member);
      } else {
        nonStaticProps.push(member);
      }
    } else if (
        member.kind === ts.SyntaxKind.MethodDeclaration ||
        member.kind === ts.SyntaxKind.MethodSignature ||
        member.kind === ts.SyntaxKind.GetAccessor || member.kind === ts.SyntaxKind.SetAccessor) {
      if (transformerUtil.hasModifierFlag(member, ts.ModifierFlags.Abstract) ||
          ts.isInterfaceDeclaration(typeDecl)) {
        abstractMethods.push(
            member as ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration);
      }
      // Non-abstract methods only exist on classes, and are handled in regular emit.
    } else {
      unhandled.push(member);
    }
  }

  if (ctors.length > 0) {
    // Only the actual constructor implementation, which must be last in a potential sequence of
    // overloaded constructors, may contain parameter properties.
    const ctor = ctors[ctors.length - 1];
    paramProps = ctor.parameters.filter(
        p => transformerUtil.hasModifierFlag(p, ts.ModifierFlags.ParameterPropertyModifier));
  }

  if (nonStaticProps.length === 0 && paramProps.length === 0 && staticProps.length === 0 &&
      abstractMethods.length === 0) {
    // There are no members so we don't need to emit any type
    // annotations helper.
    return null;
  }

  if (!typeDecl.name) {
    mtt.debugWarn(typeDecl, 'cannot add types on unnamed declarations');
    return null;
  }

  const className = transformerUtil.getIdentifierText(typeDecl.name);
  const staticPropAccess = ts.createIdentifier(className);
  const instancePropAccess = ts.createPropertyAccess(staticPropAccess, 'prototype');
  // Closure Compiler will report conformance errors about this being unknown type when emitting
  // class properties as {?|undefined}, instead of just {?}. So make sure to only emit {?|undefined}
  // on interfaces.
  const isInterface = ts.isInterfaceDeclaration(typeDecl);
  const propertyDecls = staticProps.map(
      p => createClosurePropertyDeclaration(
          mtt, staticPropAccess, p, isInterface && !!p.questionToken));
  propertyDecls.push(...[...nonStaticProps, ...paramProps].map(
      p => createClosurePropertyDeclaration(
          mtt, instancePropAccess, p, isInterface && !!p.questionToken)));
  propertyDecls.push(...unhandled.map(
      p => transformerUtil.createMultiLineComment(
          p, `Skipping unhandled member: ${escapeForComment(p.getText())}`)));

  for (const fnDecl of abstractMethods) {
    const name = propertyName(fnDecl);
    if (!name) {
      mtt.error(fnDecl, 'anonymous abstract function');
      continue;
    }
    const [tags, paramNames] = mtt.getFunctionTypeJSDoc([fnDecl], []);
    if (hasExportingDecorator(fnDecl, mtt.typeChecker)) tags.push({tagName: 'export'});
    // memberNamespace because abstract methods cannot be static in TypeScript.
    const abstractFnDecl = ts.createStatement(ts.createAssignment(
        ts.createPropertyAccess(instancePropAccess, name),
        ts.createFunctionExpression(
            /* modifiers */ undefined,
            /* asterisk */ undefined,
            /* name */ undefined,
            /* typeParameters */ undefined,
            paramNames.map(
                n => ts.createParameter(
                    /* decorators */ undefined, /* modifiers */ undefined,
                    /* dotDotDot */ undefined, n)),
            undefined,
            ts.createBlock([]),
            )));
    ts.setSyntheticLeadingComments(abstractFnDecl, [jsdoc.toSynthesizedComment(tags)]);
    propertyDecls.push(ts.setSourceMapRange(abstractFnDecl, fnDecl));
  }

  // See test_files/fields/fields.ts:BaseThatThrows for a note on this wrapper.
  return ts.createIf(ts.createLiteral(false), ts.createBlock(propertyDecls, true));
}

/**
 * TypeScript allows you to write identifiers quoted, like:
 *   interface Foo {
 *     'bar': string;
 *     'complex name': string;
 *   }
 *   Foo.bar;  // ok
 *   Foo['bar']  // ok
 *   Foo['complex name']  // ok
 *
 * In Closure-land, we want identify that the legal name 'bar' can become an
 * ordinary field, but we need to skip strings like 'complex name'.
 */
export function isValidClosurePropertyName(name: string): boolean {
  // In local experimentation, it appears that reserved words like 'var' and
  // 'if' are legal JS and still accepted by Closure.
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

function propertyName(prop: ts.NamedDeclaration): string|null {
  if (!prop.name) return null;

  switch (prop.name.kind) {
    case ts.SyntaxKind.Identifier:
      return transformerUtil.getIdentifierText(prop.name as ts.Identifier);
    case ts.SyntaxKind.StringLiteral:
      // E.g. interface Foo { 'bar': number; }
      // If 'bar' is a name that is not valid in Closure then there's nothing we can do.
      const text = (prop.name as ts.StringLiteral).text;
      if (!isValidClosurePropertyName(text)) return null;
      return text;
    default:
      return null;
  }
}

/** Removes comment metacharacters from a string, to make it safe to embed in a comment. */
export function escapeForComment(str: string): string {
  return str.replace(/\/\*/g, '__').replace(/\*\//g, '__');
}

function createClosurePropertyDeclaration(
    mtt: ModuleTypeTranslator, expr: ts.Expression,
    prop: ts.PropertyDeclaration|ts.PropertySignature|ts.ParameterDeclaration,
    optional: boolean): ts.Statement {
  const name = propertyName(prop);
  if (!name) {
    mtt.debugWarn(prop, `handle unnamed member:\n${escapeForComment(prop.getText())}`);
    return transformerUtil.createMultiLineComment(
        prop, `Skipping unnamed member:\n${escapeForComment(prop.getText())}`);
  }

  let type = mtt.typeToClosure(prop);
  // When a property is optional, e.g.
  //   foo?: string;
  // Then the TypeScript type of the property is string|undefined, the
  // typeToClosure translation handles it correctly, and string|undefined is
  // how you write an optional property in Closure.
  //
  // But in the special case of an optional property with type any:
  //   foo?: any;
  // The TypeScript type of the property is just "any" (because any includes
  // undefined as well) so our default translation of the type is just "?".
  // To mark the property as optional in Closure it must have "|undefined",
  // so the Closure type must be ?|undefined.
  if (optional && type === '?') type += '|undefined';

  const tags = mtt.getJSDoc(prop, /* reportWarnings */ true);
  tags.push({tagName: 'type', type});
  if (hasExportingDecorator(prop, mtt.typeChecker)) {
    tags.push({tagName: 'export'});
  }
  const declStmt =
      ts.setSourceMapRange(ts.createStatement(ts.createPropertyAccess(expr, name)), prop);
  // Avoid printing annotations that can conflict with @type
  // This avoids Closure's error "type annotation incompatible with other annotations"
  addCommentOn(declStmt, tags, jsdoc.TAGS_CONFLICTING_WITH_TYPE);
  return declStmt;
}

/**
 * Removes any type assertions and non-null expressions from the AST before TypeScript processing.
 *
 * Ideally, the code in jsdoc_transformer below should just remove the cast expression and
 * replace it with the Closure equivalent. However Angular's compiler is fragile to AST
 * nodes being removed or changing type, so the code must retain the type assertion
 * expression, see: https://github.com/angular/angular/issues/24895.
 *
 * tsickle also cannot just generate and keep a `(/.. @type {SomeType} ./ (expr as SomeType))` because
 * TypeScript removes the parenthesized expressions in that syntax, (reasonably) believing
 * they were only added for the TS cast.
 *
 * The final workaround is then to keep the TypeScript type assertions, and have a post-Angular
 * processing step that removes the assertions before TypeScript sees them.
 *
 * TODO(martinprobst): remove once the Angular issue is fixed.
 */
export function removeTypeAssertions(): ts.TransformerFactory<ts.SourceFile> {
  return (context: ts.TransformationContext) => {
    return (sourceFile: ts.SourceFile) => {
      function visitor(node: ts.Node): ts.Node {
        switch (node.kind) {
          case ts.SyntaxKind.TypeAssertionExpression:
          case ts.SyntaxKind.AsExpression:
            return ts.visitNode((node as ts.AssertionExpression).expression, visitor);
          case ts.SyntaxKind.NonNullExpression:
            return ts.visitNode((node as ts.NonNullExpression).expression, visitor);
          default:
            break;
        }
        return ts.visitEachChild(node, visitor, context);
      }

      return visitor(sourceFile) as ts.SourceFile;
    };
  };
}

/**
 * jsdocTransformer returns a transformer factory that converts TypeScript types into the equivalent
 * JSDoc annotations.
 */
export function jsdocTransformer(
    host: AnnotatorHost, tsOptions: ts.CompilerOptions, tsHost: ts.CompilerHost,
    typeChecker: ts.TypeChecker, diagnostics: ts.Diagnostic[]):
    (context: ts.TransformationContext) => ts.Transformer<ts.SourceFile> {
  return (context: ts.TransformationContext): ts.Transformer<ts.SourceFile> => {
    return (sourceFile: ts.SourceFile) => {
      const moduleTypeTranslator = new ModuleTypeTranslator(
          sourceFile, typeChecker, host, diagnostics, /*isForExterns*/ false);
      /**
       * The set of all names exported from an export * in the current module. Used to prevent
       * emitting duplicated exports. The first export * takes precedence in ES6.
       */
      const expandedStarImports = new Set<string>();

      function visitClassDeclaration(classDecl: ts.ClassDeclaration): ts.Statement[] {
        const mjsdoc = moduleTypeTranslator.getMutableJSDoc(classDecl);
        if (transformerUtil.hasModifierFlag(classDecl, ts.ModifierFlags.Abstract)) {
          mjsdoc.tags.push({tagName: 'abstract'});
        }

        maybeAddTemplateClause(mjsdoc.tags, classDecl);
        if (!host.untyped) {
          maybeAddHeritageClauses(mjsdoc.tags, moduleTypeTranslator, classDecl);
        }
        mjsdoc.updateComment();
        const decls: ts.Statement[] = [];
        const memberDecl = createMemberTypeDeclaration(moduleTypeTranslator, classDecl);
        // WARNING: order is significant; we must create the member decl before transforming away
        // parameter property comments when visiting the constructor.
        decls.push(ts.visitEachChild(classDecl, visitor, context));
        if (memberDecl) decls.push(memberDecl);
        return decls;
      }

      /**
       * visitHeritageClause works around a Closure Compiler issue, where the expression in an
       * "extends" clause must be a simple identifier, and in particular must not be a parenthesized
       * expression.
       *
       * This is triggered when TS code writes "class X extends (Foo as Bar) { ... }", commonly done
       * to support mixins. For extends clauses in classes, the code below drops the cast and any
       * parentheticals, leaving just the original expression.
       *
       * This is an incomplete workaround, as Closure will still bail on other super expressions,
       * but retains compatibility with the previous emit that (accidentally) dropped the cast
       * expression.
       *
       * TODO(martinprobst): remove this once the Closure side issue has been resolved.
       */
      function visitHeritageClause(heritageClause: ts.HeritageClause) {
        if (heritageClause.token !== ts.SyntaxKind.ExtendsKeyword || !heritageClause.parent ||
            heritageClause.parent.kind === ts.SyntaxKind.InterfaceDeclaration) {
          return ts.visitEachChild(heritageClause, visitor, context);
        }
        if (heritageClause.types.length !== 1) {
          moduleTypeTranslator.error(
              heritageClause, `expected exactly one type in class extension clause`);
        }
        const type = heritageClause.types[0];
        let expr: ts.Expression = type.expression;
        while (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr) ||
               ts.isAssertionExpression(expr)) {
          expr = expr.expression;
        }
        return ts.updateHeritageClause(heritageClause, [ts.updateExpressionWithTypeArguments(
                                                           type, type.typeArguments || [], expr)]);
      }

      function visitInterfaceDeclaration(iface: ts.InterfaceDeclaration): ts.Statement[] {
        const sym = typeChecker.getSymbolAtLocation(iface.name);
        if (!sym) {
          moduleTypeTranslator.error(iface, 'interface with no symbol');
          return [];
        }
        // If this symbol is both a type and a value, we cannot emit both into Closure's
        // single namespace.
        if (sym.flags & ts.SymbolFlags.Value) {
          moduleTypeTranslator.debugWarn(
              iface, `type/symbol conflict for ${sym.name}, using {?} for now`);
          return [transformerUtil.createSingleLineComment(
              iface, 'WARNING: interface has both a type and a value, skipping emit')];
        }

        const tags = moduleTypeTranslator.getJSDoc(iface, /* reportWarnings */ true) || [];
        tags.push({tagName: 'record'});
        maybeAddTemplateClause(tags, iface);
        if (!host.untyped) {
          maybeAddHeritageClauses(tags, moduleTypeTranslator, iface);
        }
        const name = transformerUtil.getIdentifierText(iface.name);
        const modifiers = transformerUtil.hasModifierFlag(iface, ts.ModifierFlags.Export) ?
            [ts.createToken(ts.SyntaxKind.ExportKeyword)] :
            undefined;
        const decl = ts.setSourceMapRange(
            ts.createFunctionDeclaration(
                /* decorators */ undefined,
                modifiers,
                /* asterisk */ undefined,
                name,
                /* typeParameters */ undefined,
                /* parameters */[],
                /* type */ undefined,
                /* body */ ts.createBlock([]),
                ),
            iface);
        addCommentOn(decl, tags);
        const memberDecl = createMemberTypeDeclaration(moduleTypeTranslator, iface);
        return memberDecl ? [decl, memberDecl] : [decl];
      }

      /** Function declarations are emitted as they are, with only JSDoc added. */
      function addJsDocToFunctionLikeDeclaration(fnDecl: ts.FunctionLikeDeclaration) {
        if (!fnDecl.body) {
          // Two cases: abstract methods and overloaded methods/functions.
          // Abstract methods are handled in emitTypeAnnotationsHandler.
          // Overloads are union-ized into the shared type in FunctionType.
          return;
        }
        const extraTags = [];
        if (hasExportingDecorator(fnDecl, typeChecker)) extraTags.push({tagName: 'export'});

        const [tags, ] = moduleTypeTranslator.getFunctionTypeJSDoc([fnDecl], extraTags);
        const mjsdoc = moduleTypeTranslator.getMutableJSDoc(fnDecl);
        mjsdoc.tags = tags;
        mjsdoc.updateComment();
        moduleTypeTranslator.blacklistTypeParameters(fnDecl, fnDecl.typeParameters);
      }

      /**
       * visitVariableStatement flattens variable declaration lists (`var a, b;` to `var a; var
       * b;`), and attaches JSDoc comments to each variable. JSDoc comments preceding the
       * original variable are attached to the first newly created one.
       */
      function visitVariableStatement(varStmt: ts.VariableStatement): ts.Statement[] {
        const stmts: ts.Statement[] = [];

        // "const", "let", etc are stored in node flags on the declarationList.
        const flags = ts.getCombinedNodeFlags(varStmt.declarationList);

        let tags: jsdoc.Tag[]|null =
            moduleTypeTranslator.getJSDoc(varStmt, /* reportWarnings */ true);
        const leading = ts.getSyntheticLeadingComments(varStmt);
        if (leading) {
          // Attach non-JSDoc comments to a not emitted statement.
          const commentHolder = ts.createNotEmittedStatement(varStmt);
          ts.setSyntheticLeadingComments(commentHolder, leading.filter(c => c.text[0] !== '*'));
          stmts.push(commentHolder);
        }

        const declList = ts.visitNode(varStmt.declarationList, visitor);
        for (const decl of declList.declarations) {
          const localTags: jsdoc.Tag[] = [];
          if (tags) {
            // Add any tags and docs preceding the entire statement to the first variable.
            localTags.push(...tags);
            tags = null;
          }
          // Add an @type for plain identifiers, but not for bindings patterns (i.e. object or array
          // destructuring) - those do not have a syntax in Closure.
          if (ts.isIdentifier(decl.name)) {
            // For variables that are initialized and use a blacklisted type, do not emit a type at
            // all. Closure Compiler might be able to infer a better type from the initializer than
            // the `?` the code below would emit.
            // TODO(martinprobst): consider doing this for all types that get emitted as ?, not just
            // for blacklisted ones.
            const blackListedInitialized =
                !!decl.initializer && moduleTypeTranslator.isBlackListed(decl);
            if (!blackListedInitialized) {
              // getOriginalNode(decl) is required because the type checker cannot type check
              // synthesized nodes.
              const typeStr = moduleTypeTranslator.typeToClosure(ts.getOriginalNode(decl));
              localTags.push({tagName: 'type', type: typeStr});
            }
          }
          const newStmt = ts.createVariableStatement(
              varStmt.modifiers, ts.createVariableDeclarationList([decl], flags));
          if (localTags.length) addCommentOn(newStmt, localTags, jsdoc.TAGS_CONFLICTING_WITH_TYPE);
          stmts.push(newStmt);
        }

        return stmts;
      }

      /**
       * shouldEmitExportsAssignments returns true if tsickle should emit `exports.Foo = ...` style
       * export statements.
       *
       * TypeScript modules can export types. Because types are pure design-time constructs in
       * TypeScript, it does not emit any actual exported symbols for these. But tsickle has to emit
       * an export, so that downstream Closure code (including tsickle-converted Closure code) can
       * import upstream types. tsickle has to pick a module format for that, because the pure ES6
       * export would get stripped by TypeScript.
       *
       * tsickle uses CommonJS to emit googmodule, and code not using googmodule doesn't care about
       * the Closure annotations anyway, so tsickle skips emitting exports if the module target
       * isn't commonjs.
       */
      function shouldEmitExportsAssignments() {
        return tsOptions.module === ts.ModuleKind.CommonJS;
      }

      function visitTypeAliasDeclaration(typeAlias: ts.TypeAliasDeclaration): ts.Statement[] {
        // If the type is also defined as a value, skip emitting it. Closure collapses type & value
        // namespaces, the two emits would conflict if tsickle emitted both.
        const sym = moduleTypeTranslator.mustGetSymbolAtLocation(typeAlias.name);
        if (sym.flags & ts.SymbolFlags.Value) return [];
        // Type aliases are always emitted as the resolved underlying type, so there is no need to
        // emit anything, except for exported types.
        if (!transformerUtil.hasModifierFlag(typeAlias, ts.ModifierFlags.Export)) return [];
        if (!shouldEmitExportsAssignments()) return [];

        const typeName = typeAlias.name.getText();

        // Blacklist any type parameters, Closure does not support type aliases with type
        // parameters.
        moduleTypeTranslator.newTypeTranslator(typeAlias).blacklistTypeParameters(
            moduleTypeTranslator.symbolsToAliasedNames, typeAlias.typeParameters);
        const typeStr =
            host.untyped ? '?' : moduleTypeTranslator.typeToClosure(typeAlias, undefined);
        // In the case of an export, we cannot emit a `export var foo;` because TypeScript drops
        // exports that are never assigned values, and Closure requires us to not assign values to
        // typedef exports. Introducing a new local variable and exporting it can cause bugs due to
        // name shadowing and confusing TypeScript's logic on what symbols and types vs values are
        // exported. Mangling the name to avoid the conflicts would be reasonably clean, but would
        // require a two pass emit to first find all type alias names, mangle them, and emit the use
        // sites only later. With that, the fix here is to never emit type aliases, but always
        // resolve the alias and emit the underlying type (fixing references in the local module,
        // and also across modules). For downstream JavaScript code that imports the typedef, we
        // emit an "export.Foo;" that declares and exports the type, and for TypeScript has no
        // impact.
        const tags = moduleTypeTranslator.getJSDoc(typeAlias, /* reportWarnings */ true);
        tags.push({tagName: 'typedef', type: typeStr});
        const decl = ts.setSourceMapRange(
            ts.createStatement(ts.createPropertyAccess(
                ts.createIdentifier('exports'), ts.createIdentifier(typeName))),
            typeAlias);
        addCommentOn(decl, tags, jsdoc.TAGS_CONFLICTING_WITH_TYPE);
        return [decl];
      }

      /** Emits a parenthesized Closure cast: `(/** \@type ... * / (expr))`. */
      function createClosureCast(context: ts.Node, expression: ts.Expression, type: ts.Type) {
        const inner = ts.createParen(expression);
        const comment = addCommentOn(
            inner, [{tagName: 'type', type: moduleTypeTranslator.typeToClosure(context, type)}]);
        comment.hasTrailingNewLine = false;
        return ts.setSourceMapRange(ts.createParen(inner), context);
      }

      /** Converts a TypeScript type assertion into a Closure Cast. */
      function visitAssertionExpression(assertion: ts.AssertionExpression) {
        const type = typeChecker.getTypeAtLocation(assertion.type);
        return createClosureCast(assertion, ts.visitEachChild(assertion, visitor, context), type);
      }

      /**
       * Converts a TypeScript non-null assertion into a Closure Cast, by stripping |null and
       * |undefined from a union type.
       */
      function visitNonNullExpression(nonNull: ts.NonNullExpression) {
        const type = typeChecker.getTypeAtLocation(nonNull.expression);
        const nonNullType = typeChecker.getNonNullableType(type);
        return createClosureCast(
            nonNull, ts.visitEachChild(nonNull, visitor, context), nonNullType);
      }

      function visitImportDeclaration(importDecl: ts.ImportDeclaration) {
        // No need to forward declare side effect imports.
        if (!importDecl.importClause) return importDecl;
        // Introduce a goog.forwardDeclare for the module, so that if TypeScript does not emit the
        // module because it's only used in type positions, the JSDoc comments still reference a
        // valid Closure level symbol.
        const sym = typeChecker.getSymbolAtLocation(importDecl.moduleSpecifier);
        // Scripts do not have a symbol, and neither do unused modules. Scripts can still be
        // imported, either as side effect imports or with an empty import set ("{}"). TypeScript
        // does not emit a runtime load for an import with an empty list of symbols, but the import
        // forces any global declarations from the library to be visible, which is what users use
        // this for. No symbols from the script need forward declaration, so just return.
        if (!sym) return importDecl;
        // Write the export declaration here so that forward declares come after it, and
        // fileoverview comments do not get moved behind statements.
        const importPath = googmodule.resolveModuleName(
            {options: tsOptions, host: tsHost}, sourceFile.fileName,
            (importDecl.moduleSpecifier as ts.StringLiteral).text);

        moduleTypeTranslator.forwardDeclare(
            importPath, sym, /* isExplicitlyImported? */ true,
            /* default import? */ !!importDecl.importClause.name);
        return importDecl;
      }

      /**
       * Closure Compiler will fail when it finds incorrect JSDoc tags on nodes. This function
       * parses and then re-serializes JSDoc comments, escaping or removing illegal tags.
       */
      function escapeIllegalJSDoc(node: ts.Node) {
        const mjsdoc = moduleTypeTranslator.getMutableJSDoc(node);
        mjsdoc.updateComment();
      }

      /** Returns true if a value export should be emitted for the given symbol in export *. */
      function shouldEmitValueExportForSymbol(sym: ts.Symbol): boolean {
        if (sym.flags & ts.SymbolFlags.Alias) {
          sym = typeChecker.getAliasedSymbol(sym);
        }
        if ((sym.flags & ts.SymbolFlags.Value) === 0) {
          // Note: We create explicit exports of type symbols for closure in visitExportDeclaration.
          return false;
        }
        if (!tsOptions.preserveConstEnums && sym.flags & ts.SymbolFlags.ConstEnum) {
          return false;
        }
        return true;
      }

      /**
       * visitExportDeclaration forward declares exported modules and emits explicit exports for
       * types (which normally do not get emitted by TypeScript).
       */
      function visitExportDeclaration(exportDecl: ts.ExportDeclaration): ts.Node|ts.Node[] {
        const importedModuleSymbol = exportDecl.moduleSpecifier &&
            typeChecker.getSymbolAtLocation(exportDecl.moduleSpecifier)!;
        if (importedModuleSymbol) {
          // Forward declare all explicitly imported modules, so that symbols can be referenced and
          // type only modules get force-loaded.
          moduleTypeTranslator.forwardDeclare(
              (exportDecl.moduleSpecifier as ts.StringLiteral).text, importedModuleSymbol,
              /* isExplicitlyImported? */ true, /* default import? */ false);
        }

        const typesToExport: Array<[string, ts.Symbol]> = [];
        if (!exportDecl.exportClause) {
          // export * from '...'
          // Resolve the * into all value symbols exported, and update the export declaration.

          // Explicitly spelled out exports (i.e. the exports of the current module) take precedence
          // over implicit ones from export *. Use the current module's exports to filter.
          const currentModuleSymbol = typeChecker.getSymbolAtLocation(sourceFile);
          const currentModuleExports = currentModuleSymbol && currentModuleSymbol.exports;

          if (!importedModuleSymbol) {
            moduleTypeTranslator.error(exportDecl, `export * without module symbol`);
            return exportDecl;
          }
          const exportedSymbols = typeChecker.getExportsOfModule(importedModuleSymbol);
          const exportSpecifiers: ts.ExportSpecifier[] = [];
          for (const sym of exportedSymbols) {
            if (currentModuleExports && currentModuleExports.has(sym.escapedName)) continue;
            // We might have already generated an export for the given symbol.
            if (expandedStarImports.has(sym.name)) continue;
            expandedStarImports.add(sym.name);
            // Only create an export specifier for values that are exported. For types, the code
            // below creates specific export statements that match Closure's expectations.
            if (shouldEmitValueExportForSymbol(sym)) {
              exportSpecifiers.push(ts.createExportSpecifier(undefined, sym.name));
            } else {
              typesToExport.push([sym.name, sym]);
            }
          }
          exportDecl = ts.updateExportDeclaration(
              exportDecl, exportDecl.decorators, exportDecl.modifiers,
              ts.createNamedExports(exportSpecifiers), exportDecl.moduleSpecifier);
        } else {
          for (const exp of exportDecl.exportClause.elements) {
            const exportedName = transformerUtil.getIdentifierText(exp.name);
            typesToExport.push(
                [exportedName, moduleTypeTranslator.mustGetSymbolAtLocation(exp.name)]);
          }
        }
        // Do not emit typedef re-exports in untyped mode.
        if (host.untyped) return exportDecl;

        const result: ts.Node[] = [exportDecl];
        for (const [exportedName, sym] of typesToExport) {
          let aliasedSymbol = sym;
          if (sym.flags & ts.SymbolFlags.Alias) {
            aliasedSymbol = typeChecker.getAliasedSymbol(sym);
          }
          const isTypeAlias = (aliasedSymbol.flags & ts.SymbolFlags.Value) === 0 &&
              (aliasedSymbol.flags & (ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface)) !== 0;
          if (!isTypeAlias) continue;
          const typeName =
              moduleTypeTranslator.symbolsToAliasedNames.get(aliasedSymbol) || aliasedSymbol.name;
          const stmt = ts.createStatement(
              ts.createPropertyAccess(ts.createIdentifier('exports'), exportedName));
          addCommentOn(stmt, [{tagName: 'typedef', type: '!' + typeName}]);
          addSyntheticTrailingComment(
              stmt, ts.SyntaxKind.SingleLineCommentTrivia, ' re-export typedef', true);
          result.push(stmt);
        }
        return result;
      }

      /**
       * Returns the identifiers exported in a single exported statement - typically just one
       * identifier (e.g. for `export function foo()`), but multiple for `export declare var a, b`.
       */
      function getExportDeclarationNames(node: ts.Node): ts.Identifier[] {
        switch (node.kind) {
          case ts.SyntaxKind.VariableStatement:
            const varDecl = node as ts.VariableStatement;
            return varDecl.declarationList.declarations.map((d) => getExportDeclarationNames(d)[0]);
          case ts.SyntaxKind.VariableDeclaration:
          case ts.SyntaxKind.FunctionDeclaration:
          case ts.SyntaxKind.InterfaceDeclaration:
          case ts.SyntaxKind.ClassDeclaration:
          case ts.SyntaxKind.ModuleDeclaration:
            const decl = node as ts.NamedDeclaration;
            if (!decl.name || decl.name.kind !== ts.SyntaxKind.Identifier) {
              break;
            }
            return [decl.name];
          case ts.SyntaxKind.TypeAliasDeclaration:
            const typeAlias = node as ts.TypeAliasDeclaration;
            return [typeAlias.name];
          default:
            break;
        }
        moduleTypeTranslator.error(
            node, `unsupported export declaration ${ts.SyntaxKind[node.kind]}: ${node.getText()}`);
        return [];
      }

      /**
       * Ambient declarations declare types for TypeScript's benefit, and will be removede by
       * TypeScript during its emit phase. Downstream Closure code however might be importing
       * symbols from this module, so tsickle must emit a Closure-compatible exports declaration.
       */
      function visitExportedAmbient(node: ts.Node): ts.Node[] {
        if (host.untyped || !shouldEmitExportsAssignments()) return [node];

        const declNames = getExportDeclarationNames(node);
        const result: ts.Node[] = [node];
        for (const decl of declNames) {
          const sym = typeChecker.getSymbolAtLocation(decl)!;
          const isValue = sym.flags & ts.SymbolFlags.Value;
          // Non-value objects do not exist at runtime, so we cannot access the symbol (it only
          // exists in externs). Export them as a typedef, which forwards to the type in externs.
          // Note: TypeScript emits odd code for exported ambients (exports.x for variables, just x
          // for everything else). That seems buggy, and in either case this code should not attempt
          // to fix it.
          // See also https://github.com/Microsoft/TypeScript/issues/8015.
          if (!isValue) {
            // Do not emit re-exports for ModuleDeclarations.
            // Ambient ModuleDeclarations are always referenced as global symbols, so they don't
            // need to be exported.
            if (node.kind === ts.SyntaxKind.ModuleDeclaration) continue;
            const mangledName = moduleNameAsIdentifier(host, sourceFile.fileName);
            const declName = transformerUtil.getIdentifierText(decl);
            const stmt = ts.createStatement(
                ts.createPropertyAccess(ts.createIdentifier('exports'), declName));
            addCommentOn(stmt, [{tagName: 'typedef', type: `!${mangledName}.${declName}`}]);
            result.push(stmt);
          }
        }
        return result;
      }

      function visitor(node: ts.Node): ts.Node|ts.Node[] {
        if (isAmbient(node)) {
          if (!transformerUtil.hasModifierFlag(node, ts.ModifierFlags.Export)) return node;
          return visitExportedAmbient(node);
        }
        switch (node.kind) {
          case ts.SyntaxKind.ImportDeclaration:
            return visitImportDeclaration(node as ts.ImportDeclaration);
          case ts.SyntaxKind.ExportDeclaration:
            return visitExportDeclaration(node as ts.ExportDeclaration);
          case ts.SyntaxKind.ClassDeclaration:
            return visitClassDeclaration(node as ts.ClassDeclaration);
          case ts.SyntaxKind.InterfaceDeclaration:
            return visitInterfaceDeclaration(node as ts.InterfaceDeclaration);
          case ts.SyntaxKind.HeritageClause:
            return visitHeritageClause(node as ts.HeritageClause);
          case ts.SyntaxKind.Constructor:
          case ts.SyntaxKind.FunctionDeclaration:
          case ts.SyntaxKind.MethodDeclaration:
          case ts.SyntaxKind.GetAccessor:
          case ts.SyntaxKind.SetAccessor:
            addJsDocToFunctionLikeDeclaration(node as ts.FunctionLikeDeclaration);
            break;
          case ts.SyntaxKind.VariableStatement:
            return visitVariableStatement(node as ts.VariableStatement);
          case ts.SyntaxKind.PropertyDeclaration:
          case ts.SyntaxKind.PropertyAssignment:
            escapeIllegalJSDoc(node);
            break;
          case ts.SyntaxKind.Parameter:
            // Parameter properties (e.g. `constructor(/** docs */ private foo: string)`) might have
            // JSDoc comments, including JSDoc tags recognized by Closure Compiler. Prevent emitting
            // any comments on them, so that Closure doesn't error on them.
            // See test_files/parameter_properties.ts.
            const paramDecl = node as ts.ParameterDeclaration;
            if (transformerUtil.hasModifierFlag(
                    paramDecl, ts.ModifierFlags.ParameterPropertyModifier)) {
              ts.setSyntheticLeadingComments(paramDecl, []);
              jsdoc.suppressLeadingCommentsRecursively(paramDecl);
            }
            break;
          case ts.SyntaxKind.TypeAliasDeclaration:
            return visitTypeAliasDeclaration(node as ts.TypeAliasDeclaration);
          case ts.SyntaxKind.AsExpression:
          case ts.SyntaxKind.TypeAssertionExpression:
            return visitAssertionExpression(node as ts.TypeAssertion);
          case ts.SyntaxKind.NonNullExpression:
            return visitNonNullExpression(node as ts.NonNullExpression);
          default:
            break;
        }
        return ts.visitEachChild(node, visitor, context);
      }

      sourceFile = ts.visitEachChild(sourceFile, visitor, context);

      return moduleTypeTranslator.insertForwardDeclares(sourceFile);
    };
  };
}
