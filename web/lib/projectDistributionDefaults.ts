export interface ProjectDistributionPresetDefinition {
  name: string;
  description?: string;
  /** Optional URL. Built-ins ship blank; users set it when saving a custom preset. */
  project_url?: string;
  extract_path?: string;
  verify_files?: string[];
}

/**
 * Built-in project distribution presets, merged client-side with site-level custom
 * presets in useProjectDistributionPresets.
 *
 * A preset carries config (extract_path, verify_files) plus an optional project_url for
 * projects redistributed periodically. The distribution NAME stays per-deployment since
 * it is usually time-bound ("Summer Show 2024"), not per-project.
 */
export const BUILT_IN_PROJECT_DISTRIBUTION_PRESETS: ProjectDistributionPresetDefinition[] = [
  {
    name: 'TouchDesigner project',
    description: 'standard TouchDesigner project distribution',
    extract_path: 'C:\\TouchDesigner\\Projects',
    verify_files: ['MyProject.toe'],
  },
];
