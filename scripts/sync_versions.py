#!/usr/bin/env python3
"""
Version Sync Script for Owlette Monorepo

Keeps component versions in sync with product version.

Usage:
    python scripts/sync_versions.py           # Show current versions
    python scripts/sync_versions.py 2.1.0     # Bump all to 2.1.0
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent

# Version file paths
VERSION_FILES = {
    'product': ROOT / 'VERSION',
    'agent': ROOT / 'agent' / 'VERSION',
    'web': ROOT / 'web' / 'package.json',
}


def read_version(file: Path) -> str:
    """Read version from file."""
    if file.suffix == '.json':
        with open(file, 'r', encoding='utf-8') as f:
            pkg = json.load(f)
            return pkg['version']
    return file.read_text(encoding='utf-8').strip()


def write_version(file: Path, version: str):
    """Write version to file."""
    if file.suffix == '.json':
        with open(file, 'r', encoding='utf-8') as f:
            pkg = json.load(f)
        pkg['version'] = version
        with open(file, 'w', encoding='utf-8') as f:
            json.dump(pkg, f, indent=2)
            f.write('\n')
    else:
        file.write_text(f"{version}\n", encoding='utf-8')


def show_versions():
    """Show current versions."""
    print('\n📦 Current Versions:\n')
    print(f"  Product:  {read_version(VERSION_FILES['product'])}")
    print(f"  Agent:    {read_version(VERSION_FILES['agent'])}")
    print(f"  Web:      {read_version(VERSION_FILES['web'])}")
    print('\n  Note: Firestore rules version is independent (tracks schema changes)\n')


def sync_versions(new_version: str):
    """Sync all versions to new version."""
    if not re.match(r'^\d+\.\d+\.\d+$', new_version):
        print(f"❌ Invalid version format: {new_version}")
        print("   Expected format: X.Y.Z (e.g., 2.1.0)")
        sys.exit(1)

    print(f'\n🔄 Syncing all versions to {new_version}...\n')

    write_version(VERSION_FILES['product'], new_version)
    print(f"  ✅ Updated /VERSION → {new_version}")

    write_version(VERSION_FILES['agent'], new_version)
    print(f"  ✅ Updated agent/VERSION → {new_version}")

    write_version(VERSION_FILES['web'], new_version)
    print(f"  ✅ Updated web/package.json → {new_version}")

    print('\n✨ All versions synced!\n')
    print('⚠️  Remember to:')
    print('   1. Update docs/changelog.md with release notes')
    print(f'   2. Commit changes: git commit -am "chore: Bump version to {new_version}"')
    print(f'   3. Create tag: git tag v{new_version}')
    print('   4. Push with tags: git push origin main --tags\n')


def main():
    """Main entry point."""
    if len(sys.argv) == 1:
        show_versions()
    elif len(sys.argv) == 2:
        sync_versions(sys.argv[1])
    else:
        print('Usage: python scripts/sync_versions.py [new-version]')
        sys.exit(1)


if __name__ == '__main__':
    main()
