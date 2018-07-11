/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {AnnotatorHost} from './jsdoc_transformer';
import {unescapeName} from './rewriter';
import * as ts from './typescript';

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
 * exportStarTransformer expands the names in an `export * from ...` export.
 *
 * Closure Compiler's module system (goog.module) does not support wildcard exports, so these must
 * be resolved before the CommonJS processing happens. This proces is separate from the googmodule
 * transformer because it must happen before CommonJS processing.
 */
export function exportStarTransformer(
    host: AnnotatorHost, typeChecker: ts.TypeChecker, tsOpts: ts.CompilerOptions,
    diagnostics: ts.Diagnostic[]): (context: ts.TransformationContext) =>
    ts.Transformer<ts.SourceFile> {
  return (context: ts.TransformationContext): ts.Transformer<ts.SourceFile> => {
    return (sourceFile: ts.SourceFile) => {
      const generatedExports = new Set<string>();
      // Gather the names of local exports, to avoid reexporting any
      // names that are already locally exported.
      const moduleSymbol = typeChecker.getSymbolAtLocation(sourceFile);
      const moduleExports = moduleSymbol && moduleSymbol.exports || new Map<string, ts.Symbol>();

      /**
       * Given a "export * from ..." statement, gathers the symbol names it actually
       * exports to be used in a statement like "export {foo, bar, baz} from ...".
       *
       * This is necessary because TS transpiles "export *" by just doing a runtime loop
       * over the target module's exports, which means Closure won't see the declarations/types
       * that are exported.
       */
      function expandSymbolsFromExportStar(exportDecl: ts.ExportDeclaration): NamedSymbol[] {
        // You can't have an "export *" without a module specifier.
        const moduleSpecifier = exportDecl.moduleSpecifier!;

        // Expand the export list, then filter it to the symbols we want to reexport.
        const exports =
            typeChecker.getExportsOfModule(typeChecker.getSymbolAtLocation(moduleSpecifier)!);
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
          } else if (moduleExports.has(name as ts.__String)) {
            // TODO(#634): check if this is a safe cast.
            continue;
          }
          // Already exported via an earlier expansion of an "export * from ...".
          if (generatedExports.has(name)) continue;

          generatedExports.add(name);
          reexports.add(sym);
        }
        return Array.from(reexports.keys()).map(sym => {
          return {name: sym.name, sym};
        });
      }

      function shouldEmitExportSymbol(sym: ts.Symbol): boolean {
        if (sym.flags & ts.SymbolFlags.Alias) {
          sym = typeChecker.getAliasedSymbol(sym);
        }
        if ((sym.flags & ts.SymbolFlags.Value) === 0) {
          // Note: We create explicit reexports via closure at another place in
          return false;
        }
        if (!tsOpts.preserveConstEnums && sym.flags & ts.SymbolFlags.ConstEnum) {
          return false;
        }
        return true;
      }

      function visitor(node: ts.Node) {
        if (!ts.isExportDeclaration(node)) return node;
        // export {A, B} from ...;
        if (node.exportClause) return node;
        // export without a URL to export (should only happen in conjunction with named exports,
        // covered by the check above).
        if (!node.moduleSpecifier) return node;

        // It's an "export * from ..." statement.
        // Rewrite it to re-export each exported symbol directly.
        const exportedSymbols = expandSymbolsFromExportStar(node);
        const exportSymbolsToEmit = exportedSymbols.filter(s => shouldEmitExportSymbol(s.sym));
        const namedExports = ts.createNamedExports(exportSymbolsToEmit.map(
            ns => ts.createExportSpecifier(undefined, unescapeName(ns.name))));
        return ts.updateExportDeclaration(
            node, node.decorators, node.modifiers, namedExports, node.moduleSpecifier);
      }

      return ts.visitEachChild(sourceFile, visitor, context);
    };
  };
}
