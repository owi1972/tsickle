/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as path from 'path';

import {moduleNameAsIdentifier} from './externs';
import {AnnotatorHost, isAmbient} from './jsdoc_transformer';
import * as ts from './typescript';

/**
 * Determines if fileName refers to a builtin lib.d.ts file.
 * This is a terrible hack but it mirrors a similar thing done in Clutz.
 */
export function isBuiltinLibDTS(fileName: string): boolean {
  return fileName.match(/\blib\.(?:[^/]+\.)?d\.ts$/) != null;
}

/**
 * @return True if the named type is considered compatible with the Closure-defined
 *     type of the same name, e.g. "Array".  Note that we don't actually enforce
 *     that the types are actually compatible, but mostly just hope that they are due
 *     to being derived from the same HTML specs.
 */
function isClosureProvidedType(symbol: ts.Symbol): boolean {
  return symbol.declarations != null &&
      symbol.declarations.some(n => isBuiltinLibDTS(n.getSourceFile().fileName));
}

export function typeToDebugString(type: ts.Type): string {
  let debugString = `flags:0x${type.flags.toString(16)}`;

  if (type.aliasSymbol) {
    debugString += ` alias:${symbolToDebugString(type.aliasSymbol)}`;
  }
  if (type.aliasTypeArguments) {
    debugString += ` aliasArgs:<${type.aliasTypeArguments.map(typeToDebugString).join(',')}>`;
  }

  // Just the unique flags (powers of two). Declared in src/compiler/types.ts.
  const basicTypes: ts.TypeFlags[] = [
    ts.TypeFlags.Any,           ts.TypeFlags.String,         ts.TypeFlags.Number,
    ts.TypeFlags.Boolean,       ts.TypeFlags.Enum,           ts.TypeFlags.StringLiteral,
    ts.TypeFlags.NumberLiteral, ts.TypeFlags.BooleanLiteral, ts.TypeFlags.EnumLiteral,
    ts.TypeFlags.ESSymbol,      ts.TypeFlags.UniqueESSymbol, ts.TypeFlags.Void,
    ts.TypeFlags.Undefined,     ts.TypeFlags.Null,           ts.TypeFlags.Never,
    ts.TypeFlags.TypeParameter, ts.TypeFlags.Object,         ts.TypeFlags.Union,
    ts.TypeFlags.Intersection,  ts.TypeFlags.Index,          ts.TypeFlags.IndexedAccess,
    ts.TypeFlags.Conditional,   ts.TypeFlags.Substitution,
  ];
  for (const flag of basicTypes) {
    if ((type.flags & flag) !== 0) {
      debugString += ` ${ts.TypeFlags[flag]}`;
    }
  }

  if (type.flags === ts.TypeFlags.Object) {
    const objType = type as ts.ObjectType;
    // Just the unique flags (powers of two). Declared in src/compiler/types.ts.
    const objectFlags: ts.ObjectFlags[] = [
      ts.ObjectFlags.Class,
      ts.ObjectFlags.Interface,
      ts.ObjectFlags.Reference,
      ts.ObjectFlags.Tuple,
      ts.ObjectFlags.Anonymous,
      ts.ObjectFlags.Mapped,
      ts.ObjectFlags.Instantiated,
      ts.ObjectFlags.ObjectLiteral,
      ts.ObjectFlags.EvolvingArray,
      ts.ObjectFlags.ObjectLiteralPatternWithComputedProperties,
    ];
    for (const flag of objectFlags) {
      if ((objType.objectFlags & flag) !== 0) {
        debugString += ` object:${ts.ObjectFlags[flag]}`;
      }
    }
  }

  if (type.symbol && type.symbol.name !== '__type') {
    debugString += ` symbol.name:${JSON.stringify(type.symbol.name)}`;
  }

  if (type.pattern) {
    debugString += ` destructuring:true`;
  }

  return `{type ${debugString}}`;
}

export function symbolToDebugString(sym: ts.Symbol): string {
  let debugString = `${JSON.stringify(sym.name)} flags:0x${sym.flags.toString(16)}`;

  // Just the unique flags (powers of two). Declared in src/compiler/types.ts.
  const symbolFlags = [
    ts.SymbolFlags.FunctionScopedVariable,
    ts.SymbolFlags.BlockScopedVariable,
    ts.SymbolFlags.Property,
    ts.SymbolFlags.EnumMember,
    ts.SymbolFlags.Function,
    ts.SymbolFlags.Class,
    ts.SymbolFlags.Interface,
    ts.SymbolFlags.ConstEnum,
    ts.SymbolFlags.RegularEnum,
    ts.SymbolFlags.ValueModule,
    ts.SymbolFlags.NamespaceModule,
    ts.SymbolFlags.TypeLiteral,
    ts.SymbolFlags.ObjectLiteral,
    ts.SymbolFlags.Method,
    ts.SymbolFlags.Constructor,
    ts.SymbolFlags.GetAccessor,
    ts.SymbolFlags.SetAccessor,
    ts.SymbolFlags.Signature,
    ts.SymbolFlags.TypeParameter,
    ts.SymbolFlags.TypeAlias,
    ts.SymbolFlags.ExportValue,
    ts.SymbolFlags.Alias,
    ts.SymbolFlags.Prototype,
    ts.SymbolFlags.ExportStar,
    ts.SymbolFlags.Optional,
    ts.SymbolFlags.Transient,
  ];
  for (const flag of symbolFlags) {
    if ((sym.flags & flag) !== 0) {
      debugString += ` ${ts.SymbolFlags[flag]}`;
    }
  }

  return debugString;
}

/** A module declared as "declare module 'external_name' {...}" (note the quotes). */
type AmbientModuleDeclaration = ts.ModuleDeclaration&{name: ts.StringLiteral};

/**
 * Searches for an ambient module declaration in the ancestors of declarations, depth first, and
 * returns the first or null if none found.
 */
function getContainingAmbientModuleDeclaration(declarations: ts.Declaration[]):
    AmbientModuleDeclaration|null {
  for (const declaration of declarations) {
    let parent = declaration.parent;
    while (parent) {
      if (ts.isModuleDeclaration(parent) && ts.isStringLiteral(parent.name)) {
        return parent as AmbientModuleDeclaration;
      }
      parent = parent.parent;
    }
  }
  return null;
}

/** Returns true if any of declarations is a top level declaration in an external module. */
function isTopLevelExternal(declarations: ts.Declaration[]) {
  for (const declaration of declarations) {
    if (declaration.parent === undefined) continue;
    if (ts.isSourceFile(declaration.parent) && ts.isExternalModule(declaration.parent)) return true;
  }
  return false;
}

/**
 * Returns true if a and b are (or were originally before transformation) nodes of the same source
 * file.
 */
function isDeclaredInSameFile(a: ts.Node, b: ts.Node) {
  return ts.getOriginalNode(a).getSourceFile() === ts.getOriginalNode(b).getSourceFile();
}

/** TypeTranslator translates TypeScript types to Closure types. */
export class TypeTranslator {
  /**
   * A list of type literals we've encountered while emitting; used to avoid getting stuck in
   * recursive types.
   */
  private readonly seenAnonymousTypes = new Set<ts.Type>();

  /**
   * Whether to write types suitable for an \@externs file. Externs types must not refer to
   * non-externs types (i.e. non ambient types) and need to use fully qualified names.
   */
  isForExterns = false;

  /**
   * @param node is the source AST ts.Node the type comes from.  This is used
   *     in some cases (e.g. anonymous types) for looking up field names.
   * @param pathBlackList is a set of paths that should never get typed;
   *     any reference to symbols defined in these paths should by typed
   *     as {?}.
   * @param symbolsToAliasedNames a mapping from symbols (`Foo`) to a name in scope they should be
   *     emitted as (e.g. `tsickle_forward_declare_1.Foo`). Can be augmented during type
   *     translation, e.g. to blacklist a symbol.
   */
  constructor(
      private readonly host: AnnotatorHost, private readonly typeChecker: ts.TypeChecker,
      private readonly node: ts.Node, private readonly pathBlackList?: Set<string>,
      private readonly symbolsToAliasedNames = new Map<ts.Symbol, string>(),
      private readonly ensureSymbolDeclared: (sym: ts.Symbol) => void = () => {}) {
    // Normalize paths to not break checks on Windows.
    if (this.pathBlackList != null) {
      this.pathBlackList =
          new Set<string>(Array.from(this.pathBlackList.values()).map(p => path.normalize(p)));
    }
  }

  /**
   * Converts a ts.Symbol to a string.
   * Other approaches that don't work:
   * - TypeChecker.typeToString translates Array as T[].
   * - TypeChecker.symbolToString emits types without their namespace,
   *   and doesn't let you pass the flag to control that.
   * @param useFqn whether to scope the name using its fully qualified name. Closure's template
   *     arguments are always scoped to the class containing them, where TypeScript's template args
   *     would be fully qualified. I.e. this flag is false for generic types.
   */
  symbolToString(sym: ts.Symbol, useFqn: boolean): string {
    // TypeScript resolves e.g. union types to their members, which can include symbols not declared
    // in the current scope. Ensure that all symbols found this way are actually declared.
    // This must happen before the alias check below, it might introduce a new alias for the symbol.
    if (!this.isForExterns && (sym.flags & ts.SymbolFlags.TypeParameter) === 0) {
      this.ensureSymbolDeclared(sym);
    }

    // This follows getSingleLineStringWriter in the TypeScript compiler.
    let str = '';
    function writeText(text: string) {
      str += text;
    }
    const writeSymbol = (text: string, symbol: ts.Symbol) => {
      // When writing a symbol, check if there is an alias for it in the current scope that should
      // take precedence, e.g. from a goog.forwardDeclare.
      if (symbol.flags & ts.SymbolFlags.Alias) {
        symbol = this.typeChecker.getAliasedSymbol(symbol);
      }
      const alias = this.symbolsToAliasedNames.get(symbol);
      if (alias) {
        // If so, discard the entire current text and only use the alias - otherwise if a symbol has
        // a local alias but appears in a dotted type path (e.g. when it's imported using import *
        // as foo), str would contain both the prefx *and* the full alias (foo.alias.name).
        str = alias;
      } else {
        const mangledPrefix = this.maybeGetMangledNamePrefix(symbol);
        str += mangledPrefix + text;
      }
    };
    const doNothing = () => {
      return;
    };

    const builder = this.typeChecker.getSymbolDisplayBuilder();
    const writer: ts.SymbolWriter = {
      writeSymbol,
      writeKeyword: writeText,
      writeOperator: writeText,
      writePunctuation: writeText,
      writeSpace: writeText,
      writeStringLiteral: writeText,
      writeParameter: writeText,
      writeProperty: writeText,
      writeLine: doNothing,
      increaseIndent: doNothing,
      decreaseIndent: doNothing,
      clear: doNothing,
      trackSymbol(symbol: ts.Symbol, enclosingDeclaration?: ts.Node, meaning?: ts.SymbolFlags) {
        return;
      },
      reportInaccessibleThisError: doNothing,
      reportPrivateInBaseOfClassExpression: doNothing,
    };
    builder.buildSymbolDisplay(sym, writer, this.node);
    return this.stripClutzNamespace(str);
  }

  /**
   * Returns the mangled name prefix for symbol, or an empty string if not applicable.
   *
   * Type names are emitted with a mangled prefix if they are top level symbols declared in an
   * external module (.d.ts or .ts), and are ambient declarations ("declare ..."). This is because
   * their declarations get moved to externs files (to make external names visible to Closure and
   * prevent renaming), which only use global names. This means the names must be mangled to prevent
   * collisions and allow referencing them uniquely.
   *
   * This method also handles the special case of symbols declared in an ambient external module
   * context.
   *
   * Symbols declared in a global block, e.g. "declare global { type X; }", are handled implicitly:
   * when referenced, they are written as just "X", which is not a top level declaration, so the
   * code below ignores them.
   */
  maybeGetMangledNamePrefix(symbol: ts.Symbol): string|'' {
    if (!symbol.declarations) return '';
    const declarations = symbol.declarations;
    let ambientModuleDeclaration: AmbientModuleDeclaration|null = null;
    // If the symbol is neither a top level declaration in an external module nor in an ambient
    // block, tsickle should not emit a prefix: it's either not an external symbol, or it's an
    // external symbol nested in a module, so it will need to be qualified, and the mangling prefix
    // goes on the qualifier.
    if (!isTopLevelExternal(declarations)) {
      ambientModuleDeclaration = getContainingAmbientModuleDeclaration(declarations);
      if (!ambientModuleDeclaration) return '';
    }
    // At this point, the declaration is from an external module (possibly ambient).
    // These declarations must be prefixed if either:
    // (a) tsickle is emitting an externs file, so all symbols are qualified within it
    // (b) or the declaration must be an ambient declaration from the local file.
    // Ambient external declarations from other files are imported, so there's a local alias for the
    // module and no mangling is needed.
    if (!this.isForExterns &&
        !declarations.every(d => isDeclaredInSameFile(this.node, d) && isAmbient(d))) {
      return '';
    }
    // If from an ambient declaration, use and resolve the name from that. Otherwise, use the file
    // name from the (arbitrary) first declaration to mangle.
    const fileName = ambientModuleDeclaration ?
        ambientModuleDeclaration.name.text :
        ts.getOriginalNode(declarations[0]).getSourceFile().fileName;
    const mangled = moduleNameAsIdentifier(this.host, fileName, this.node.getSourceFile().fileName);
    return mangled + '.';
  }

  // Clutz (https://github.com/angular/clutz) emits global type symbols hidden in a special
  // ಠ_ಠ.clutz namespace. While most code seen by Tsickle will only ever see local aliases, Clutz
  // symbols can be written by users directly in code, and they can appear by dereferencing
  // TypeAliases. The code below simply strips the prefix, the remaining type name then matches
  // Closure's type.
  private stripClutzNamespace(name: string) {
    if (name.startsWith('ಠ_ಠ.clutz.')) return name.substring('ಠ_ಠ.clutz.'.length);
    return name;
  }

  translate(type: ts.Type): string {
    // NOTE: Though type.flags has the name "flags", it usually can only be one
    // of the enum options at a time (except for unions of literal types, e.g. unions of boolean
    // values, string values, enum values). This switch handles all the cases in the ts.TypeFlags
    // enum in the order they occur.

    // NOTE: Some TypeFlags are marked "internal" in the d.ts but still show up in the value of
    // type.flags. This mask limits the flag checks to the ones in the public API. "lastFlag" here
    // is the last flag handled in this switch statement, and should be kept in sync with
    // typescript.d.ts.

    // NonPrimitive occurs on its own on the lower case "object" type. Special case to "!Object".
    if (type.flags === ts.TypeFlags.NonPrimitive) return '!Object';

    // Avoid infinite loops on recursive type literals.
    // It would be nice to just emit the name of the recursive type here (in type.aliasSymbol
    // below), but Closure Compiler does not allow recursive type definitions.
    if (this.seenAnonymousTypes.has(type)) return '?';

    let isAmbient = false;
    let isInNamespace = false;
    let isModule = false;
    if (type.symbol) {
      for (const decl of type.symbol.declarations || []) {
        if (ts.isExternalModule(decl.getSourceFile())) isModule = true;
        let current: ts.Node|undefined = decl;
        while (current) {
          if (ts.getCombinedModifierFlags(current) & ts.ModifierFlags.Ambient) isAmbient = true;
          if (current.kind === ts.SyntaxKind.ModuleDeclaration) isInNamespace = true;
          current = current.parent;
        }
      }
    }

    // tsickle cannot generate types for non-ambient namespaces nor any symbols contained in them.
    if (isInNamespace && !isAmbient) return '?';

    // Types in externs cannot reference types from external modules.
    // However ambient types in modules get moved to externs, too, so type references work and we
    // can emit a precise type.
    if (this.isForExterns && isModule && !isAmbient) return '?';

    const lastFlag = ts.TypeFlags.Substitution;
    const mask = (lastFlag << 1) - 1;
    switch (type.flags & mask) {
      case ts.TypeFlags.Any:
        return '?';
      case ts.TypeFlags.String:
      case ts.TypeFlags.StringLiteral:
        return 'string';
      case ts.TypeFlags.Number:
      case ts.TypeFlags.NumberLiteral:
        return 'number';
      case ts.TypeFlags.Boolean:
      case ts.TypeFlags.BooleanLiteral:
        // See the note in translateUnion about booleans.
        return 'boolean';
      case ts.TypeFlags.Enum:
        if (!type.symbol) {
          this.warn(`EnumType without a symbol`);
          return '?';
        }
        return this.symbolToString(type.symbol, true);
      case ts.TypeFlags.ESSymbol:
      case ts.TypeFlags.UniqueESSymbol:
        // ESSymbol indicates something typed symbol.
        // UniqueESSymbol indicates a specific unique symbol, used e.g. to index into an object.
        // Closure does not have this distinction, so tsickle emits both as 'symbol'.
        return 'symbol';
      case ts.TypeFlags.Void:
        return 'void';
      case ts.TypeFlags.Undefined:
        return 'undefined';
      case ts.TypeFlags.Null:
        return 'null';
      case ts.TypeFlags.Never:
        this.warn(`should not emit a 'never' type`);
        return '?';
      case ts.TypeFlags.TypeParameter:
        // This is e.g. the T in a type like Foo<T>.
        if (!type.symbol) {
          this.warn(`TypeParameter without a symbol`);  // should not happen (tm)
          return '?';
        }
        // In Closure Compiler, type parameters *are* scoped to their containing class.
        const useFqn = false;
        return this.symbolToString(type.symbol, useFqn);
      case ts.TypeFlags.Object:
        return this.translateObject(type as ts.ObjectType);
      case ts.TypeFlags.Union:
        return this.translateUnion(type as ts.UnionType);
      case ts.TypeFlags.Conditional:
      case ts.TypeFlags.Substitution:
        this.warn(`emitting ? for conditional/substitution type`);
        return '?';
      case ts.TypeFlags.Intersection:
      case ts.TypeFlags.Index:
      case ts.TypeFlags.IndexedAccess:
        // TODO(ts2.1): handle these special types.
        this.warn(`unhandled type flags: ${ts.TypeFlags[type.flags]}`);
        return '?';
      default:
        // Handle cases where multiple flags are set.

        // Types with literal members are represented as
        //   ts.TypeFlags.Union | [literal member]
        // E.g. an enum typed value is a union type with the enum's members as its members. A
        // boolean type is a union type with 'true' and 'false' as its members.
        // Note also that in a more complex union, e.g. boolean|number, then it's a union of three
        // things (true|false|number) and ts.TypeFlags.Boolean doesn't show up at all.
        if (type.flags & ts.TypeFlags.Union) {
          return this.translateUnion(type as ts.UnionType);
        }

        if (type.flags & ts.TypeFlags.EnumLiteral) {
          return this.translateEnumLiteral(type);
        }

        // The switch statement should have been exhaustive.
        throw new Error(`unknown type flags ${type.flags} on ${typeToDebugString(type)}`);
    }
  }

  private translateUnion(type: ts.UnionType): string {
    let parts = type.types.map(t => this.translate(t));
    // Union types that include literals (e.g. boolean, enum) can end up repeating the same Closure
    // type. For example: true | boolean will be translated to boolean | boolean.
    // Remove duplicates to produce types that read better.
    parts = parts.filter((el, idx) => parts.indexOf(el) === idx);
    return parts.length === 1 ? parts[0] : `(${parts.join('|')})`;
  }

  private translateEnumLiteral(type: ts.Type): string {
    // Suppose you had:
    //   enum EnumType { MEMBER }
    // then the type of "EnumType.MEMBER" is an enum literal (the thing passed to this function)
    // and it has type flags that include
    //   ts.TypeFlags.NumberLiteral | ts.TypeFlags.EnumLiteral
    //
    // Closure Compiler doesn't support literals in types, so this code must not emit
    // "EnumType.MEMBER", but rather "EnumType".

    const enumLiteralBaseType = this.typeChecker.getBaseTypeOfLiteralType(type);
    if (!enumLiteralBaseType.symbol) {
      this.warn(`EnumLiteralType without a symbol`);
      return '?';
    }
    return this.symbolToString(enumLiteralBaseType.symbol, true);
  }

  // translateObject translates a ts.ObjectType, which is the type of all
  // object-like things in TS, such as classes and interfaces.
  private translateObject(type: ts.ObjectType): string {
    if (type.symbol && this.isBlackListed(type.symbol)) return '?';

    // NOTE: objectFlags is an enum, but a given type can have multiple flags.
    // Array<string> is both ts.ObjectFlags.Reference and ts.ObjectFlags.Interface.

    if (type.objectFlags & ts.ObjectFlags.Class) {
      if (!type.symbol) {
        this.warn('class has no symbol');
        return '?';
      }
      return '!' + this.symbolToString(type.symbol, /* useFqn */ true);
    } else if (type.objectFlags & ts.ObjectFlags.Interface) {
      // Note: ts.InterfaceType has a typeParameters field, but that
      // specifies the parameters that the interface type *expects*
      // when it's used, and should not be transformed to the output.
      // E.g. a type like Array<number> is a TypeReference to the
      // InterfaceType "Array", but the "number" type parameter is
      // part of the outer TypeReference, not a typeParameter on
      // the InterfaceType.
      if (!type.symbol) {
        this.warn('interface has no symbol');
        return '?';
      }
      if (type.symbol.flags & ts.SymbolFlags.Value) {
        // The symbol is both a type and a value.
        // For user-defined types in this state, we don't have a Closure name
        // for the type.  See the type_and_value test.
        if (!isClosureProvidedType(type.symbol)) {
          this.warn(`type/symbol conflict for ${type.symbol.name}, using {?} for now`);
          return '?';
        }
      }
      return '!' + this.symbolToString(type.symbol, /* useFqn */ true);
    } else if (type.objectFlags & ts.ObjectFlags.Reference) {
      // A reference to another type, e.g. Array<number> refers to Array.
      // Emit the referenced type and any type arguments.
      const referenceType = type as ts.TypeReference;

      // A tuple is a ReferenceType where the target is flagged Tuple and the
      // typeArguments are the tuple arguments.  Just treat it as a mystery
      // array, because Closure doesn't understand tuples.
      if (referenceType.target.objectFlags & ts.ObjectFlags.Tuple) {
        return '!Array<?>';
      }

      let typeStr = '';
      if (referenceType.target === referenceType) {
        // We get into an infinite loop here if the inner reference is
        // the same as the outer; this can occur when this function
        // fails to translate a more specific type before getting to
        // this point.
        throw new Error(
            `reference loop in ${typeToDebugString(referenceType)} ${referenceType.flags}`);
      }
      typeStr += this.translate(referenceType.target);
      // Translate can return '?' for a number of situations, e.g. type/value conflicts.
      // `?<?>` is illegal syntax in Closure Compiler, so just return `?` here.
      if (typeStr === '?') return '?';
      if (referenceType.typeArguments) {
        const params = referenceType.typeArguments.map(t => this.translate(t));
        typeStr += `<${params.join(', ')}>`;
      }
      return typeStr;
    } else if (type.objectFlags & ts.ObjectFlags.Anonymous) {
      if (!type.symbol) {
        // This comes up when generating code for an arrow function as passed
        // to a generic function.  The passed-in type is tagged as anonymous
        // and has no properties so it's hard to figure out what to generate.
        // Just avoid it for now so we don't crash.
        this.warn('anonymous type has no symbol');
        return '?';
      }

      if (type.symbol.flags & ts.SymbolFlags.Function ||
          type.symbol.flags & ts.SymbolFlags.Method) {
        const sigs = this.typeChecker.getSignaturesOfType(type, ts.SignatureKind.Call);
        if (sigs.length === 1) {
          return this.signatureToClosure(sigs[0]);
        }
        this.warn('unhandled anonymous type with multiple call signatures');
        return '?';
      } else {
        return this.translateAnonymousType(type);
      }
    }

    /*
    TODO(ts2.1): more unhandled object type flags:
      Tuple
      Mapped
      Instantiated
      ObjectLiteral
      EvolvingArray
      ObjectLiteralPatternWithComputedProperties
    */
    this.warn(`unhandled type ${typeToDebugString(type)}`);
    return '?';
  }

  /**
   * translateAnonymousType translates a ts.TypeFlags.ObjectType that is also
   * ts.ObjectFlags.Anonymous. That is, this type's symbol does not have a name. This is the
   * anonymous type encountered in e.g.
   *     let x: {a: number};
   * But also the inferred type in:
   *     let x = {a: 1};  // type of x is {a: number}, as above
   */
  private translateAnonymousType(type: ts.Type): string {
    this.seenAnonymousTypes.add(type);
    // Gather up all the named fields and whether the object is also callable.
    let callable = false;
    let indexable = false;
    const fields: string[] = [];
    if (!type.symbol || !type.symbol.members) {
      this.warn('anonymous type has no symbol');
      return '?';
    }

    // special-case construct signatures.
    const ctors = type.getConstructSignatures();
    if (ctors.length) {
      // TODO(martinprobst): this does not support additional properties defined on constructors
      // (not expressible in Closure), nor multiple constructors (same).
      const decl = ctors[0].declaration;
      if (!decl) {
        this.warn('unhandled anonymous type with constructor signature but no declaration');
        return '?';
      }
      if (decl.kind === ts.SyntaxKindJSDocSignature) {
        this.warn('unhandled JSDoc based constructor signature');
        return '?';
      }

      // new <T>(tee: T) is not supported by Closure, blacklist as ?.
      this.blacklistTypeParameters(this.symbolsToAliasedNames, decl.typeParameters);

      const params = this.convertParams(ctors[0], decl.parameters);
      const paramsStr = params.length ? (', ' + params.join(', ')) : '';
      const constructedType = this.translate(ctors[0].getReturnType());
      // In the specific case of the "new" in a function, it appears that
      //   function(new: !Bar)
      // fails to parse, while
      //   function(new: (!Bar))
      // parses in the way you'd expect.
      // It appears from testing that Closure ignores the ! anyway and just
      // assumes the result will be non-null in either case.  (To be pedantic,
      // it's possible to return null from a ctor it seems like a bad idea.)
      return `function(new: (${constructedType})${paramsStr}): ?`;
    }

    // members is an ES6 map, but the .d.ts defining it defined their own map
    // type, so typescript doesn't believe that .keys() is iterable
    // tslint:disable-next-line:no-any
    for (const field of (type.symbol.members.keys() as any)) {
      switch (field) {
        case '__call':
          callable = true;
          break;
        case '__index':
          indexable = true;
          break;
        default:
          const member = type.symbol.members.get(field)!;
          // optional members are handled by the type including |undefined in a union type.
          const memberType =
              this.translate(this.typeChecker.getTypeOfSymbolAtLocation(member, this.node));
          fields.push(`${field}: ${memberType}`);
          break;
      }
    }

    // Try to special-case plain key-value objects and functions.
    if (fields.length === 0) {
      if (callable && !indexable) {
        // A function type.
        const sigs = this.typeChecker.getSignaturesOfType(type, ts.SignatureKind.Call);
        if (sigs.length === 1) {
          return this.signatureToClosure(sigs[0]);
        }
      } else if (indexable && !callable) {
        // A plain key-value map type.
        let keyType = 'string';
        let valType = this.typeChecker.getIndexTypeOfType(type, ts.IndexKind.String);
        if (!valType) {
          keyType = 'number';
          valType = this.typeChecker.getIndexTypeOfType(type, ts.IndexKind.Number);
        }
        if (!valType) {
          this.warn('unknown index key type');
          return `!Object<?,?>`;
        }
        return `!Object<${keyType},${this.translate(valType)}>`;
      } else if (!callable && !indexable) {
        // Special-case the empty object {} because Closure doesn't like it.
        // TODO(evanm): revisit this if it is a problem.
        return '!Object';
      }
    }

    if (!callable && !indexable) {
      // Not callable, not indexable; implies a plain object with fields in it.
      return `{${fields.join(', ')}}`;
    }

    this.warn('unhandled anonymous type');
    return '?';
  }

  /** Converts a ts.Signature (function signature) to a Closure function type. */
  private signatureToClosure(sig: ts.Signature): string {
    // TODO(martinprobst): Consider harmonizing some overlap with emitFunctionType in tsickle.ts.
    if (!sig.declaration) {
      this.warn('signature without declaration');
      return 'Function';
    }
    if (sig.declaration.kind === ts.SyntaxKindJSDocSignature) {
      this.warn('signature with JSDoc declaration');
      return 'Function';
    }
    this.blacklistTypeParameters(this.symbolsToAliasedNames, sig.declaration.typeParameters);

    let typeStr = `function(`;
    let paramDecls: ReadonlyArray<ts.ParameterDeclaration> = sig.declaration.parameters || [];
    const maybeThisParam = paramDecls[0];
    // Oddly, the this type shows up in paramDecls, but not in the type's parameters.
    // Handle it here and then pass paramDecls down without its first element.
    if (maybeThisParam && maybeThisParam.name.getText() === 'this') {
      if (maybeThisParam.type) {
        const thisType = this.typeChecker.getTypeAtLocation(maybeThisParam.type);
        typeStr += `this: (${this.translate(thisType)})`;
        if (paramDecls.length > 1) typeStr += ', ';
      } else {
        this.warn('this type without type');
      }
      paramDecls = paramDecls.slice(1);
    }

    const params = this.convertParams(sig, paramDecls);
    typeStr += `${params.join(', ')})`;

    const retType = this.translate(this.typeChecker.getReturnTypeOfSignature(sig));
    if (retType) {
      typeStr += `: ${retType}`;
    }

    return typeStr;
  }

  /**
   * Converts parameters for the given signature. Takes parameter declarations as those might not
   * match the signature parameters (e.g. there might be an additional this parameter). This
   * difference is handled by the caller, as is converting the "this" parameter.
   */
  private convertParams(sig: ts.Signature, paramDecls: ReadonlyArray<ts.ParameterDeclaration>):
      string[] {
    const paramTypes: string[] = [];
    for (let i = 0; i < sig.parameters.length; i++) {
      const param = sig.parameters[i];

      const paramDecl = paramDecls[i];
      const optional = !!paramDecl.questionToken;
      const varArgs = !!paramDecl.dotDotDotToken;
      let paramType = this.typeChecker.getTypeOfSymbolAtLocation(param, this.node);
      if (varArgs) {
        const typeRef = paramType as ts.TypeReference;
        paramType = typeRef.typeArguments![0];
      }
      let typeStr = this.translate(paramType);
      if (varArgs) typeStr = '...' + typeStr;
      if (optional) typeStr = typeStr + '=';
      paramTypes.push(typeStr);
    }
    return paramTypes;
  }

  warn(msg: string) {
    // By default, warn() does nothing.  The caller will overwrite this
    // if it wants different behavior.
  }

  /** @return true if sym should always have type {?}. */
  isBlackListed(symbol: ts.Symbol): boolean {
    if (this.pathBlackList === undefined) return false;
    const pathBlackList = this.pathBlackList;
    // Some builtin types, such as {}, get represented by a symbol that has no declarations.
    if (symbol.declarations === undefined) return false;
    return symbol.declarations.every(n => {
      const fileName = path.normalize(n.getSourceFile().fileName);
      return pathBlackList.has(fileName);
    });
  }

  /**
   * Closure doesn not support type parameters for function types, i.e. generic function types.
   * Blacklist the symbols declared by them and emit a ? for the types.
   *
   * This mutates the given blacklist map. The map's scope is one file, and symbols are
   * unique objects, so this should neither lead to excessive memory consumption nor introduce
   * errors.
   *
   * @param blacklist a map to store the blacklisted symbols in, with a value of '?'. In practice,
   *     this is always === this.symbolsToAliasedNames, but we're passing it explicitly to make it
   *    clear that the map is mutated (in particular when used from outside the class).
   * @param decls the declarations whose symbols should be blacklisted.
   */
  blacklistTypeParameters(
      blacklist: Map<ts.Symbol, string>,
      decls: ReadonlyArray<ts.TypeParameterDeclaration>|undefined) {
    if (!decls || !decls.length) return;
    for (const tpd of decls) {
      const sym = this.typeChecker.getSymbolAtLocation(tpd.name);
      if (!sym) {
        this.warn(`type parameter with no symbol`);
        continue;
      }
      this.symbolsToAliasedNames.set(sym, '?');
    }
  }
}
