import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';

let cachedSpec: object | null = null;

/**
 * GET /api/openapi
 *
 * Serves the OpenAPI spec as JSON. Public endpoint (no auth required).
 * The YAML source is read once and cached in memory.
 */
export async function GET() {
  if (!cachedSpec) {
    const yamlPath = join(process.cwd(), 'openapi.yaml');
    const yamlContent = readFileSync(yamlPath, 'utf-8');
    cachedSpec = yaml.load(yamlContent) as object;
  }

  return NextResponse.json(cachedSpec, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
