/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {SourceMapper, SourcePosition} from './source_map_utils';
import * as ts from './typescript';

/**
 * Implementation of the `SourceMapper` that stores and retrieves mappings
 * to original nodes.
 */
class NodeSourceMapper implements SourceMapper {
  private originalNodeByGeneratedRange = new Map<string, ts.Node>();
  private genStartPositions = new Map<ts.Node, number>();
  /** Conceptual offset for all nodes in this mapping. */
  private offset = 0;

  /**
   * Recursively adds a source mapping for node and each of its children, mapping ranges from the
   * generated start position plus the child nodes offset up to its length.
   *
   * This is a useful catch all that works for most nodes, as long as their distance from the parent
   * does not change during emit and their own length does not change during emit (e.g. there are no
   * comments added inside them, no rewrites happening).
   */
  private addFullNodeRange(node: ts.Node, genStartPos: number) {
    this.originalNodeByGeneratedRange.set(
        this.nodeCacheKey(node.kind, genStartPos, genStartPos + (node.getEnd() - node.getStart())),
        node);
    node.forEachChild(
        child => this.addFullNodeRange(child, genStartPos + (child.getStart() - node.getStart())));
  }

  shiftByOffset(offset: number) {
    this.offset += offset;
  }

  /**
   * Adds a mapping for the specific start/end range in the generated output back to the
   * originalNode.
   */
  addMappingForRange(originalNode: ts.Node, startPos: number, endPos: number) {
    // TODO(martinprobst): This glaringly duplicates addMapping below. However attempting to unify
    // these causes failures around exported variable nodes. Additionally, inspecting this code
    // longer suggests that it really only barely works by accident, and should much rather be
    // replaced by proper transformers :-(
    const cc = this.nodeCacheKey(originalNode.kind, startPos, endPos);
    this.originalNodeByGeneratedRange.set(cc, originalNode);
  }

  addMapping(
      originalNode: ts.Node, original: SourcePosition, generated: SourcePosition, length: number) {
    let originalStartPos = original.position;
    let genStartPos = generated.position;
    if (originalStartPos >= originalNode.getFullStart() &&
        originalStartPos <= originalNode.getStart()) {
      // always use the node.getStart() for the index,
      // as comments and whitespaces might differ between the original and transformed code.
      const diffToStart = originalNode.getStart() - originalStartPos;
      originalStartPos += diffToStart;
      genStartPos += diffToStart;
      length -= diffToStart;
      this.genStartPositions.set(originalNode, genStartPos);
    }
    if (originalStartPos + length === originalNode.getEnd()) {
      const cc = this.nodeCacheKey(
          originalNode.kind, this.genStartPositions.get(originalNode)!, genStartPos + length);
      this.originalNodeByGeneratedRange.set(cc, originalNode);
    }
    originalNode.forEachChild((child) => {
      if (child.getStart() >= originalStartPos && child.getEnd() <= originalStartPos + length) {
        this.addFullNodeRange(child, genStartPos + (child.getStart() - originalStartPos));
      }
    });
  }

  /** For the newly parsed `node`, find what node corresponded to it in the original source text. */
  getOriginalNode(node: ts.Node): ts.Node|undefined {
    // Apply the offset: if there is an offset > 0, all nodes are conceptually shifted by so many
    // characters from the start of the file.
    let start = node.getStart() - this.offset;
    if (start < 0) {
      // Special case: the source file conceptually spans all of the file, including any added
      // prefix added that causes offset to be set.
      if (node.kind !== ts.SyntaxKind.SourceFile) {
        // Nodes within [0, offset] of the new file (start < 0) is the additional prefix that has no
        // corresponding nodes in the original source, so return undefined.
        return undefined;
      }
      start = 0;
    }
    const end = node.getEnd() - this.offset;
    const key = this.nodeCacheKey(node.kind, start, end);
    return this.originalNodeByGeneratedRange.get(key);
  }

  private nodeCacheKey(kind: ts.SyntaxKind, start: number, end: number): string {
    return `${kind}#${start}#${end}`;
  }
}

// tslint:disable-next-line:no-any
function isNodeArray(value: any): value is ts.NodeArray<any> {
  const anyValue = value;
  return Array.isArray(value) && anyValue.pos !== undefined && anyValue.end !== undefined;
}

// tslint:disable-next-line:no-any
function isToken(value: any): value is ts.Token<any> {
  return value != null && typeof value === 'object' && value.kind >= ts.SyntaxKind.FirstToken &&
      value.kind <= ts.SyntaxKind.LastToken;
}

// Copied from TypeScript
function isLiteralKind(kind: ts.SyntaxKind) {
  return ts.SyntaxKind.FirstLiteralToken <= kind && kind <= ts.SyntaxKind.LastLiteralToken;
}
