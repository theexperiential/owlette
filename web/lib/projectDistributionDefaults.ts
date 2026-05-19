export interface ProjectDistributionPresetDefinition {
  name: string;
  description?: string;
  /**
   * Optional URL. Built-ins typically leave this blank since they're shipped
   * generic templates; users override URL when saving a custom preset.
   */
  project_url?: string;
  extract_path?: string;
  verify_files?: string[];
}

/**
 * Built-in project distribution presets shipped with the app.
 * Merged client-side with site-level custom presets in
 * useProjectDistributionPresets.
 *
 * Presets carry config (extract_path, verify_files) plus an optional
 * project_url for projects redistributed periodically. Distribution name
 * stays per-deployment since it's typically time-bound (e.g. "Summer Show
 * 2024"), not per-project.
 */
export const BUILT_IN_PROJECT_DISTRIBUTION_PRESETS: ProjectDistributionPresetDefinition[] = [
  {
    name: 'TouchDesigner project',
    description: 'standard TouchDesigner project distribution',
    extract_path: 'C:\\TouchDesigner\\Projects',
    verify_files: ['MyProject.toe'],
  },
];
