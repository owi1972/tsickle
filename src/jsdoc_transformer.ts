/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */



import {hasExportingDecorator} from './decorators';
import * as googmodule from './googmodule';
import * as jsdoc from './jsdoc';
import {getIdentifierText} from './rewriter';
import * as transformerUtil from './transformer_util';
import {createNotEmittedStatementWithComments, createSingleQuoteStringLiteral} from './transformer_util';
import * as typeTranslator from './type-translator';
import * as ts from './typescript';
import {hasModifierFlag} from './util';

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
}


class MutableJSDoc {
  constructor(
      private node: ts.Node, private sourceComment: ts.SynthesizedComment|null,
      public tags: jsdoc.Tag[]) {}

  updateComment(escapeExtraTags?: Set<string>) {
    const text = jsdoc.toStringWithoutStartEnd(this.tags, escapeExtraTags);
    if (this.sourceComment) {
      this.sourceComment.text = text;
      return;
    }

    const comment: ts.SynthesizedComment =
        {kind: ts.SyntaxKind.MultiLineCommentTrivia, text: '', pos: -1, end: -1};
    const comments = ts.getSyntheticLeadingComments(this.node) || [];
    comments.push(comment);
    ts.setSyntheticLeadingComments(this.node, comments);
  }
}

class JSDocTransformerContext {
  /**
   * A mapping of aliases for symbols in the current file, used when emitting types. TypeScript
   * emits imported symbols with unpredictable prefixes. To generate correct type annotations,
   * tsickle creates its own aliases for types, and registers them in this map (see
   * `emitImportDeclaration` and `forwardDeclare()` below). The aliases are then used when emitting
   * types.
   */
  symbolsToAliasedNames = new Map<ts.Symbol, string>();

  /**
   * The set of module symbols forward declared in the local namespace (with goog.forwarDeclare).
   *
   * Symbols not imported must be declared, which is done by adding forward declares to
   * `extraImports` below.
   */
  private forwardDeclaredModules = new Set<ts.Symbol>();
  private forwardDeclares: ts.Statement[] = [];
  private forwardDeclareCounter = 1;

  constructor(
      private host: AnnotatorHost, private diagnostics: ts.Diagnostic[],
      public typeChecker: ts.TypeChecker, public sourceFile: ts.SourceFile) {}

  logWarning(warning: ts.Diagnostic) {
    if (this.host.logWarning) this.host.logWarning(warning);
  }

  /**
   * debug logs a debug warning.  These should only be used for cases
   * where tsickle is making a questionable judgement about what to do.
   * By default, tsickle does not report any warnings to the caller,
   * and warnings are hidden behind a debug flag, as warnings are only
   * for tsickle to debug itself.
   */
  debugWarn(node: ts.Node, messageText: string) {
    if (!this.host.logWarning) return;
    // Use a ts.Diagnosic so that the warning includes context and file offets.
    const diagnostic: ts.Diagnostic = {
      file: this.sourceFile,
      start: node.getStart(),
      length: node.getEnd() - node.getStart(),
      messageText,
      category: ts.DiagnosticCategory.Warning,
      code: 0,
    };
    this.host.logWarning(diagnostic);
  }

  addDiagnostic(diagnostic: ts.Diagnostic) {
    this.diagnostics.push(diagnostic);
  }

  error(node: ts.Node, messageText: string) {
    const diagnostic: ts.Diagnostic = {
      file: this.sourceFile,
      start: node.getStart(),
      length: node.getEnd() - node.getStart(),
      messageText,
      category: ts.DiagnosticCategory.Error,
      code: 0,
    };
    this.addDiagnostic(diagnostic);
  }

  /**
   * Convert a TypeScript ts.Type into the equivalent Closure type.
   *
   * @param context The ts.Node containing the type reference; used for resolving symbols
   *     in context.
   * @param type The type to translate; if not provided, the Node's type will be used.
   * @param resolveAlias If true, do not emit aliases as their symbol, but rather as the resolved
   *     type underlying the alias. This should be true only when emitting the typedef itself.
   */
  typeToClosure(context: ts.Node, type?: ts.Type): string {
    if (this.host.untyped) {
      return '?';
    }

    const typeChecker = this.typeChecker;
    if (!type) {
      type = typeChecker.getTypeAtLocation(context);
    }
    return this.newTypeTranslator(context).translate(type);
  }

  newTypeTranslator(context: ts.Node) {
    const translator = new typeTranslator.TypeTranslator(
        this.typeChecker, context, this.host.typeBlackListPaths, this.symbolsToAliasedNames,
        (sym: ts.Symbol) => this.ensureSymbolDeclared(sym));
    translator.warn = msg => this.debugWarn(context, msg);
    return translator;
  }

  /** Finds an exported (i.e. not global) declaration for the given symbol. */
  protected findExportedDeclaration(sym: ts.Symbol): ts.Declaration|undefined {
    // TODO(martinprobst): it's unclear when a symbol wouldn't have a declaration, maybe just for
    // some builtins (e.g. Symbol)?
    if (!sym.declarations || sym.declarations.length === 0) return undefined;
    // A symbol declared in this file does not need to be imported.
    if (sym.declarations.some(d => d.getSourceFile() === this.sourceFile)) return undefined;

    // Find an exported declaration.
    // Because tsickle runs with the --declaration flag, all types referenced from exported types
    // must be exported, too, so there must either be some declaration that is exported, or the
    // symbol is actually a global declaration (declared in a script file, not a module).
    const decl = sym.declarations.find(d => {
      // Check for Export | Default (default being a default export).
      if (!hasModifierFlag(d, ts.ModifierFlags.ExportDefault)) return false;
      // Exclude symbols declared in `declare global {...}` blocks, they are global and don't need
      // imports.
      let current: ts.Node|undefined = d;
      while (current) {
        if (current.flags & ts.NodeFlags.GlobalAugmentation) return false;
        current = current.parent;
      }
      return true;
    });
    return decl;
  }

  /**
   * Returns the `const x = goog.forwardDeclare...` text for an import of the given `importPath`.
   * This also registers aliases for symbols from the module that map to this forward declare.
   */
  private forwardDeclare(
      importPath: string, moduleSymbol: ts.Symbol|undefined, isDefaultImport = false) {
    if (this.host.untyped) return;
    const nsImport = googmodule.extractGoogNamespaceImport(importPath);
    const forwardDeclarePrefix = `tsickle_forward_declare_${++this.forwardDeclareCounter}`;
    const moduleNamespace = nsImport !== null ?
        nsImport :
        this.host.pathToModuleName(this.sourceFile.fileName, importPath);

    // In TypeScript, importing a module for use in a type annotation does not cause a runtime load.
    // In Closure Compiler, goog.require'ing a module causes a runtime load, so emitting requires
    // here would cause a change in load order, which is observable (and can lead to errors).
    // Instead, goog.forwardDeclare types, which allows using them in type annotations without
    // causing a load. See below for the exception to the rule.
    // const forwardDeclarePrefix = goog.forwardDeclare(moduleNamespace)
    this.forwardDeclares.push(ts.createVariableStatement(
        [ts.createToken(ts.SyntaxKind.ConstKeyword)],
        [ts.createVariableDeclaration(
            forwardDeclarePrefix, undefined,
            ts.createCall(
                ts.createPropertyAccess(ts.createIdentifier('goog'), 'forwardDeclare'), undefined,
                [createSingleQuoteStringLiteral(moduleNamespace)]))]));
    // Scripts do not have a symbol. Scripts can still be imported, either as side effect imports or
    // with an empty import set ("{}"). TypeScript does not emit a runtime load for an import with
    // an empty list of symbols, but the import forces any global declarations from the library to
    // be visible, which is what users use this for. No symbols from the script need forward
    // declaration, so just return.
    if (!moduleSymbol) return;
    this.forwardDeclaredModules.add(moduleSymbol);
    const exports = this.typeChecker.getExportsOfModule(moduleSymbol).map(e => {
      if (e.flags & ts.SymbolFlags.Alias) {
        e = this.typeChecker.getAliasedSymbol(e);
      }
      return e;
    });
    const hasValues = exports.some(e => {
      const isValue = (e.flags & ts.SymbolFlags.Value) !== 0;
      const isConstEnum = (e.flags & ts.SymbolFlags.ConstEnum) !== 0;
      // const enums are inlined by TypeScript (if preserveConstEnums=false), so there is never a
      // value import generated for them. That means for the purpose of force-importing modules,
      // they do not count as values. If preserveConstEnums=true, this shouldn't hurt.
      return isValue && !isConstEnum;
    });
    if (!hasValues) {
      // Closure Compiler's toolchain will drop files that are never goog.require'd *before* type
      // checking (e.g. when using --closure_entry_point or similar tools). This causes errors
      // complaining about values not matching 'NoResolvedType', or modules not having a certain
      // member.
      // To fix, explicitly goog.require() modules that only export types. This should usually not
      // cause breakages due to load order (as no symbols are accessible from the module - though
      // contrived code could observe changes in side effects).
      // This is a heuristic - if the module exports some values, but those are never imported,
      // the file will still end up not being imported. Hopefully modules that export values are
      // imported for their value in some place.
      // goog.require("${moduleNamespace}");
      const hardRequire = ts.createStatement(ts.createCall(
          ts.createPropertyAccess(ts.createIdentifier('goog'), 'require'), undefined,
          [createSingleQuoteStringLiteral(moduleNamespace)]));
      const comment: ts.SynthesizedComment = {
        kind: ts.SyntaxKind.SingleLineCommentTrivia,
        text: '// force type-only module to be loaded',
        hasTrailingNewLine: true,
        pos: -1,
        end: -1,
      };
      ts.setSyntheticTrailingComments(hardRequire, [comment]);
      this.forwardDeclares.push(hardRequire);
    }
    for (const sym of exports) {
      // tsickle does not emit exports for ambient namespace declarations:
      //    "export declare namespace {...}"
      // So tsickle must not introduce aliases for them that point to the imported module, as those
      // then don't resolve in Closure Compiler.
      if (!sym.declarations ||
          !sym.declarations.some(
              d => d.kind !== ts.SyntaxKind.ModuleDeclaration || !isAmbient(d))) {
        continue;
      }
      // goog: imports don't actually use the .default property that TS thinks they have.
      const qualifiedName = nsImport && isDefaultImport ? forwardDeclarePrefix :
                                                          forwardDeclarePrefix + '.' + sym.name;
      this.symbolsToAliasedNames.set(sym, qualifiedName);
    }
  }

  protected ensureSymbolDeclared(sym: ts.Symbol) {
    const decl = this.findExportedDeclaration(sym);
    if (!decl) return;

    // Actually import the symbol.
    const sf = decl.getSourceFile();
    const moduleSymbol = this.typeChecker.getSymbolAtLocation(sf);
    if (!moduleSymbol) {
      return;  // A source file might not have a symbol if it's not a module (no ES6 im/exports).
    }
    // Already imported?
    if (this.forwardDeclaredModules.has(moduleSymbol)) return;
    // TODO(martinprobst): this should possibly use fileNameToModuleId.
    this.forwardDeclare(sf.fileName, moduleSymbol);
  }

  getMutableJSDoc(node: ts.Node): MutableJSDoc {
    function newSyntheticComment() {
      return new MutableJSDoc(node, null, []);
    }
    const text = node.getFullText();
    const comments = jsdoc.syntheticLeadingComments(node);
    if (!comments || comments.length === 0) return newSyntheticComment();

    for (let i = comments.length - 1; i >= 0; i--) {
      const parsed = jsdoc.parse(comments[i].text);
      if (parsed) {
        if (parsed.warnings) {
          this.diagnostics.push({
            file: this.sourceFile,
            start: node.getFullStart(),
            length: node.getStart() - node.getStart(),
            messageText: parsed.warnings.join('\n'),
            category: ts.DiagnosticCategory.Warning,
            code: 0,
          });
        }
        return new MutableJSDoc(node, comments[i], parsed.tags);
      }
    }
    return newSyntheticComment();
  }
}

/** @return true if node has the specified modifier flag set. */
function isAmbient(node: ts.Node): boolean {
  let current: ts.Node|undefined = node;
  while (current) {
    if (hasModifierFlag(current, ts.ModifierFlags.Ambient)) return true;
    current = current.parent;
  }
  return false;
}

type HasTypeParameters =
    ts.InterfaceDeclaration|ts.ClassLikeDeclaration|ts.TypeAliasDeclaration|ts.SignatureDeclaration;

function maybeAddTemplateClause(docTags: jsdoc.Tag[], decl: HasTypeParameters) {
  if (!decl.typeParameters) return;
  // Closure does not support template constraints (T extends X), these are ignored below.
  docTags.push({
    tagName: 'template',
    text: decl.typeParameters.map(tp => getIdentifierText(tp.name)).join(', ')
  });
}



function maybeAddHeritageClauses(
    docTags: jsdoc.Tag[], context: JSDocTransformerContext,
    decl: ts.ClassLikeDeclaration|ts.InterfaceDeclaration) {
  if (!decl.heritageClauses) return;
  for (const heritage of decl.heritageClauses!) {
    if (!heritage.types) continue;
    const isClass = decl.kind === ts.SyntaxKind.ClassDeclaration;
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

      // We can only @implements an interface, not a class.
      // But it's fine to translate TS "implements Class" into Closure
      // "@extends {Class}" because this is just a type hint.
      const sym = context.typeChecker.getSymbolAtLocation(impl.expression);
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
        context.debugWarn(decl, `could not resolve supertype: ${impl.getText()}`);
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
        const type = context.typeChecker.getDeclaredTypeOfSymbol(sym);
        if (!type.symbol) {
          // It's not clear when this can happen, but if it does all we
          // do is fail to emit the @implements, which isn't so harmful.
          continue;
        }
        alias = type.symbol;
      }
      if (alias.flags & ts.SymbolFlags.Alias) {
        alias = context.typeChecker.getAliasedSymbol(alias);
      }
      const typeTranslator = context.newTypeTranslator(impl.expression);
      if (typeTranslator.isBlackListed(alias)) {
        continue;
      }
      if (alias.flags & ts.SymbolFlags.Class) {
        if (!isClass) {
          // Only classes can extend classes in TS. Ignoring the heritage clause should be safe,
          // as interfaces are @record anyway, so should prevent property disambiguation.

          // Problem: validate that methods are there?
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
      docTags.push({tagName, type: typeTranslator.symbolToString(sym, true)});
    }
  }
}

/**
 * Handles emittng the jsdoc for methods, including overloads.
 * If overloaded, merges the signatures in the list of SignatureDeclarations into a single jsdoc.
 * - Total number of parameters will be the maximum count found across all variants.
 * - Different names at the same parameter index will be joined with "_or_"
 * - Variable args (...type[] in TypeScript) will be output as "...type",
 *    except if found at the same index as another argument.
 * @param fnDecls Pass > 1 declaration for overloads of same name
 * @return The list of parameter names that should be used to emit the actual
 *    function statement; for overloads, name will have been merged.
 */
function getFunctionTypeJSDoc(
    context: JSDocTransformerContext, fnDecls: ts.SignatureDeclaration[],
    extraTags: jsdoc.Tag[] = []): [jsdoc.Tag[], string[]] {
  const typeChecker = context.typeChecker;
  const newDoc = extraTags;
  const lens = fnDecls.map(fnDecl => fnDecl.parameters.length);
  const minArgsCount = Math.min(...lens);
  const maxArgsCount = Math.max(...lens);
  const isConstructor = fnDecls.find(d => d.kind === ts.SyntaxKind.Constructor) !== undefined;
  // For each parameter index i, paramTags[i] is an array of parameters
  // that can be found at index i.  E.g.
  //    function foo(x: string)
  //    function foo(y: number, z: string)
  // then paramTags[0] = [info about x, info about y].
  const paramTags: jsdoc.Tag[][] = [];
  const returnTags: jsdoc.Tag[] = [];
  const typeParameterNames = new Set<string>();

  let firstDoc: MutableJSDoc|null = null;
  for (const fnDecl of fnDecls) {
    // Construct the JSDoc comment by reading the existing JSDoc, if
    // any, and merging it with the known types of the function
    // parameters and return type.
    const mjsdoc = context.getMutableJSDoc(fnDecl);
    if (!firstDoc) firstDoc = mjsdoc;

    // Copy all the tags other than @param/@return into the new
    // JSDoc without any change; @param/@return are handled specially.
    // TODO: there may be problems if an annotation doesn't apply to all overloads;
    // is it worth checking for this and erroring?
    for (const tag of mjsdoc.tags) {
      if (tag.tagName === 'param' || tag.tagName === 'return') continue;
      newDoc.push(tag);
    }

    // Add @abstract on "abstract" declarations.
    if (hasModifierFlag(fnDecl, ts.ModifierFlags.Abstract)) {
      newDoc.push({tagName: 'abstract'});
    }

    // Add any @template tags.
    // Multiple declarations with the same template variable names should work:
    // the declarations get turned into union types, and Closure Compiler will need
    // to find a union where all type arguments are satisfied.
    if (fnDecl.typeParameters) {
      for (const tp of fnDecl.typeParameters) {
        typeParameterNames.add(getIdentifierText(tp.name));
      }
    }
    // Merge the parameters into a single list of merged names and list of types
    const sig = typeChecker.getSignatureFromDeclaration(fnDecl);
    if (!sig || !sig.declaration) throw new Error(`invalid signature ${fnDecl.name}`);
    if (sig.declaration.kind === ts.SyntaxKindJSDocSignature) {
      throw new Error(`JSDoc signature ${fnDecl.name}`);
    }
    for (let i = 0; i < sig.declaration.parameters.length; i++) {
      const paramNode = sig.declaration.parameters[i];

      const name = getParameterName(paramNode, i);
      const isThisParam = name === 'this';

      const newTag: jsdoc.Tag = {
        tagName: isThisParam ? 'this' : 'param',
        optional: paramNode.initializer !== undefined || paramNode.questionToken !== undefined,
        parameterName: isThisParam ? undefined : name,
      };

      let type = typeChecker.getTypeAtLocation(paramNode);
      if (paramNode.dotDotDotToken !== undefined) {
        newTag.restParam = true;
        // In TypeScript you write "...x: number[]", but in Closure
        // you don't write the array: "@param {...number} x".  Unwrap
        // the Array<> wrapper.
        const typeRef = type as ts.TypeReference;
        if (!typeRef.typeArguments) throw new Error('invalid rest param');
        type = typeRef.typeArguments![0];
      }
      newTag.type = context.typeToClosure(fnDecl, type);

      for (const {tagName, parameterName, text} of mjsdoc.tags) {
        if (tagName === 'param' && parameterName === newTag.parameterName) {
          newTag.text = text;
          break;
        }
      }
      if (!paramTags[i]) paramTags.push([]);
      paramTags[i].push(newTag);
    }

    // Return type.
    if (!isConstructor) {
      const retType = typeChecker.getReturnTypeOfSignature(sig);
      const retTypeString: string = context.typeToClosure(fnDecl, retType);
      let returnDoc: string|undefined;
      for (const {tagName, text} of mjsdoc.tags) {
        if (tagName === 'return') {
          returnDoc = text;
          break;
        }
      }
      returnTags.push({
        tagName: 'return',
        type: retTypeString,
        text: returnDoc,
      });
    }
  }

  if (typeParameterNames.size > 0) {
    newDoc.push({tagName: 'template', text: Array.from(typeParameterNames.values()).join(', ')});
  }

  // Merge the JSDoc tags for each overloaded parameter.
  // Ensure each parameter has a unique name; the merging process can otherwise
  // accidentally generate the same parameter name twice.
  const paramNames = new Set();
  let foundOptional = false;
  for (let i = 0; i < maxArgsCount; i++) {
    const paramTag = jsdoc.merge(paramTags[i]);
    if (paramNames.has(paramTag.parameterName)) {
      paramTag.parameterName += i.toString();
    }
    paramNames.add(paramTag.parameterName);
    // If the tag is optional, mark parameters following optional as optional,
    // even if they are not, since Closure restricts this, see
    // https://github.com/google/closure-compiler/issues/2314
    if (!paramTag.restParam && (paramTag.optional || foundOptional || i >= minArgsCount)) {
      foundOptional = true;
      paramTag.optional = true;
    }
    newDoc.push(paramTag);
    if (paramTag.restParam) {
      // Cannot have any parameters after a rest param.
      // Just dump the remaining parameters.
      break;
    }
  }

  // Merge the JSDoc tags for each overloaded return.
  if (!isConstructor) {
    newDoc.push(jsdoc.merge(returnTags));
  }

  return [newDoc, newDoc.filter(t => t.tagName === 'param').map(t => t.parameterName!)];
}

/** Flags that declare a field of the same name if set on a ctor parameter. */
const FIELD_DECLARATION_MODIFIERS: ts.ModifierFlags = ts.ModifierFlags.Private |
    ts.ModifierFlags.Protected | ts.ModifierFlags.Public | ts.ModifierFlags.Readonly;

/**
 * emitMemberTypes emits the type annotations for members of a class. It's necessary in the case
 * where TypeScript syntax specifies there are additional properties on the class, because to
 * declare these in Closure you must declare these separately from the class.
 */
function createMemberTypeDeclaration(
    context: JSDocTransformerContext,
    typeDecl: ts.ClassDeclaration|ts.InterfaceDeclaration): ts.IfStatement|null {
  // Gather parameter properties from the constructor, if it exists.
  const ctors: ts.ConstructorDeclaration[] = [];
  let paramProps: ts.ParameterDeclaration[] = [];
  const nonStaticProps: ts.PropertyDeclaration[] = [];
  const staticProps: ts.PropertyDeclaration[] = [];
  const abstractMethods: ts.FunctionLikeDeclaration[] = [];
  for (const member of typeDecl.members) {
    if (member.kind === ts.SyntaxKind.Constructor) {
      ctors.push(member as ts.ConstructorDeclaration);
    } else if (member.kind === ts.SyntaxKind.PropertyDeclaration) {
      const prop = member as ts.PropertyDeclaration;
      const isStatic = hasModifierFlag(prop, ts.ModifierFlags.Static);
      if (isStatic) {
        staticProps.push(prop);
      } else {
        nonStaticProps.push(prop);
      }
    } else if (
        (hasModifierFlag(member, ts.ModifierFlags.Abstract) ||
         ts.isInterfaceDeclaration(typeDecl)) &&
        (member.kind === ts.SyntaxKind.MethodDeclaration ||
         member.kind === ts.SyntaxKind.MethodSignature ||
         member.kind === ts.SyntaxKind.GetAccessor || member.kind === ts.SyntaxKind.SetAccessor)) {
      abstractMethods.push(
          member as ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration);
    }
  }

  if (ctors.length > 0) {
    const ctor = ctors[0];
    paramProps = ctor.parameters.filter(p => hasModifierFlag(p, FIELD_DECLARATION_MODIFIERS));
  }

  if (nonStaticProps.length === 0 && paramProps.length === 0 && staticProps.length === 0 &&
      abstractMethods.length === 0) {
    // There are no members so we don't need to emit any type
    // annotations helper.
    return null;
  }

  if (!typeDecl.name) {
    context.debugWarn(typeDecl, 'cannot add types on unnamed declarations');
    return null;
  }

  const className = getIdentifierText(typeDecl.name);
  const staticPropAccess = ts.createIdentifier(className);
  const instancePropAccess = ts.createPropertyAccess(staticPropAccess, 'prototype');
  const propertyDecls = [
    ...staticProps.map(p => createClosurePropertyDeclaration(context, staticPropAccess, p)),
    ...nonStaticProps.map((p) => createClosurePropertyDeclaration(context, instancePropAccess, p)),
    ...paramProps.map((p) => createClosurePropertyDeclaration(context, instancePropAccess, p)),
  ];

  for (const fnDecl of abstractMethods) {
    const name = propertyName(fnDecl);
    if (!name) {
      context.error(fnDecl, 'anonymous abstract function');
      continue;
    }
    const [tags, paramNames] = getFunctionTypeJSDoc(context, [fnDecl], []);
    if (hasExportingDecorator(fnDecl, context.typeChecker)) tags.push({tagName: 'export'});
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
    propertyDecls.push(ts.setOriginalNode(abstractFnDecl, fnDecl));
  }

  // See test_files/fields/fields.ts:BaseThatThrows for a note on this wrapper.
  return ts.createIf(
      ts.createLiteral(false),
      ts.createBlock(propertyDecls.filter((d): d is ts.Statement => d !== null), true));
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
function isValidClosurePropertyName(name: string): boolean {
  // In local experimentation, it appears that reserved words like 'var' and
  // 'if' are legal JS and still accepted by Closure.
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

function propertyName(prop: ts.NamedDeclaration): string|null {
  if (!prop.name) return null;

  switch (prop.name.kind) {
    case ts.SyntaxKind.Identifier:
      return getIdentifierText(prop.name as ts.Identifier);
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

/** Returns the Closure name of a function parameter, special-casing destructuring. */
function getParameterName(param: ts.ParameterDeclaration, index: number): string {
  switch (param.name.kind) {
    case ts.SyntaxKind.Identifier:
      let name = getIdentifierText(param.name as ts.Identifier);
      // TypeScript allows parameters named "arguments", but Closure
      // disallows this, even in externs.
      if (name === 'arguments') name = 'tsickle_arguments';
      return name;
    case ts.SyntaxKind.ArrayBindingPattern:
    case ts.SyntaxKind.ObjectBindingPattern:
      // Closure crashes if you put a binding pattern in the externs.
      // Avoid this by just generating an unused name; the name is
      // ignored anyway.
      return `__${index}`;
    default:
      // The above list of kinds is exhaustive.  param.name is 'never' at this point.
      const paramName = param.name as ts.Node;
      throw new Error(`unhandled function parameter kind: ${ts.SyntaxKind[paramName.kind]}`);
  }
}

/** Removes comment metacharacters from a string, to make it safe to embed in a comment. */
function escapeForComment(str: string): string {
  return str.replace(/\/\*/g, '__').replace(/\*\//g, '__');
}

function createClosurePropertyDeclaration(
    context: JSDocTransformerContext, expr: ts.Expression,
    prop: ts.PropertyDeclaration|ts.ParameterDeclaration): ts.Statement|null {
  const name = propertyName(prop);
  if (!name) {
    context.debugWarn(prop, `handle strange member:\n${escapeForComment(prop.getText())}`);
    return null;
  }

  let type = context.typeToClosure(prop);
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
  if (prop.questionToken && type === '?') type += '|undefined';

  const mjsdoc = context.getMutableJSDoc(prop);
  mjsdoc.tags.push({tagName: 'type', type});
  if (hasExportingDecorator(prop, context.typeChecker)) {
    mjsdoc.tags.push({tagName: 'export'});
  }
  // Avoid printing annotations that can conflict with @type
  // This avoids Closure's error "type annotation incompatible with other annotations"
  const declStmt =
      ts.setOriginalNode(ts.createStatement(ts.createPropertyAccess(expr, name)), prop);
  mjsdoc.updateComment(jsdoc.TAGS_CONFLICTING_WITH_TYPE);
  return declStmt;
}


/**
 * commonJsToGoogmoduleTransformer returns a transformer factory that converts TypeScript's
 * CommonJS module emit to Closure Compiler compatible goog.module and goog.require statements.
 */
export function jsdocTransformer(
    host: AnnotatorHost, typeChecker: ts.TypeChecker, diagnostics: ts.Diagnostic[]):
    (context: ts.TransformationContext) => ts.Transformer<ts.SourceFile> {
  return (context: ts.TransformationContext): ts.Transformer<ts.SourceFile> => {
    return (sourceFile: ts.SourceFile) => {
      const jsdContext = new JSDocTransformerContext(host, diagnostics, typeChecker, sourceFile);

      function visitClassDeclaration(classDecl: ts.ClassDeclaration): ts.Statement[] {
        const mjsdoc = jsdContext.getMutableJSDoc(classDecl);
        if (hasModifierFlag(classDecl, ts.ModifierFlags.Abstract)) {
          mjsdoc.tags.push({tagName: 'abstract'});
        }

        maybeAddTemplateClause(mjsdoc.tags, classDecl);
        if (!host.untyped) {
          maybeAddHeritageClauses(mjsdoc.tags, jsdContext, classDecl);
        }
        if (mjsdoc.tags.length > 0) {
          mjsdoc.updateComment();
        }
        const decls: ts.Statement[] = [classDecl];
        const memberDecl = createMemberTypeDeclaration(jsdContext, classDecl);
        if (memberDecl) decls.push(memberDecl);
        return decls;
      }

      function visitInterfaceDeclaration(iface: ts.InterfaceDeclaration): ts.Statement[] {
        const sym = typeChecker.getSymbolAtLocation(iface.name);
        if (!sym) {
          jsdContext.error(iface, 'interface with no symbol');
          return [];
        }
        // If this symbol is both a type and a value, we cannot emit both into Closure's
        // single namespace.
        if (sym.flags & ts.SymbolFlags.Value) {
          return [transformerUtil.createSingleLineComment(
              iface, 'interface has both a type and a value, skipping emit')];
        }

        const mjsdoc = jsdContext.getMutableJSDoc(iface) || [];
        mjsdoc.tags.push({tagName: 'record'});
        maybeAddTemplateClause(mjsdoc.tags, iface);
        if (!host.untyped) {
          maybeAddHeritageClauses(mjsdoc.tags, jsdContext, iface);
        }
        const name = getIdentifierText(iface.name);
        const modifiers = hasModifierFlag(iface, ts.ModifierFlags.Export) ?
            [ts.createToken(ts.SyntaxKind.ExportKeyword)] :
            undefined;
        const decl = ts.setOriginalNode(
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
        mjsdoc.updateComment();
        const memberDecl = createMemberTypeDeclaration(jsdContext, iface);
        return memberDecl ? [decl, memberDecl] : [decl];
      }

      function visitor(node: ts.Node): ts.Node|ts.Node[] {
        switch (node.kind) {
          case ts.SyntaxKind.ClassDeclaration:
            return visitClassDeclaration(node as ts.ClassDeclaration);
          case ts.SyntaxKind.InterfaceDeclaration:
            return visitInterfaceDeclaration(node as ts.InterfaceDeclaration);
          default:
            break;
        }
        return ts.visitEachChild(node, visitor, context);
      }

      return ts.visitEachChild(sourceFile, visitor, context);
    };
  };
}
