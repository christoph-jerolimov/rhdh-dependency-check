// The data model lives with the pipeline scripts; re-export it for the site.
export type * from '../../scripts/lib/types.ts';

import type { PackageJson, Summary } from '../../scripts/lib/types.ts';

export interface Workspace {
  name: string | null;
  packages: PackageJson[];
  summary: Summary;
}
