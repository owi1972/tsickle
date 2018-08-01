/**
 * This test is simulating what it's like when someone augments a module.
 * The interesting output is the generated externs.
 */

import * as localAlias from './angular';

declare module './angular' {
  /**
   * sub is a namespace that exists in angular already; this file is
   * augmenting it.
   */
  namespace sub {
    interface AugmentSubType {
      prop: string
    }
  }

  /**
   * local is a new namespace introduced by this file.
   */
  namespace local {
    type LocalType = string;
    // TODO: the type below should not be emitted using localAlias.
    type UsingSymbolFromAugmentedModule = localAlias.Scope;
  }
}
