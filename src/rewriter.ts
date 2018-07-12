/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import * as ts from './typescript';

/** Returns the string contents of a ts.Identifier. */
export function getIdentifierText(identifier: ts.Identifier): string {
  // NOTE: 'escapedText' on an Identifier may be escaped if it starts with '__'. The alternative,
  // getText(), cannot be used on synthesized nodes, so unescape the identifier below.
  return unescapeName(identifier.escapedText as string);
}

/** Returns a dot-joined qualified name (foo.bar.Baz). */
export function getEntityNameText(name: ts.EntityName): string {
  if (ts.isIdentifier(name)) {
    return getIdentifierText(name);
  }
  return getEntityNameText(name.left) + '.' + getIdentifierText(name.right);
}

/**
 * Converts an escaped TypeScript name into the original source name.
 * Prefer getIdentifierText() instead if possible.
 */
export function unescapeName(name: string): string {
  // See the private function unescapeIdentifier in TypeScript's utilities.ts.
  if (name.startsWith('___')) return name.substring(1);
  return name;
}
