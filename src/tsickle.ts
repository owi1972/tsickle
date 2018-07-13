/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as path from 'path';
import {SourceMapConsumer, SourceMapGenerator} from 'source-map';

import {decoratorDownlevelTransformer} from './decorator_downlevel_transformer';
import {hasExportingDecorator} from './decorators';
import {enumTransformer} from './enum_transformer';
import {transformFileoverviewComment} from './fileoverview_comment_transformer';
import * as googmodule from './googmodule';
import * as jsdoc from './jsdoc';
import {ModulesManifest} from './modules_manifest';
import {getEntityNameText, getIdentifierText, Rewriter, unescapeName} from './rewriter';
import {containsInlineSourceMap, extractInlineSourceMap, parseSourceMap, removeInlineSourceMap, setInlineSourceMap, SourceMapper} from './source_map_utils';
import {createTransformerFromSourceMap} from './transformer_sourcemap';
import {createCustomTransformers} from './transformer_util';
import * as typeTranslator from './type-translator';
import * as ts from './typescript';
import {hasModifierFlag, isDtsFileName} from './util';
// Retained here for API compatibility.
export {getGeneratedExterns} from './externs';

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

/**
 * Symbols that are already declared as externs in Closure, that should
 * be avoided by tsickle's "declare ..." => externs.js conversion.
 */
export let closureExternsBlacklist: string[] = [
  'exports',
  'global',
  'module',
  // ErrorConstructor is the interface of the Error object itself.
  // tsickle detects that this is part of the TypeScript standard library
  // and assumes it's part of the Closure standard library, but this
  // assumption is wrong for ErrorConstructor.  To properly handle this
  // we'd somehow need to map methods defined on the ErrorConstructor
  // interface into properties on Closure's Error object, but for now it's
  // simpler to just blacklist it.
  'ErrorConstructor',
  'Symbol',
  'WorkerGlobalScope',
];

/** Returns a fileName:line:column string for the given position in the file. */
function formatLocation(sf: ts.SourceFile, start: number|undefined) {
  // TODO(evanm): remove this, because to be correct it needs a
  // ts.FormatDiagnosticsHost to resolve paths against.
  let res = sf.fileName;
  if (start !== undefined) {
    const {line, character} = sf.getLineAndCharacterOfPosition(start);
    res += ':' + (line + 1) + ':' + (character + 1);
  }
  return res;
}

/** @return true if node has the specified modifier flag set. */
function isAmbient(node: ts.Node): boolean {
  let current: ts.Node|undefined = node;
  while (current) {
    if (hasModifierFlag(current, ts.ModifierFlags.Ambient)) return true;
    if (ts.isSourceFile(current) && isDtsFileName(current.fileName)) return true;
    current = current.parent;
  }
  return false;
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

/** Flags that declare a field of the same name if set on a ctor parameter. */
const FIELD_DECLARATION_MODIFIERS: ts.ModifierFlags = ts.ModifierFlags.Private |
    ts.ModifierFlags.Protected | ts.ModifierFlags.Public | ts.ModifierFlags.Readonly;

/**
 * A symbol combined with its name in the local file. Symbols can be renamed on import or export
 * (`import {Foo as Bar}`).
 */
interface NamedSymbol {
  /** The local name of the symbol (named `Bar` in the example above). */
  name: string;
  /** The symbol (named `Foo` in the example above). */
  sym: ts.Symbol;
}

/**
 * A Rewriter subclass that adds Tsickle-specific (Closure translation) functionality.
 *
 * One Rewriter subclass manages .ts => .ts+Closure translation.
 * Another Rewriter subclass manages .ts => externs translation.
 */
abstract class ClosureRewriter extends Rewriter {
  /**
   * A mapping of aliases for symbols in the current file, used when emitting types.
   * TypeScript emits imported symbols with unpredictable prefixes. To generate correct type
   * annotations, tsickle creates its own aliases for types, and registers them in this map (see
   * `emitImportDeclaration` and `forwardDeclare()` below). The aliases are then used when emitting
   * types.
   */
  symbolsToAliasedNames = new Map<ts.Symbol, string>();

  constructor(
      protected typeChecker: ts.TypeChecker, file: ts.SourceFile, protected host: AnnotatorHost,
      sourceMapper?: SourceMapper) {
    super(file, sourceMapper);
  }

  /** Finds an exported (i.e. not global) declaration for the given symbol. */
  protected findExportedDeclaration(sym: ts.Symbol): ts.Declaration|undefined {
    // TODO(martinprobst): it's unclear when a symbol wouldn't have a declaration, maybe just for
    // some builtins (e.g. Symbol)?
    if (!sym.declarations || sym.declarations.length === 0) return undefined;
    // A symbol declared in this file does not need to be imported.
    if (sym.declarations.some(d => d.getSourceFile() === this.file)) return undefined;

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

  /** Called to ensure that a symbol is declared in the current file's scope. */
  protected abstract ensureSymbolDeclared(sym: ts.Symbol): void;

  /**
   * Get the ts.Symbol at a location or throw.
   * The TypeScript API can return undefined when fetching a symbol, but
   * in many contexts we know it won't (e.g. our input is already type-checked).
   */
  mustGetSymbolAtLocation(node: ts.Node): ts.Symbol {
    const sym = this.typeChecker.getSymbolAtLocation(node);
    if (!sym) throw new Error('no symbol');
    return sym;
  }

  /**
   * Handles emittng the jsdoc for methods, including overloads.
   * If overloaded, merges the signatures in the list of SignatureDeclarations into a single jsdoc.
   * - Total number of parameters will be the maximum count found across all variants.
   * - Different names at the same parameter index will be joined with "_or_"
   * - Variable args (...type[] in TypeScript) will be output as "...type",
   *    except if found at the same index as another argument.
   * @param  fnDecls Pass > 1 declaration for overloads of same name
   * @return The list of parameter names that should be used to emit the actual
   *    function statement; for overloads, name will have been merged.
   */
  emitFunctionType(fnDecls: ts.SignatureDeclaration[], extraTags: jsdoc.Tag[] = []): string[] {
    const typeChecker = this.typeChecker;
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

    for (const fnDecl of fnDecls) {
      // Construct the JSDoc comment by reading the existing JSDoc, if
      // any, and merging it with the known types of the function
      // parameters and return type.
      const docTags = this.getJSDoc(fnDecl) || [];

      // Copy all the tags other than @param/@return into the new
      // JSDoc without any change; @param/@return are handled specially.
      // TODO: there may be problems if an annotation doesn't apply to all overloads;
      // is it worth checking for this and erroring?
      for (const tag of docTags) {
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
        newTag.type = this.typeToClosure(fnDecl, type);

        for (const {tagName, parameterName, text} of docTags) {
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
        const retTypeString: string = this.typeToClosure(fnDecl, retType);
        let returnDoc: string|undefined;
        for (const {tagName, text} of docTags) {
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

    this.emit('\n' + jsdoc.toString(newDoc));
    return newDoc.filter(t => t.tagName === 'param').map(t => t.parameterName!);
  }

  /**
   * Returns null if there is no existing comment.
   */
  getJSDoc(node: ts.Node): jsdoc.Tag[]|null {
    const text = node.getFullText();
    const comments = ts.getLeadingCommentRanges(text, 0);

    if (!comments || comments.length === 0) return null;

    // We need to search backwards for the first JSDoc comment to avoid ignoring such when another
    // code-level comment is between that comment and the function declaration (see
    // testfiles/doc_params for an example).
    let docRelativePos = 0;
    let parsed: jsdoc.ParsedJSDocComment|null = null;
    for (let i = comments.length - 1; i >= 0; i--) {
      const {pos, end} = comments[i];
      // end is relative within node.getFullText(), add getFullStart to obtain coordinates that are
      // comparable to node positions.
      const docRelativeEnd = end + node.getFullStart();
      if (docRelativeEnd <= this.file.getStart() &&
          this.file.text.substring(docRelativeEnd).startsWith('\n\n')) {
        // This comment is at the very beginning of the file and there's an empty line between the
        // comment and this node, it's a "detached comment". That means we should treat it as a
        // file-level comment, not attached to this code node.
        return null;
      }

      const comment = text.substring(pos, end);
      parsed = jsdoc.parse(comment);
      if (parsed) {
        docRelativePos = node.getFullStart() + pos;
        break;
      }
    }

    if (!parsed) return null;

    if (parsed.warnings) {
      const start = docRelativePos;
      this.diagnostics.push({
        file: this.file,
        start,
        length: node.getStart() - start,
        messageText: parsed.warnings.join('\n'),
        category: ts.DiagnosticCategory.Warning,
        code: 0,
      });
    }
    return parsed.tags;
  }

  maybeAddTemplateClause(docTags: jsdoc.Tag[], decl: HasTypeParameters) {
    if (!decl.typeParameters) return;
    // Closure does not support template constraints (T extends X).
    docTags.push({
      tagName: 'template',
      text: decl.typeParameters
                .map(tp => {
                  if (tp.constraint) {
                    this.emit('\n// unsupported: template constraints.');
                  }
                  return getIdentifierText(tp.name);
                })
                .join(', ')
    });
  }

  maybeAddHeritageClauses(
      docTags: jsdoc.Tag[], decl: ts.ClassLikeDeclaration|ts.InterfaceDeclaration) {
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

        const typeChecker = this.typeChecker;
        const sym = this.typeChecker.getSymbolAtLocation(impl.expression);
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
          this.debugWarn(decl, `could not resolve supertype: ${impl.getText()}`);
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
          const type = this.typeChecker.getDeclaredTypeOfSymbol(sym);
          if (!type.symbol) {
            // It's not clear when this can happen, but if it does all we
            // do is fail to emit the @implements, which isn't so harmful.
            continue;
          }
          alias = type.symbol;
        }
        if (alias.flags & ts.SymbolFlags.Alias) {
          alias = typeChecker.getAliasedSymbol(alias);
        }
        const typeTranslator = this.newTypeTranslator(impl.expression);
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
          this.debugWarn(impl, `type/symbol conflict for ${alias.name}, using {?} for now`);
          continue;
        }
        // typeToClosure includes nullability modifiers, so call symbolToString directly here.
        docTags.push({tagName, type: typeTranslator.symbolToString(alias, true)});
      }
    }
  }

  /**
   * Emits a type annotation in JSDoc, or {?} if the type is unavailable.
   * @param skipBlacklisted if true, do not emit a type at all for blacklisted types.
   */
  emitJSDocType(node: ts.Node, additionalDocTag?: string, type?: ts.Type, skipBlacklisted = false) {
    if (skipBlacklisted) {
      // Check if the type is blacklisted, and do not emit any @type at all if so.
      type = type || this.typeChecker.getTypeAtLocation(node);
      let sym = type.symbol;
      if (sym) {
        if (sym.flags & ts.SymbolFlags.Alias) {
          sym = this.typeChecker.getAliasedSymbol(sym);
        }
        const typeTranslator = this.newTypeTranslator(node);
        if (typeTranslator.isBlackListed(sym)) {
          if (additionalDocTag) this.emit(` /** ${additionalDocTag} */`);
          return;
        }
      }
    }
    this.emit(' /**');
    if (additionalDocTag) {
      this.emit(' ' + additionalDocTag);
    }
    this.emit(` @type {${this.typeToClosure(node, type)}} */`);
  }

  /**
   * Convert a TypeScript ts.Type into the equivalent Closure type.
   *
   * @param context The ts.Node containing the type reference; used for resolving symbols
   *     in context.
   * @param type The type to translate; if not provided, the Node's type will be used.
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
      file: this.file,
      start: node.getStart(),
      length: node.getEnd() - node.getStart(),
      messageText,
      category: ts.DiagnosticCategory.Warning,
      code: 0,
    };
    this.host.logWarning(diagnostic);
  }
}

type HasTypeParameters =
    ts.InterfaceDeclaration|ts.ClassLikeDeclaration|ts.TypeAliasDeclaration|ts.SignatureDeclaration;

/** Annotator translates a .ts to a .ts with Closure annotations. */
class Annotator extends ClosureRewriter {
  /** Exported symbol names that have been generated by expanding an "export * from ...". */
  private generatedExports = new Set<string>();
  /** Collection of Identifiers used in an `import {foo}` declaration with their Symbol */
  private importedNames: Array<{name: ts.Identifier, declarationNames: ts.Identifier[]}> = [];

  private templateSpanStackCount = 0;
  private polymerBehaviorStackCount = 0;

  /**
   * The set of module symbols forward declared in the local namespace (with goog.forwarDeclare).
   *
   * Symbols not imported must be declared, which is done by adding forward declares to
   * `extraImports` below.
   */
  private forwardDeclaredModules = new Set<ts.Symbol>();
  private extraDeclares = '';

  constructor(
      typeChecker: ts.TypeChecker, file: ts.SourceFile, host: AnnotatorHost,
      private tsHost: ts.ModuleResolutionHost, private tsOpts: ts.CompilerOptions,
      sourceMapper?: SourceMapper) {
    super(typeChecker, file, host, sourceMapper);
  }

  annotate(): {output: string, diagnostics: ts.Diagnostic[]} {
    this.visit(this.file);
    return this.getOutput(this.extraDeclares);
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
    const text =
        this.getForwardDeclareText(sf.fileName, moduleSymbol, /* isExplicitlyImported */ false);
    this.extraDeclares += text;
  }

  getExportDeclarationNames(node: ts.Node): ts.Identifier[] {
    switch (node.kind) {
      case ts.SyntaxKind.VariableStatement:
        const varDecl = node as ts.VariableStatement;
        return varDecl.declarationList.declarations.map(
            (d) => this.getExportDeclarationNames(d)[0]);
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
    this.error(
        node, `unsupported export declaration ${ts.SyntaxKind[node.kind]}: ${node.getText()}`);
    return [];
  }

  /**
   * Emits an ES6 export for the ambient declaration behind node, if it is indeed exported.
   */
  maybeEmitAmbientDeclarationExport(node: ts.Node) {
    // In TypeScript, `export declare` simply generates no code in the exporting module, but does
    // generate a regular import in the importing module.
    // For Closure Compiler, such declarations must still be exported, so that importing code in
    // other modules can reference them. Because tsickle generates global symbols for such types,
    // the appropriate semantics are referencing the global name.
    if (this.host.untyped || !hasModifierFlag(node, ts.ModifierFlags.Export)) {
      return;
    }
    const declNames = this.getExportDeclarationNames(node);
    for (const decl of declNames) {
      const sym = this.mustGetSymbolAtLocation(decl);
      const isValue = sym.flags & ts.SymbolFlags.Value;
      const declName = getIdentifierText(decl);
      if (node.kind === ts.SyntaxKind.VariableStatement) {
        // For variables, TypeScript rewrites every reference to the variable name as an
        // "exports." access, to maintain mutable ES6 exports semantics. Indirecting through the
        // window object means we reference the correct global symbol. Closure Compiler does
        // understand that "var foo" in externs corresponds to "window.foo".
        this.emit(`\nexports.${declName} = window.${declName};\n`);
      } else if (!isValue) {
        // Do not emit re-exports for ModuleDeclarations.
        // Ambient ModuleDeclarations are always referenced as global symbols, so they don't need to
        // be exported.
        if (node.kind === ts.SyntaxKind.ModuleDeclaration) continue;
        // Non-value objects do not exist at runtime, so we cannot access the symbol (it only
        // exists in externs). Export them as a typedef, which forwards to the type in externs.
        this.emit(`\n/** @typedef {!${declName}} */\nexports.${declName};\n`);
      } else {
        this.emit(`\nexports.${declName} = ${declName};\n`);
      }
    }
  }

  /**
   * Examines a ts.Node and decides whether to do special processing of it for output.
   *
   * @return True if the ts.Node has been handled, false if we should
   *     emit it as is and visit its children.
   */
  maybeProcess(node: ts.Node): boolean {
    if (isAmbient(node)) {
      // An ambient declaration declares types for TypeScript's benefit, so we want to skip Tsickle
      // conversion of its contents.
      this.writeRange(node, node.getFullStart(), node.getEnd());
      // ... but it might need to be exported for downstream importing code.
      this.maybeEmitAmbientDeclarationExport(node);
      return true;
    }
    switch (node.kind) {
      case ts.SyntaxKind.SourceFile:
        this.handleSourceFile(node as ts.SourceFile);
        return true;
      case ts.SyntaxKind.ImportDeclaration:
        const importDecl = node as ts.ImportDeclaration;
        // No need to forward declare side effect imports.
        if (!importDecl.importClause) break;
        // Introduce a goog.forwardDeclare for the module, so that if TypeScript does not emit the
        // module because it's only used in type positions, the JSDoc comments still reference a
        // valid Closure level symbol.
        const sym = this.typeChecker.getSymbolAtLocation(importDecl.moduleSpecifier);
        // modules might not have a symbol if they are unused.
        if (!sym) break;
        // Write the export declaration here so that forward declares come after it, and
        // fileoverview comments do not get moved behind statements.
        this.writeNode(importDecl);
        this.forwardDeclare(
            importDecl.moduleSpecifier, /* default import? */ !!importDecl.importClause.name);
        this.addSourceMapping(node);
        return true;
      case ts.SyntaxKind.ExportDeclaration:
        const exportDecl = node as ts.ExportDeclaration;
        let exportedSymbols: NamedSymbol[] = [];
        let emittedExport = false;
        if (!exportDecl.exportClause && exportDecl.moduleSpecifier) {
          // It's an "export * from ..." statement.
          // Rewrite it to re-export each exported symbol directly.
          exportedSymbols = this.expandSymbolsFromExportStar(exportDecl);
          const exportSymbolsToEmit =
              exportedSymbols.filter(s => this.shouldEmitExportSymbol(s.sym));
          this.writeLeadingTrivia(exportDecl);
          // Only emit the export if any non-type symbols are exported; otherwise it is not needed,
          // as type only exports are elided by TS anyway.
          if (exportSymbolsToEmit.length) {
            emittedExport = true;
            this.emit('export');
            this.emit(` {${exportSymbolsToEmit.map(e => unescapeName(e.name)).join(',')}}`);
            this.emit(' from ');
            this.visit(exportDecl.moduleSpecifier!);
            this.emit(';');
            this.addSourceMapping(exportDecl);
          }
        } else {
          // Write the export declaration here so that forward declares come after it, and
          // fileoverview comments do not get moved behind statements.
          emittedExport = true;
          this.writeNode(exportDecl);
          if (exportDecl.exportClause) {
            exportedSymbols = this.getNamedSymbols(exportDecl.exportClause.elements);
          }
        }
        if (emittedExport && exportDecl.moduleSpecifier) {
          // Only emit the forward declare if we did emit an export - otherwise we might forward
          // declare a module that's never imported, leading to Closure level missing provides.
          this.forwardDeclare(exportDecl.moduleSpecifier);
        }
        if (exportedSymbols.length) {
          this.emitTypeDefExports(exportedSymbols);
        }
        this.addSourceMapping(node);
        return true;
      case ts.SyntaxKind.InterfaceDeclaration:
        this.emitInterface(node as ts.InterfaceDeclaration);
        // Emit the TS interface verbatim, with no tsickle processing of properties.
        this.writeRange(node, node.getFullStart(), node.getEnd());
        return true;
      case ts.SyntaxKind.ClassDeclaration:
        const classNode = node as ts.ClassDeclaration;
        this.visitClassDeclaration(classNode);
        return true;
      case ts.SyntaxKind.PublicKeyword:
      case ts.SyntaxKind.PrivateKeyword:
        // The "public"/"private" keywords are encountered in two places:
        // 1) In class fields (which don't appear in the transformed output).
        // 2) In "parameter properties", e.g.
        //      constructor(/** @export */ public foo: string).
        // In case 2 it's important to not emit that JSDoc in the generated
        // constructor, as this is illegal for Closure.  It's safe to just
        // always skip comments preceding the 'public' keyword.
        // See test_files/parameter_properties.ts.
        this.writeNode(node, /* skipComments */ true);
        return true;
      case ts.SyntaxKind.Constructor:
        const ctor = node as ts.ConstructorDeclaration;
        this.emitFunctionType([ctor]);
        // Write the "constructor(...) {" bit, but iterate through any
        // parameters if given so that we can examine them more closely.
        this.writeNodeFrom(ctor, ctor.getStart());
        return true;
      case ts.SyntaxKind.ArrowFunction:
        // It's difficult to annotate arrow functions due to a bug in
        // TypeScript (see tsickle issue 57).  For now, just pass them
        // through unannotated.
        return false;
      case ts.SyntaxKind.FunctionDeclaration:
      case ts.SyntaxKind.MethodDeclaration:
      case ts.SyntaxKind.GetAccessor:
      case ts.SyntaxKind.SetAccessor:
        const fnDecl = node as ts.FunctionLikeDeclaration;
        const tags = hasExportingDecorator(node, this.typeChecker) ? [{tagName: 'export'}] : [];

        if (!fnDecl.body) {
          // Two cases: abstract methods and overloaded methods/functions.
          // Abstract methods are handled in emitTypeAnnotationsHandler.
          // Overloads are union-ized into the shared type in emitFunctionType.
          return false;
        }

        this.emitFunctionType([fnDecl], tags);
        this.newTypeTranslator(fnDecl).blacklistTypeParameters(
            this.symbolsToAliasedNames, fnDecl.typeParameters);
        this.writeNodeFrom(fnDecl, fnDecl.getStart());
        return true;
      case ts.SyntaxKind.TypeAliasDeclaration:
        this.writeNode(node);
        this.visitTypeAlias(node as ts.TypeAliasDeclaration);
        return true;
      case ts.SyntaxKind.TemplateSpan:
        this.templateSpanStackCount++;
        this.writeNode(node);
        this.templateSpanStackCount--;
        return true;
      case ts.SyntaxKind.TypeAssertionExpression:
      case ts.SyntaxKind.AsExpression:
        // Both of these cases are AssertionExpressions.
        const typeAssertion = node as ts.AssertionExpression;
        if (this.polymerBehaviorStackCount > 0) {
          // Don't emit type casts for Polymer behaviors that are declared
          // by calling the Polymer function
          // as the Polymer closure plugin does not work when emitting them.
          // See b/64389806.
          // Note: This only matters in the transformer version of tsickle,
          // as the non transformer version never emitted type casts due to
          // https://github.com/Microsoft/TypeScript/issues/9873 (see below).
          return false;
        }
        // When using a type casts in template expressions,
        // closure requires another pair of parens, otherwise it will
        // complain with "Misplaced type annotation. Type annotations are not allowed here."
        if (this.templateSpanStackCount > 0) {
          this.emit('(');
        }
        this.emitJSDocType(typeAssertion);
        // When TypeScript emits JS, it removes one layer of "redundant"
        // parens, but we need them for the Closure type assertion.  Work
        // around this by using two parens.  See test_files/coerce.*.
        // This is needed in both, the transformer and non transformer version.
        // TODO: in the non transformer version, the comment is currently dropped
        //  alltegether from pure assignments due to
        //  https://github.com/Microsoft/TypeScript/issues/9873.
        this.emit('((');
        this.writeNode(node);
        this.emit('))');
        if (this.templateSpanStackCount > 0) {
          this.emit(')');
        }
        return true;
      case ts.SyntaxKind.NonNullExpression:
        const nnexpr = node as ts.NonNullExpression;
        let type = this.typeChecker.getTypeAtLocation(nnexpr.expression);
        if (type.flags & ts.TypeFlags.Union) {
          const nonNullUnion =
              (type as ts.UnionType)
                  .types.filter(
                      t => (t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) === 0);
          const typeCopy = Object.assign({}, type as ts.UnionType);
          typeCopy.types = nonNullUnion;
          type = typeCopy;
        }
        // See comment above.
        if (this.templateSpanStackCount > 0) {
          this.emit('(');
        }
        this.emitJSDocType(nnexpr, undefined, type);
        // See comment above.
        this.emit('((');
        this.writeNode(nnexpr.expression);
        this.emit('))');
        if (this.templateSpanStackCount > 0) {
          this.emit(')');
        }
        return true;
      case ts.SyntaxKind.PropertyDeclaration:
      case ts.SyntaxKind.VariableStatement:
        const docTags = this.getJSDoc(node) || [];
        if (hasExportingDecorator(node, this.typeChecker)) {
          docTags.push({tagName: 'export'});
        }

        if (docTags.length > 0 && node.getFirstToken()) {
          const isPolymerBehavior = docTags.some(t => t.tagName === 'polymerBehavior');
          if (isPolymerBehavior) {
            this.polymerBehaviorStackCount++;
          }
          if (ts.isVariableStatement(node)) {
            this.visitVariableStatement(node, docTags);
          } else {
            // Property declaration.
            this.emit('\n');
            this.emit(jsdoc.toString(docTags));
            this.writeNodeFrom(node, node.getStart());
          }
          if (isPolymerBehavior) {
            this.polymerBehaviorStackCount--;
          }
          return true;
        } else if (ts.isVariableStatement(node)) {
          this.visitVariableStatement(node, docTags);
          return true;
        }
        // Property declaration without doc tags.
        break;
      case ts.SyntaxKind.PropertyAssignment:
        const pa = node as ts.PropertyAssignment;
        if (isPolymerBehaviorPropertyInCallExpression(pa)) {
          this.polymerBehaviorStackCount++;
          this.writeNodeFrom(node, node.getStart());
          this.polymerBehaviorStackCount--;
          return true;
        }
        return false;
      case ts.SyntaxKind.ElementAccessExpression:
        // Warn for quoted accesses to properties that have a symbol declared.
        // Mixing quoted and non-quoted access to a symbol (x['foo'] and x.foo) risks breaking
        // Closure Compiler renaming. Quoted access is more cumbersome to write than dotted access
        // though, so chances are users did intend to avoid renaming. The better fix is to use
        // `declare interface` though.
        const eae = node as ts.ElementAccessExpression;
        if (!eae.argumentExpression ||
            eae.argumentExpression.kind !== ts.SyntaxKind.StringLiteral) {
          return false;
        }
        const quotedPropSym = this.typeChecker.getSymbolAtLocation(eae.argumentExpression);
        // If it has a symbol, it's actually a regular declared property.
        if (!quotedPropSym) return false;
        const declarationHasQuotes =
            !quotedPropSym.declarations || quotedPropSym.declarations.some(d => {
              const decl = d as ts.NamedDeclaration;
              if (!decl.name) return false;
              return decl.name.kind === ts.SyntaxKind.StringLiteral;
            });
        // If the property is declared with quotes, it should also be accessed with them.
        if (declarationHasQuotes) return false;
        const propName = (eae.argumentExpression as ts.StringLiteral).text;
        // Properties containing non-JS identifier names can only be accessed with quotes.
        if (!isValidClosurePropertyName(propName)) return false;
        const symName = this.typeChecker.symbolToString(quotedPropSym);
        this.debugWarn(
            eae,
            `Declared property ${symName} accessed with quotes. ` +
                `This can lead to renaming bugs. A better fix is to use 'declare interface' ` +
                `on the declaration.`);
        // Previously, the code below changed the quoted into a non-quoted access.
        // this.writeNode(eae.expression);
        // this.emit(`.${propName}`);
        return false;
      case ts.SyntaxKind.PropertyAccessExpression:
        if (this.host.disableAutoQuoting) {
          return false;
        }
        // Convert dotted accesses to types that have an index type declared to quoted accesses, to
        // avoid Closure renaming one access but not the other.
        // This can happen because TS allows dotted access to string index types.
        const pae = node as ts.PropertyAccessExpression;
        const t = this.typeChecker.getTypeAtLocation(pae.expression);
        if (!t.getStringIndexType()) return false;
        // Types can have string index signatures and declared properties (of the matching type).
        // These properties have a symbol, as opposed to pure string index types.
        const propSym = this.typeChecker.getSymbolAtLocation(pae.name);
        // The decision to return below is a judgement call. Presumably, in most situations, dotted
        // access to a property is correct, and should not be turned into quoted access even if
        // there is a string index on the type. However it is possible to construct programs where
        // this is incorrect, e.g. where user code assigns into a property through the index access
        // in another location.
        if (propSym) return false;

        this.debugWarn(
            pae,
            this.typeChecker.typeToString(t) +
                ` has a string index type but is accessed using dotted access. ` +
                `Quoting the access.`);
        this.writeNode(pae.expression);
        this.emit('["');
        this.writeNode(pae.name);
        this.emit('"]');
        return true;
      default:
        break;
    }
    return false;
  }

  private shouldEmitExportSymbol(sym: ts.Symbol): boolean {
    if (sym.flags & ts.SymbolFlags.Alias) {
      sym = this.typeChecker.getAliasedSymbol(sym);
    }
    if ((sym.flags & ts.SymbolFlags.Value) === 0) {
      // Note: We create explicit reexports via closure at another place in
      return false;
    }
    if (!this.tsOpts.preserveConstEnums && sym.flags & ts.SymbolFlags.ConstEnum) {
      return false;
    }
    return true;
  }

  private handleSourceFile(sf: ts.SourceFile) {
    // Emit leading detached comments: comments separated by a \n\n from the document.
    // While handlers below generally emit comments preceding them, not all of them do in all
    // situations (e.g. JSDoc preceding a class).
    // This is symmetric with `getJSDoc` below not returning detached file level comments.
    const comments = ts.getLeadingCommentRanges(sf.text, 0) || [];
    let start = sf.getFullStart();
    for (let i = comments.length - 1; i >= 0; i--) {
      if (sf.text.substring(comments[i].end, comments[i].end + 2) === '\n\n') {
        this.emit(sf.text.substring(0, comments[i].end + 2));
        start = comments[i].end + 2;
        break;
      }
    }
    this.writeNodeFrom(sf, start);
  }

  /**
   * Given a "export * from ..." statement, gathers the symbol names it actually
   * exports to be used in a statement like "export {foo, bar, baz} from ...".
   *
   * This is necessary because TS transpiles "export *" by just doing a runtime loop
   * over the target module's exports, which means Closure won't see the declarations/types
   * that are exported.
   */
  private expandSymbolsFromExportStar(exportDecl: ts.ExportDeclaration): NamedSymbol[] {
    // You can't have an "export *" without a module specifier.
    const moduleSpecifier = exportDecl.moduleSpecifier!;

    // Gather the names of local exports, to avoid reexporting any
    // names that are already locally exported.
    const moduleSymbol = this.typeChecker.getSymbolAtLocation(this.file);
    const moduleExports = moduleSymbol && moduleSymbol.exports || new Map<string, ts.Symbol>();

    // Expand the export list, then filter it to the symbols we want to reexport.
    const exports =
        this.typeChecker.getExportsOfModule(this.mustGetSymbolAtLocation(moduleSpecifier));
    const reexports = new Set<ts.Symbol>();
    for (const sym of exports) {
      const name = unescapeName(sym.name);
      if (moduleExports instanceof Map) {
        if (moduleExports.has(name)) {
          // This name is shadowed by a local definition, such as:
          // - export var foo ...
          // - export {foo} from ...
          // - export {bar as foo} from ...
          continue;
        }
      } else {
        // TODO(#634): check if this is a safe cast.
        if (moduleExports.has(name as ts.__String)) continue;
      }
      if (this.generatedExports.has(name)) {
        // Already exported via an earlier expansion of an "export * from ...".
        continue;
      }
      this.generatedExports.add(name);
      reexports.add(sym);
    }
    return Array.from(reexports.keys()).map(sym => {
      return {name: sym.name, sym};
    });
  }

  /**
   * Write an `exports.` assignment for each type alias exported in the given `exports`.
   * TypeScript by itself does not export non-value symbols (e.g. interfaces, typedefs), as it
   * expects to remove those entirely for runtime. For Closure, types must be
   * exported as downstream code will import the type.
   *
   * The tsickle pass turns interfaces into values by generating a `function MyInterface() {}` for
   * them, so in the second conversion pass, TypeScript does export a value for them. However for
   * pure typedefs, tsickle only generates a property access with a JSDoc comment, so they need to
   * be exported explicitly here.
   */
  private emitTypeDefExports(exports: NamedSymbol[]) {
    if (this.host.untyped) return;
    for (const exp of exports) {
      if (exp.sym.flags & ts.SymbolFlags.Alias) {
        exp.sym = this.typeChecker.getAliasedSymbol(exp.sym);
      }
      const isTypeAlias = ((exp.sym.flags & ts.SymbolFlags.TypeAlias) !== 0 &&
                           (exp.sym.flags & ts.SymbolFlags.Value) === 0) ||
          (exp.sym.flags & ts.SymbolFlags.Interface) !== 0 &&
              (exp.sym.flags & ts.SymbolFlags.Value) === 0;
      if (!isTypeAlias) continue;
      const typeName = this.symbolsToAliasedNames.get(exp.sym) || exp.sym.name;
      // Leading newline prevents the typedef from being swallowed.
      this.emit(`\n/** @typedef {!${typeName}} */\nexports.${exp.name}; // re-export typedef\n`);
    }
  }

  private getNamedSymbols(specifiers: ReadonlyArray<ts.ImportSpecifier|ts.ExportSpecifier>):
      NamedSymbol[] {
    return specifiers.map(e => {
      return {
        // e.name might be renaming symbol as in `export {Foo as Bar}`, where e.name would be 'Bar'
        // and != sym.name. Store away the name so forwardDeclare below can emit the right name.
        name: getIdentifierText(e.name),
        sym: this.mustGetSymbolAtLocation(e.name),
      };
    });
  }

  private forwardDeclareCounter = 0;

  /**
   * Emits a `goog.forwardDeclare` alias for each symbol from the given list.
   * @param specifier the import specifier, i.e. module path ("from '...'").
   */
  private forwardDeclare(specifier: ts.Expression, isDefaultImport = false) {
    const importPath = googmodule.resolveIndexShorthand(
        {options: this.tsOpts, host: this.tsHost}, this.file.fileName,
        (specifier as ts.StringLiteral).text);
    const moduleSymbol = this.typeChecker.getSymbolAtLocation(specifier);
    this.emit(this.getForwardDeclareText(
        importPath, moduleSymbol, /* isExplicitlyImported */ true, isDefaultImport));
  }

  /**
   * Returns the `const x = goog.forwardDeclare...` text for an import of the given `importPath`.
   * This also registers aliases for symbols from the module that map to this forward declare.
   * @param isExplicitlyImported whether the given importPath is for a module that was explicitly
   *     imported into the current context. tsickly only emits force loads for explicitly imported
   *     modules, so that it doesn't break strict deps checking for the JS code.
   */
  private getForwardDeclareText(
      importPath: string, moduleSymbol: ts.Symbol|undefined, isExplicitlyImported: boolean,
      isDefaultImport = false): string {
    if (this.host.untyped) return '';
    const nsImport = googmodule.extractGoogNamespaceImport(importPath);
    const forwardDeclarePrefix = `tsickle_forward_declare_${++this.forwardDeclareCounter}`;
    const moduleNamespace =
        nsImport !== null ? nsImport : this.host.pathToModuleName(this.file.fileName, importPath);
    // In TypeScript, importing a module for use in a type annotation does not cause a runtime load.
    // In Closure Compiler, goog.require'ing a module causes a runtime load, so emitting requires
    // here would cause a change in load order, which is observable (and can lead to errors).
    // Instead, goog.forwardDeclare types, which allows using them in type annotations without
    // causing a load. See below for the exception to the rule.
    let emitText = `const ${forwardDeclarePrefix} = goog.forwardDeclare("${moduleNamespace}");\n`;

    // Scripts do not have a symbol. Scripts can still be imported, either as side effect imports or
    // with an empty import set ("{}"). TypeScript does not emit a runtime load for an import with
    // an empty list of symbols, but the import forces any global declarations from the library to
    // be visible, which is what users use this for. No symbols from the script need forward
    // declaration, so just return.
    if (!moduleSymbol) return '';
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
    if (!hasValues && isExplicitlyImported) {
      // Closure Compiler's toolchain will drop files that are never goog.require'd *before* type
      // checking (e.g. when using --closure_entry_point or similar tools). This causes errors
      // complaining about values not matching 'NoResolvedType', or modules not having a certain
      // member.
      // To fix, emit hard goog.require() for explicitly imported modules that only export types.
      // This should usually not cause breakages due to load order (as no symbols are accessible
      // from the module - though contrived code could observe changes in side effects).
      // This is a heuristic - if the module exports some values, but those are never imported,
      // the file will still end up not being imported. Hopefully modules that export values are
      // imported for their value in some place.
      emitText += `goog.require("${moduleNamespace}"); // force type-only module to be loaded\n`;
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
    return emitText;
  }

  /** Emits a variable statement per declaration in this variable statement, duplicating JSDoc. */
  private visitVariableStatement(varStmt: ts.VariableStatement, docTags: jsdoc.Tag[]) {
    // Previously tsickle would emit inline types (`var /** @type {string} */ x;`), but TypeScript's
    // emit strips those comments for exports. Instead, break up the variable declaration list into
    // separate variable statements, each with a leading (not inline) comment.
    const keyword = varStmt.declarationList.getFirstToken().getText();
    const additionalTags = jsdoc.toStringWithoutStartEnd(docTags, jsdoc.TAGS_CONFLICTING_WITH_TYPE);
    for (const decl of varStmt.declarationList.declarations) {
      this.emit('\n');
      this.addSourceMapping(decl);
      // Only emit a type for plain identifiers. Binding patterns have no type syntax in Closure
      // Compiler, and TypeScript 2.6 crashes on "getTypeAtLocation(bindingpattern)". By omitting a
      // type altogether, there is a chance Closure Compiler infers the correct type.
      if (ts.isIdentifier(decl.name)) {
        // Don't emit type annotation when the variable statement is a @polymerBehavior, as
        // otherwise the polymer closure checker will fail. See b/64389806.
        if (this.polymerBehaviorStackCount === 0) {
          // Skip emitting a JSDoc type for blacklisted types if and only if this variable is
          // initialized (and thus probably type inferred).
          const hasInitializer = !!decl.initializer;
          this.emitJSDocType(
              decl, additionalTags, /*type=*/undefined, /*skipBlacklisted=*/hasInitializer);
        } else {
          this.emit(`/**${additionalTags}*/`);
        }
      }
      this.emit('\n');
      const finishMapping = this.startSourceMapping(varStmt);
      if (hasModifierFlag(varStmt, ts.ModifierFlags.Export)) this.emit('export ');
      this.addSourceMapping(decl);
      this.emit(keyword);
      this.visit(decl.name);
      if (decl.initializer) {
        this.emit(' = ');
        this.visit(decl.initializer);
      }
      this.emit(';');
      finishMapping();
    }
  }

  private visitClassDeclaration(classDecl: ts.ClassDeclaration) {
    this.addSourceMapping(classDecl);
    const docTags = this.getJSDoc(classDecl) || [];
    if (hasModifierFlag(classDecl, ts.ModifierFlags.Abstract)) {
      docTags.push({tagName: 'abstract'});
    }

    this.maybeAddTemplateClause(docTags, classDecl);
    if (!this.host.untyped) {
      this.maybeAddHeritageClauses(docTags, classDecl);
    }

    this.emit('\n');
    if (docTags.length > 0) this.emit(jsdoc.toString(docTags));
    // this.writeNode(classDecl, true /*skipComments*/);
    this.writeNodeFrom(classDecl, classDecl.getStart(), classDecl.getEnd());
    this.emitMemberTypes(classDecl);
    return true;
  }

  private emitInterface(iface: ts.InterfaceDeclaration) {
    // If this symbol is both a type and a value, we cannot emit both into Closure's
    // single namespace.
    const sym = this.mustGetSymbolAtLocation(iface.name);
    if (sym.flags & ts.SymbolFlags.Value) return;

    const docTags = this.getJSDoc(iface) || [];
    docTags.push({tagName: 'record'});
    this.maybeAddTemplateClause(docTags, iface);
    if (!this.host.untyped) {
      this.maybeAddHeritageClauses(docTags, iface);
    }

    this.emit('\n');
    this.emit(jsdoc.toString(docTags));

    if (hasModifierFlag(iface, ts.ModifierFlags.Export)) this.emit('export ');
    const name = getIdentifierText(iface.name);
    this.emit(`function ${name}() {}\n`);

    if (iface.members.length > 0) {
      this.emit(`\nif (false) {\n`);
      const memberNamespace = [name, 'prototype'];
      for (const elem of iface.members) {
        const isOptional = elem.questionToken != null;
        this.visitProperty(memberNamespace, elem, isOptional);
      }
      this.emit(`}\n`);
    }
  }

  /**
   * emitMemberTypes emits the type annotations for members of a class.
   * It's necessary in the case where TypeScript syntax specifies
   * there are additional properties on the class, because to declare
   * these in Closure you must declare these separately from the class.
   */
  private emitMemberTypes(classDecl: ts.ClassDeclaration) {
    // Gather parameter properties from the constructor, if it exists.
    const ctors: ts.ConstructorDeclaration[] = [];
    let paramProps: ts.ParameterDeclaration[] = [];
    const nonStaticProps: ts.PropertyDeclaration[] = [];
    const staticProps: ts.PropertyDeclaration[] = [];
    const abstractMethods: ts.FunctionLikeDeclaration[] = [];
    for (const member of classDecl.members) {
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
          hasModifierFlag(member, ts.ModifierFlags.Abstract) &&
          (member.kind === ts.SyntaxKind.MethodDeclaration ||
           member.kind === ts.SyntaxKind.GetAccessor ||
           member.kind === ts.SyntaxKind.SetAccessor)) {
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
      return;
    }

    if (!classDecl.name) return;
    const className = getIdentifierText(classDecl.name);

    // See test_files/fields/fields.ts:BaseThatThrows for a note on this wrapper.
    this.emit(`\n\nif (false) {`);
    staticProps.forEach(p => this.visitProperty([className], p));
    const memberNamespace = [className, 'prototype'];
    nonStaticProps.forEach((p) => this.visitProperty(memberNamespace, p));
    paramProps.forEach((p) => this.visitProperty(memberNamespace, p));

    for (const fnDecl of abstractMethods) {
      const name = this.propertyName(fnDecl);
      if (!name) {
        this.error(fnDecl, 'anonymous abstract function');
        continue;
      }
      const tags = hasExportingDecorator(fnDecl, this.typeChecker) ? [{tagName: 'export'}] : [];
      const paramNames = this.emitFunctionType([fnDecl], tags);
      // memberNamespace because abstract methods cannot be static in TypeScript.
      this.emit(`${memberNamespace.join('.')}.${name} = function(${paramNames.join(', ')}) {};\n`);
    }

    this.emit(`}\n`);
  }

  private propertyName(prop: ts.NamedDeclaration): string|null {
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

  /**
   * @param optional If true, property is optional (e.g. written "foo?: string").
   */
  private visitProperty(namespace: string[], prop: ts.Declaration, optional = false) {
    const name = this.propertyName(prop);
    if (!name) {
      this.emit(`/* TODO: handle strange member:\n${this.escapeForComment(prop.getText())}\n*/\n`);
      return;
    }

    let type = this.typeToClosure(prop);
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

    const tags = this.getJSDoc(prop) || [];
    tags.push({tagName: 'type', type});
    if (hasExportingDecorator(prop, this.typeChecker)) {
      tags.push({tagName: 'export'});
    }
    // Avoid printing annotations that can conflict with @type
    // This avoids Closure's error "type annotation incompatible with other annotations"
    this.emit(jsdoc.toString(tags, jsdoc.TAGS_CONFLICTING_WITH_TYPE));
    namespace = namespace.concat([name]);
    this.emit(`${namespace.join('.')};\n`);
  }

  private visitTypeAlias(node: ts.TypeAliasDeclaration) {
    // If the type is also defined as a value, skip emitting it. Closure collapses type & value
    // namespaces, the two emits would conflict if tsickle emitted both.
    const sym = this.mustGetSymbolAtLocation(node.name);
    if (sym.flags & ts.SymbolFlags.Value) return;
    // Type aliases are always emitted as the resolved underlying type, so there is no need to emit
    // anything, except for exported types.
    if (!hasModifierFlag(node, ts.ModifierFlags.Export)) return;
    // A pure ES6 export (`export {Foo}`) is insufficient, as TS does not emit those for pure types,
    // so tsickle has to pick a module format. We're using CommonJS to emit googmodule, and code not
    // using googmodule doesn't care about the Closure annotations anyway, so just skip emitting if
    // the module target isn't commonjs.
    if (this.tsOpts.module !== ts.ModuleKind.CommonJS) return;

    const typeName = node.name.getText();

    // Blacklist any type parameters, Closure does not support type aliases with type parameters.
    this.newTypeTranslator(node).blacklistTypeParameters(
        this.symbolsToAliasedNames, node.typeParameters);
    const typeStr = this.host.untyped ? '?' : this.typeToClosure(node, undefined);
    // In the case of an export, we cannot emit a `export var foo;` because TypeScript drops exports
    // that are never assigned values, and Closure requires us to not assign values to typedef
    // exports.
    // Introducing a new local variable and exporting it can cause bugs due to name shadowing and
    // confusing TypeScript's logic on what symbols and types vs values are exported.
    // Mangling the name to avoid the conflicts would be reasonably clean, but would require a two
    // pass emit to first find all type alias names, mangle them, and emit the use sites only later.
    // With that, the fix here is to never emit type aliases, but always resolve the alias and emit
    // the underlying type (fixing references in the local module, and also across modules).
    // For downstream JavaScript code that imports the typedef, we emit an "export.Foo;" that
    // declares and exports the type, and for TypeScript has no impact.
    this.emit(`\n/** @typedef {${typeStr}} */\nexports.${typeName};`);
  }
}

/** ExternsWriter generates Closure externs from TypeScript source. */
class ExternsWriter extends ClosureRewriter {
  process(): {output: string, diagnostics: ts.Diagnostic[]} {
    this.findExternRoots().forEach(node => this.visit(node));
    return this.getOutput();
  }

  protected ensureSymbolDeclared(sym: ts.Symbol): void {
    const decl = this.findExportedDeclaration(sym);
    if (!decl) return;  // symbol does not need declaring.
    this.error(
        this.file,
        `Cannot reference a non-global symbol from an externs: ${sym.name} declared at ${
            formatLocation(decl.getSourceFile(), decl.getStart())}`);
  }

  newTypeTranslator(context: ts.Node) {
    const tt = super.newTypeTranslator(context);
    tt.isForExterns = true;
    return tt;
  }

  private findExternRoots(): ts.Node[] {
    if (isDtsFileName(this.file.fileName)) {
      return [this.file];
    }
    return this.file.statements.filter(stmt => hasModifierFlag(stmt, ts.ModifierFlags.Ambient));
  }

  /** visit is the main entry point.  It generates externs from a ts.Node. */
  visit(node: ts.Node, namespace: string[] = []) {
    switch (node.kind) {
      case ts.SyntaxKind.SourceFile:
        const sourceFile = node as ts.SourceFile;
        for (const stmt of sourceFile.statements) {
          this.visit(stmt, namespace);
        }
        break;
      case ts.SyntaxKind.ModuleDeclaration:
        const decl = node as ts.ModuleDeclaration;
        switch (decl.name.kind) {
          case ts.SyntaxKind.Identifier:
            // E.g. "declare namespace foo {"
            const name = getIdentifierText(decl.name as ts.Identifier);
            if (name === 'global') {
              // E.g. "declare global { ... }".  Reset to the outer namespace.
              namespace = [];
            } else {
              if (this.isFirstDeclaration(decl)) {
                this.emit('/** @const */\n');
                this.writeExternsVariable(name, namespace, '{}');
              }
              namespace = namespace.concat(name);
            }
            if (decl.body) this.visit(decl.body, namespace);
            break;
          case ts.SyntaxKind.StringLiteral:
            // E.g. "declare module 'foo' {" (note the quotes).
            // We still want to emit externs for this module, but
            // Closure doesn't really provide a mechanism for
            // module-scoped externs.  For now, ignore the enclosing
            // namespace (because this is declaring a top-level module)
            // and emit into a fake namespace.

            // Declare the top-level "tsickle_declare_module".
            this.emit('/** @const */\n');
            this.writeExternsVariable('tsickle_declare_module', [], '{}');
            namespace = ['tsickle_declare_module'];

            // Declare the inner "tsickle_declare_module.foo", if it's not
            // declared already elsewhere.
            let importName = (decl.name as ts.StringLiteral).text;
            this.emit(`// Derived from: declare module "${importName}"\n`);
            // We also don't care about the actual name of the module ("foo"
            // in the above example), except that we want it to not conflict.
            importName = importName.replace(/_/, '__').replace(/[^A-Za-z]/g, '_');
            if (this.isFirstDeclaration(decl)) {
              this.emit('/** @const */\n');
              this.writeExternsVariable(importName, namespace, '{}');
            }

            // Declare the contents inside the "tsickle_declare_module.foo".
            if (decl.body) this.visit(decl.body, namespace.concat(importName));
            break;
          default:
            this.errorUnimplementedKind(decl.name, 'externs generation of namespace');
        }
        break;
      case ts.SyntaxKind.ModuleBlock:
        const block = node as ts.ModuleBlock;
        for (const stmt of block.statements) {
          this.visit(stmt, namespace);
        }
        break;
      case ts.SyntaxKind.ImportEqualsDeclaration:
        const importEquals = node as ts.ImportEqualsDeclaration;
        const localName = getIdentifierText(importEquals.name);
        if (localName === 'ng') {
          this.emit(`\n/* Skipping problematic import ng = ...; */\n`);
          break;
        }
        if (importEquals.moduleReference.kind === ts.SyntaxKind.ExternalModuleReference) {
          this.emit(`\n/* TODO: import ${localName} = require(...) */\n`);
          break;
        }
        const qn = getEntityNameText(importEquals.moduleReference);
        // @const so that Closure Compiler understands this is an alias.
        if (namespace.length === 0) this.emit('/** @const */\n');
        this.writeExternsVariable(localName, namespace, qn);
        break;
      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.InterfaceDeclaration:
        this.writeExternsType(node as ts.InterfaceDeclaration | ts.ClassDeclaration, namespace);
        break;
      case ts.SyntaxKind.FunctionDeclaration:
        const fnDecl = node as ts.FunctionDeclaration;
        const name = fnDecl.name;
        if (!name) {
          this.error(fnDecl, 'anonymous function in externs');
          break;
        }
        // Gather up all overloads of this function.
        const sym = this.mustGetSymbolAtLocation(name);
        const decls = sym.declarations!.filter(d => d.kind === ts.SyntaxKind.FunctionDeclaration) as
            ts.FunctionDeclaration[];
        // Only emit the first declaration of each overloaded function.
        if (fnDecl !== decls[0]) break;
        const params = this.emitFunctionType(decls);
        this.writeExternsFunction(name, params, namespace);
        break;
      case ts.SyntaxKind.VariableStatement:
        for (const decl of (node as ts.VariableStatement).declarationList.declarations) {
          this.writeExternsVariableDecl(decl, namespace);
        }
        break;
      case ts.SyntaxKind.EnumDeclaration:
        this.writeExternsEnum(node as ts.EnumDeclaration, namespace);
        break;
      case ts.SyntaxKind.TypeAliasDeclaration:
        this.writeExternsTypeAlias(node as ts.TypeAliasDeclaration, namespace);
        break;
      default:
        const locationStr = namespace.join('.') || path.basename(node.getSourceFile().fileName);
        this.emit(`\n// TODO(tsickle): ${ts.SyntaxKind[node.kind]} in ${locationStr}\n`);
        break;
    }
  }

  /**
   * isFirstDeclaration returns true if decl is the first declaration
   * of its symbol.  E.g. imagine
   *   interface Foo { x: number; }
   *   interface Foo { y: number; }
   * we only want to emit the "@record" for Foo on the first one.
   */
  private isFirstDeclaration(decl: ts.DeclarationStatement): boolean {
    if (!decl.name) return true;
    const sym = this.mustGetSymbolAtLocation(decl.name);
    if (!sym.declarations || sym.declarations.length < 2) return true;
    return decl === sym.declarations[0];
  }

  private writeExternsType(decl: ts.InterfaceDeclaration|ts.ClassDeclaration, namespace: string[]) {
    const name = decl.name;
    if (!name) {
      this.error(decl, 'anonymous type in externs');
      return;
    }
    const typeName = namespace.concat([name.getText()]).join('.');
    if (closureExternsBlacklist.indexOf(typeName) >= 0) return;

    if (this.isFirstDeclaration(decl)) {
      let paramNames: string[] = [];
      const jsdocTags: jsdoc.Tag[] = [];
      let writeJsDoc = true;
      this.maybeAddHeritageClauses(jsdocTags, decl);
      if (decl.kind === ts.SyntaxKind.ClassDeclaration) {
        jsdocTags.push({tagName: 'constructor'});
        jsdocTags.push({tagName: 'struct'});
        const ctors = (decl as ts.ClassDeclaration)
                          .members.filter((m) => m.kind === ts.SyntaxKind.Constructor);
        if (ctors.length) {
          writeJsDoc = false;
          const firstCtor: ts.ConstructorDeclaration = ctors[0] as ts.ConstructorDeclaration;
          const ctorTags = [{tagName: 'constructor'}, {tagName: 'struct'}];
          if (ctors.length > 1) {
            paramNames = this.emitFunctionType(ctors as ts.ConstructorDeclaration[], ctorTags);
          } else {
            paramNames = this.emitFunctionType([firstCtor], ctorTags);
          }
        }
      } else {
        jsdocTags.push({tagName: 'record'});
        jsdocTags.push({tagName: 'struct'});
      }
      if (writeJsDoc) this.emit(jsdoc.toString(jsdocTags));
      this.writeExternsFunction(name, paramNames, namespace);
    }

    // Process everything except (MethodSignature|MethodDeclaration|Constructor)
    const methods = new Map<string, ts.MethodDeclaration[]>();
    for (const member of decl.members) {
      switch (member.kind) {
        case ts.SyntaxKind.PropertySignature:
        case ts.SyntaxKind.PropertyDeclaration:
          const prop = member as ts.PropertySignature;
          if (prop.name.kind === ts.SyntaxKind.Identifier) {
            this.emitJSDocType(prop);
            if (hasModifierFlag(prop, ts.ModifierFlags.Static)) {
              this.emit(`\n${typeName}.${prop.name.getText()};\n`);
            } else {
              this.emit(`\n${typeName}.prototype.${prop.name.getText()};\n`);
            }
            continue;
          }
          // TODO: For now property names other than Identifiers are not handled; e.g.
          //    interface Foo { "123bar": number }
          break;
        case ts.SyntaxKind.MethodSignature:
        case ts.SyntaxKind.MethodDeclaration:
          const method = member as ts.MethodDeclaration;
          const isStatic = hasModifierFlag(method, ts.ModifierFlags.Static);
          const methodSignature = `${method.name.getText()}$$$${isStatic ? 'static' : 'instance'}`;

          if (methods.has(methodSignature)) {
            methods.get(methodSignature)!.push(method);
          } else {
            methods.set(methodSignature, [method]);
          }
          continue;
        case ts.SyntaxKind.Constructor:
          continue;  // Handled above.
        default:
          // Members can include things like index signatures, for e.g.
          //   interface Foo { [key: string]: number; }
          // For now, just skip it.
          break;
      }
      // If we get here, the member wasn't handled in the switch statement.
      let memberName = namespace;
      if (member.name) {
        memberName = memberName.concat([member.name.getText()]);
      }
      this.emit(`\n/* TODO: ${ts.SyntaxKind[member.kind]}: ${memberName.join('.')} */\n`);
    }

    // Handle method declarations/signatures separately, since we need to deal with overloads.
    for (const methodVariants of Array.from(methods.values())) {
      const firstMethodVariant = methodVariants[0];
      let parameterNames: string[];
      if (methodVariants.length > 1) {
        parameterNames = this.emitFunctionType(methodVariants);
      } else {
        parameterNames = this.emitFunctionType([firstMethodVariant]);
      }
      const methodNamespace = namespace.concat([name.getText()]);
      // If the method is static, don't add the prototype.
      if (!hasModifierFlag(firstMethodVariant, ts.ModifierFlags.Static)) {
        methodNamespace.push('prototype');
      }
      this.writeExternsFunction(firstMethodVariant.name, parameterNames, methodNamespace);
    }
  }

  private writeExternsVariableDecl(decl: ts.VariableDeclaration, namespace: string[]) {
    if (decl.name.kind === ts.SyntaxKind.Identifier) {
      const name = getIdentifierText(decl.name as ts.Identifier);
      if (closureExternsBlacklist.indexOf(name) >= 0) return;
      this.emitJSDocType(decl);
      this.emit('\n');
      this.writeExternsVariable(name, namespace);
    } else {
      this.errorUnimplementedKind(decl.name, 'externs for variable');
    }
  }

  private writeExternsVariable(name: string, namespace: string[], value?: string) {
    const qualifiedName = namespace.concat([name]).join('.');
    if (namespace.length === 0) this.emit(`var `);
    this.emit(qualifiedName);
    if (value) this.emit(` = ${value}`);
    this.emit(';\n');
  }

  private writeExternsFunction(name: ts.Node, params: string[], namespace: string[]) {
    const paramsStr = params.join(', ');
    if (namespace.length > 0) {
      let fqn = namespace.join('.');
      if (name.kind === ts.SyntaxKind.Identifier) {
        fqn += '.';  // computed names include [ ] in their getText() representation.
      }
      fqn += name.getText();
      this.emit(`${fqn} = function(${paramsStr}) {};\n`);
    } else {
      if (name.kind !== ts.SyntaxKind.Identifier) {
        this.error(name, 'Non-namespaced computed name in externs');
      }
      this.emit(`function ${name.getText()}(${paramsStr}) {}\n`);
    }
  }

  private writeExternsEnum(decl: ts.EnumDeclaration, namespace: string[]) {
    const name = getIdentifierText(decl.name);
    this.emit('\n/** @const */\n');
    this.writeExternsVariable(name, namespace, '{}');
    namespace = namespace.concat([name]);
    for (const member of decl.members) {
      let memberName: string|undefined;
      switch (member.name.kind) {
        case ts.SyntaxKind.Identifier:
          memberName = getIdentifierText(member.name as ts.Identifier);
          break;
        case ts.SyntaxKind.StringLiteral:
          const text = (member.name as ts.StringLiteral).text;
          if (isValidClosurePropertyName(text)) memberName = text;
          break;
        default:
          break;
      }
      if (!memberName) {
        this.emit(`\n/* TODO: ${ts.SyntaxKind[member.name.kind]}: ${member.name.getText()} */\n`);
        continue;
      }
      this.emit('/** @const {number} */\n');
      this.writeExternsVariable(memberName, namespace);
    }
  }

  private writeExternsTypeAlias(decl: ts.TypeAliasDeclaration, namespace: string[]) {
    const typeStr = this.typeToClosure(decl, undefined);
    this.emit(`\n/** @typedef {${typeStr}} */\n`);
    this.writeExternsVariable(getIdentifierText(decl.name), namespace);
  }
}

function isPolymerBehaviorPropertyInCallExpression(pa: ts.PropertyAssignment): boolean {
  const parentParent = pa.parent && pa.parent.parent;
  if (pa.name.kind !== ts.SyntaxKind.Identifier ||
      (pa.name as ts.Identifier).text !== 'behaviors' || !pa.parent || !pa.parent.parent ||
      pa.parent.parent.kind !== ts.SyntaxKind.CallExpression) {
    return false;
  }

  const expr = (parentParent as ts.CallExpression).expression;
  return expr.kind === ts.SyntaxKind.Identifier && (expr as ts.Identifier).text === 'Polymer';
}

export function annotate(
    typeChecker: ts.TypeChecker, file: ts.SourceFile, host: AnnotatorHost,
    tsHost: ts.ModuleResolutionHost, tsOpts: ts.CompilerOptions,
    sourceMapper?: SourceMapper): {output: string, diagnostics: ts.Diagnostic[]} {
  return new Annotator(typeChecker, file, host, tsHost, tsOpts, sourceMapper).annotate();
}

export function writeExterns(typeChecker: ts.TypeChecker, file: ts.SourceFile, host: AnnotatorHost):
    {output: string, diagnostics: ts.Diagnostic[]} {
  return new ExternsWriter(typeChecker, file, host).process();
}

export interface TsickleHost extends googmodule.GoogModuleProcessorHost, AnnotatorHost {
  /**
   * Whether to downlevel decorators
   */
  transformDecorators?: boolean;
  /**
   * Whether to convers types to closure
   */
  transformTypesToClosure?: boolean;
  /**
   * Whether to add aliases to the .d.ts files to add the exports to the
   * ಠ_ಠ.clutz namespace.
   */
  addDtsClutzAliases?: boolean;
  /**
   * If true, tsickle and decorator downlevel processing will be skipped for
   * that file.
   */
  shouldSkipTsickleProcessing(fileName: string): boolean;
  /**
   * Tsickle treats warnings as errors, if true, ignore warnings.  This might be
   * useful for e.g. third party code.
   */
  shouldIgnoreWarningsForPath(filePath: string): boolean;
  /** Whether to convert CommonJS require() imports to goog.module() and goog.require() calls. */
  googmodule: boolean;
}

export function mergeEmitResults(emitResults: EmitResult[]): EmitResult {
  const diagnostics: ts.Diagnostic[] = [];
  let emitSkipped = true;
  const emittedFiles: string[] = [];
  const externs: {[fileName: string]: string} = {};
  const modulesManifest = new ModulesManifest();
  for (const er of emitResults) {
    diagnostics.push(...er.diagnostics);
    emitSkipped = emitSkipped || er.emitSkipped;
    emittedFiles.push(...er.emittedFiles);
    Object.assign(externs, er.externs);
    modulesManifest.addManifest(er.modulesManifest);
  }
  return {diagnostics, emitSkipped, emittedFiles, externs, modulesManifest};
}

export interface EmitResult extends ts.EmitResult {
  // The manifest of JS modules output by the compiler.
  modulesManifest: ModulesManifest;
  /**
   * externs.js files produced by tsickle, if any. module IDs are relative paths from
   * fileNameToModuleId.
   */
  externs: {[moduleId: string]: string};
}

export interface EmitTransformers {
  beforeTsickle?: Array<ts.TransformerFactory<ts.SourceFile>>;
  beforeTs?: Array<ts.TransformerFactory<ts.SourceFile>>;
  afterTs?: Array<ts.TransformerFactory<ts.SourceFile>>;
}

export function emitWithTsickle(
    program: ts.Program, host: TsickleHost, tsHost: ts.CompilerHost, tsOptions: ts.CompilerOptions,
    targetSourceFile?: ts.SourceFile, writeFile?: ts.WriteFileCallback,
    cancellationToken?: ts.CancellationToken, emitOnlyDtsFiles?: boolean,
    customTransformers: EmitTransformers = {}): EmitResult {
  let tsickleDiagnostics: ts.Diagnostic[] = [];
  const typeChecker = program.getTypeChecker();
  const tsickleSourceTransformers: Array<ts.TransformerFactory<ts.SourceFile>> = [];
  if (host.transformTypesToClosure) {
    // Note: tsickle.annotate can also lower decorators in the same run.
    tsickleSourceTransformers.push(createTransformerFromSourceMap((sourceFile, sourceMapper) => {
      const {output, diagnostics} =
          annotate(typeChecker, sourceFile, host, tsHost, tsOptions, sourceMapper);
      tsickleDiagnostics.push(...diagnostics);
      return output;
    }));
    tsickleSourceTransformers.push(enumTransformer(typeChecker, tsickleDiagnostics));
    // Only add @suppress {checkTypes} comments when also adding type annotations.
    tsickleSourceTransformers.push(transformFileoverviewComment);
    tsickleSourceTransformers.push(decoratorDownlevelTransformer(typeChecker, tsickleDiagnostics));
  } else if (host.transformDecorators) {
    tsickleSourceTransformers.push(decoratorDownlevelTransformer(typeChecker, tsickleDiagnostics));
  }
  const modulesManifest = new ModulesManifest();
  let tsickleTransformers: ts.CustomTransformers = {};
  if (tsickleSourceTransformers.length) {
    // Only add the various fixup transformers if tsickle is actually doing a source map powered
    // transformation. Without a source map transformation, some information is not
    // available/initialized correctly for these passes to work, which causes subtle emit errors
    // (such as comments appearing in incorrect locations, breaking source code due to automatic
    // semicolon insertion).
    tsickleTransformers = createCustomTransformers({before: tsickleSourceTransformers});
  }
  const tsTransformers: ts.CustomTransformers = {
    before: [
      ...(customTransformers.beforeTsickle || []),
      ...(tsickleTransformers.before || []).map(tf => skipTransformForSourceFileIfNeeded(host, tf)),
      ...(customTransformers.beforeTs || []),
    ],
    after: [
      ...(customTransformers.afterTs || []),
      ...(tsickleTransformers.after || []).map(tf => skipTransformForSourceFileIfNeeded(host, tf)),
    ]
  };
  if (host.googmodule) {
    tsTransformers.after!.push(googmodule.commonJsToGoogmoduleTransformer(
        host, modulesManifest, typeChecker, tsickleDiagnostics));
  }

  const writeFileDelegate = writeFile || tsHost.writeFile.bind(tsHost);
  const writeFileImpl =
      (fileName: string, content: string, writeByteOrderMark: boolean,
       onError?: (message: string) => void, sourceFiles?: ReadonlyArray<ts.SourceFile>) => {
        if (path.extname(fileName) !== '.map') {
          if (tsOptions.inlineSourceMap) {
            content = combineInlineSourceMaps(program, fileName, content);
          } else {
            content = removeInlineSourceMap(content);
          }
        } else {
          content = combineSourceMaps(program, fileName, content);
        }
        if (host.addDtsClutzAliases && isDtsFileName(fileName) && sourceFiles) {
          // Only bundle emits pass more than one source file for .d.ts writes. Bundle emits however
          // are not supported by tsickle, as we cannot annotate them for Closure in any meaningful
          // way anyway.
          if (!sourceFiles || sourceFiles.length > 1) {
            throw new Error(`expected exactly one source file for .d.ts emit, got ${
                sourceFiles.map(sf => sf.fileName)}`);
          }
          const originalSource = sourceFiles[0];
          content = addClutzAliases(fileName, content, originalSource, typeChecker, host);
        }
        writeFileDelegate(fileName, content, writeByteOrderMark, onError, sourceFiles);
      };

  const {diagnostics: tsDiagnostics, emitSkipped, emittedFiles} = program.emit(
      targetSourceFile, writeFileImpl, cancellationToken, emitOnlyDtsFiles, tsTransformers);

  const externs: {[fileName: string]: string} = {};
  if (host.transformTypesToClosure) {
    const sourceFiles = targetSourceFile ? [targetSourceFile] : program.getSourceFiles();
    sourceFiles.forEach(sf => {
      if (isDtsFileName(sf.fileName) && host.shouldSkipTsickleProcessing(sf.fileName)) {
        return;
      }
      // fileName might be absolute, which would cause emits different by checkout location or
      // non-deterministic output for build systems that use hashed work directories (bazel).
      // fileNameToModuleId gives the logical, base path relative ID for the given fileName, which
      // avoids this issue.
      const moduleId = host.fileNameToModuleId(sf.fileName);
      const {output, diagnostics} = writeExterns(typeChecker, sf, host);
      if (output) {
        externs[moduleId] = output;
      }
      if (diagnostics) {
        tsickleDiagnostics.push(...diagnostics);
      }
    });
  }
  // All diagnostics (including warnings) are treated as errors.
  // If the host decides to ignore warnings, just discard them.
  // Warnings include stuff like "don't use @type in your jsdoc"; tsickle
  // warns and then fixes up the code to be Closure-compatible anyway.
  tsickleDiagnostics = tsickleDiagnostics.filter(
      d => d.category === ts.DiagnosticCategory.Error ||
          !host.shouldIgnoreWarningsForPath(d.file!.fileName));

  return {
    modulesManifest,
    emitSkipped,
    emittedFiles: emittedFiles || [],
    diagnostics: [...tsDiagnostics, ...tsickleDiagnostics],
    externs
  };
}

/** Compares two strings and returns a number suitable for use in sort(). */
function stringCompare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * A tsickle produced declaration file might be consumed be referenced by Clutz
 * produced .d.ts files, which use symbol names based on Closure's internal
 * naming conventions, so we need to provide aliases for all the exported symbols
 * in the Clutz naming convention.
 */
function addClutzAliases(
    fileName: string, dtsFileContent: string, sourceFile: ts.SourceFile,
    typeChecker: ts.TypeChecker, host: TsickleHost): string {
  const moduleSymbol = typeChecker.getSymbolAtLocation(sourceFile);
  const moduleExports = moduleSymbol && typeChecker.getExportsOfModule(moduleSymbol);
  if (!moduleExports) return dtsFileContent;

  // .d.ts files can be transformed, too, so we need to compare the original node below.
  const origSourceFile = ts.getOriginalNode(sourceFile);
  // The module exports might be re-exports, and in the case of "export *" might not even be
  // available in the module scope, which makes them difficult to export. Avoid the problem by
  // filtering out symbols who do not have a declaration in the local module.
  const localExports = moduleExports.filter(e => {
    // If there are no declarations, be conservative and emit the aliases.
    if (!e.declarations) return true;
    // Skip default exports, they are not currently supported.
    // default is a keyword in typescript, so the name of the export being default means that it's a
    // default export.
    if (e.name === 'default') return false;
    // Otherwise check that some declaration is from the local module.
    return e.declarations.some(d => d.getSourceFile() === origSourceFile);
  });
  if (!localExports.length) return dtsFileContent;

  // TypeScript 2.8 and TypeScript 2.9 differ on the order in which the
  // module symbols come out, so sort here to make the tests stable.
  localExports.sort((a, b) => stringCompare(a.name, b.name));

  const moduleName = host.pathToModuleName('', sourceFile.fileName);
  const clutzModuleName = moduleName.replace(/\./g, '$');

  // Clutz might refer to the name in two different forms (stemming from goog.provide and
  // goog.module respectively).
  // 1) global in clutz:   ಠ_ಠ.clutz.module$contents$path$to$module_Symbol...
  // 2) local in a module: ಠ_ಠ.clutz.module$exports$path$to$module.Symbol ..
  // See examples at:
  // https://github.com/angular/clutz/tree/master/src/test/java/com/google/javascript/clutz

  // Case (1) from above.
  let globalSymbols = '';
  // Case (2) from above.
  let nestedSymbols = '';
  for (const symbol of localExports) {
    globalSymbols +=
        `\t\texport {${symbol.name} as module$contents$${clutzModuleName}_${symbol.name}}\n`;
    nestedSymbols +=
        `\t\texport {module$contents$${clutzModuleName}_${symbol.name} as ${symbol.name}}\n`;
    if (symbol.flags & ts.SymbolFlags.Class) {
      globalSymbols += `\t\texport {${symbol.name} as module$contents$${clutzModuleName}_${
          symbol.name}_Instance}\n`;
      nestedSymbols += `\t\texport {module$contents$${clutzModuleName}_${symbol.name} as ${
          symbol.name}_Instance}\n`;
    }
  }

  dtsFileContent += 'declare global {\n';
  dtsFileContent += `\tnamespace ಠ_ಠ.clutz {\n`;
  dtsFileContent += globalSymbols;
  dtsFileContent += `\t}\n`;
  dtsFileContent += `\tnamespace ಠ_ಠ.clutz.module$exports$${clutzModuleName} {\n`;
  dtsFileContent += nestedSymbols;
  dtsFileContent += `\t}\n`;
  dtsFileContent += '}\n';

  return dtsFileContent;
}

function skipTransformForSourceFileIfNeeded(
    host: TsickleHost,
    delegateFactory: ts.TransformerFactory<ts.SourceFile>): ts.TransformerFactory<ts.SourceFile> {
  return (context: ts.TransformationContext) => {
    const delegate = delegateFactory(context);
    return (sourceFile: ts.SourceFile) => {
      if (host.shouldSkipTsickleProcessing(sourceFile.fileName)) {
        return sourceFile;
      }
      return delegate(sourceFile);
    };
  };
}

function combineInlineSourceMaps(
    program: ts.Program, filePath: string, compiledJsWithInlineSourceMap: string): string {
  if (isDtsFileName(filePath)) {
    return compiledJsWithInlineSourceMap;
  }
  const sourceMapJson = extractInlineSourceMap(compiledJsWithInlineSourceMap);
  compiledJsWithInlineSourceMap = removeInlineSourceMap(compiledJsWithInlineSourceMap);
  const composedSourceMap = combineSourceMaps(program, filePath, sourceMapJson);
  return setInlineSourceMap(compiledJsWithInlineSourceMap, composedSourceMap);
}

function combineSourceMaps(
    program: ts.Program, filePath: string, tscSourceMapText: string): string {
  const tscSourceMap = parseSourceMap(tscSourceMapText);
  if (tscSourceMap.sourcesContent) {
    // strip incoming sourcemaps from the sources in the sourcemap
    // to reduce the size of the sourcemap.
    tscSourceMap.sourcesContent = tscSourceMap.sourcesContent.map(content => {
      if (containsInlineSourceMap(content)) {
        content = removeInlineSourceMap(content);
      }
      return content;
    });
  }
  const fileDir = path.dirname(filePath);
  let tscSourceMapGenerator: SourceMapGenerator|undefined;
  for (const sourceFileName of tscSourceMap.sources) {
    const sourceFile = program.getSourceFile(path.resolve(fileDir, sourceFileName));
    if (!sourceFile || !containsInlineSourceMap(sourceFile.text)) {
      continue;
    }
    const preexistingSourceMapText = extractInlineSourceMap(sourceFile.text);
    if (!tscSourceMapGenerator) {
      tscSourceMapGenerator = SourceMapGenerator.fromSourceMap(new SourceMapConsumer(tscSourceMap));
    }
    tscSourceMapGenerator.applySourceMap(
        new SourceMapConsumer(parseSourceMap(preexistingSourceMapText, sourceFileName)));
  }
  return tscSourceMapGenerator ? tscSourceMapGenerator.toString() : tscSourceMapText;
}
