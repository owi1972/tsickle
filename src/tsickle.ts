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
import {enumTransformer} from './enum_transformer';
import {createExterns} from './externs';
import {transformFileoverviewComment} from './fileoverview_comment_transformer';
import * as googmodule from './googmodule';
import {jsdocTransformer} from './jsdoc_transformer';
import {ModulesManifest} from './modules_manifest';
import {quotingTransformer} from './quoting_transformer';
import { getIdentifierText} from './rewriter';
import {containsInlineSourceMap, extractInlineSourceMap, parseSourceMap, removeInlineSourceMap, setInlineSourceMap, SourceMapper} from './source_map_utils';
import * as ts from './typescript';
import {hasModifierFlag, isDtsFileName} from './util';

export {FileMap, ModulesManifest} from './modules_manifest';

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
 * The header to be used in generated externs.  This is not included in the
 * output of annotate() because annotate() works one file at a time, and
 * typically you create one externs file from the entire compilation unit.
 */
export const EXTERNS_HEADER = `/**
 * @externs
 * @suppress {duplicate,checkTypes}
 */
// NOTE: generated by tsickle, do not edit.
`;

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

/** Concatenate all generated externs definitions together into a string. */
export function getGeneratedExterns(externs: {[fileName: string]: string}): string {
  let allExterns = EXTERNS_HEADER;
  for (const fileName of Object.keys(externs)) {
    allExterns += `// externs from ${fileName}:\n`;
    allExterns += externs[fileName];
  }
  return allExterns;
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
    // Only add @suppress {checkTypes} comments when also adding type annotations.
    tsickleSourceTransformers.push(transformFileoverviewComment);
    tsickleSourceTransformers.push(
        jsdocTransformer(host, tsOptions, tsHost, typeChecker, tsickleDiagnostics));
    if (!host.disableAutoQuoting) {
      tsickleSourceTransformers.push(quotingTransformer(host, typeChecker, tsickleDiagnostics));
    }
    tsickleSourceTransformers.push(enumTransformer(typeChecker, tsickleDiagnostics));
    tsickleSourceTransformers.push(decoratorDownlevelTransformer(typeChecker, tsickleDiagnostics));
  } else if (host.transformDecorators) {
    tsickleSourceTransformers.push(decoratorDownlevelTransformer(typeChecker, tsickleDiagnostics));
  }
  const modulesManifest = new ModulesManifest();
  const tsickleTransformers: ts.CustomTransformers = {before: tsickleSourceTransformers};
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
      const {output, diagnostics} = createExterns(typeChecker, sf, host);
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
