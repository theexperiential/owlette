#!/usr/bin/env node
/**
 * Version Sync Script for Owlette Monorepo
 *
 * Keeps component versions in sync with product version.
 *
 * Usage:
 *   node scripts/sync-versions.js [new-version]
 *
 * Examples:
 *   node scripts/sync-versions.js         # Show current versions
 *   node scripts/sync-versions.js 2.1.0   # Bump all to 2.1.0
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Version file paths
const VERSION_FILES = {
  product: path.join(ROOT, 'VERSION'),
  agent: path.join(ROOT, 'agent', 'VERSION'),
  web: path.join(ROOT, 'web', 'package.json'),
};

// Documentation files with version references
const DOC_FILES = {
  readme: path.join(ROOT, 'README.md'),
  claudemd: path.join(ROOT, '.claude', 'CLAUDE.md'),
  versionMgmt: path.join(ROOT, 'docs', 'internal', 'version-management.md'),
};

// Today's date in YYYY-MM-DD (for "Last Updated" fields)
function todayISO() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// Read version from file
function readVersion(file) {
  if (file.endsWith('.json')) {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return pkg.version;
  }
  return fs.readFileSync(file, 'utf8').trim();
}

// Write version to file
function writeVersion(file, version) {
  if (file.endsWith('.json')) {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    pkg.version = version;
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  } else {
    fs.writeFileSync(file, version + '\n', 'utf8');
  }
}

// Update version in documentation file
// oldVersion is the previous product version — needed to precisely target
// lines like "**Current:** X.Y.Z" without touching independent versions (e.g. firestore rules).
function updateDocVersion(file, version, oldVersion) {
  let content = fs.readFileSync(file, 'utf8');
  let updated = false;

  if (file === DOC_FILES.readme) {
    // Update README.md shields.io version badge: version-X.Y.Z-blue
    const badgePattern = /(img\.shields\.io\/badge\/version-)\d+\.\d+\.\d+(-[a-z]+\))/;
    if (badgePattern.test(content)) {
      content = content.replace(badgePattern, `$1${version}$2`);
      updated = true;
    }

    // Also handle legacy **Version X.Y.Z** format if present
    const readmePattern = /\*\*Version \d+\.\d+\.\d+\*\*/;
    if (readmePattern.test(content)) {
      content = content.replace(readmePattern, `**Version ${version}**`);
      updated = true;
    }
  } else if (file === DOC_FILES.versionMgmt) {
    // Update product/agent/web "Current: X.Y.Z" entries (skip firestore rules — independent)
    // The file has 3 "**Current:** X.Y.Z" lines for product/agent/web, and one for firestore rules (2.2.0).
    // We replace only those matching the previous product version to avoid touching firestore rules.
    const escapedPrev = oldVersion.replace(/\./g, '\\.');
    const currentPattern = new RegExp(`\\*\\*Current:\\*\\* ${escapedPrev}`, 'g');
    if (currentPattern.test(content)) {
      content = content.replace(currentPattern, `**Current:** ${version}`);
      updated = true;
    }

    // Update trailing "Last Updated" line (supports **Last Updated:** or **Last Updated**:)
    const lastUpdatedPattern = /\*\*Last Updated:?\*\*:? \d{4}-\d{2}-\d{2}/;
    if (lastUpdatedPattern.test(content)) {
      content = content.replace(lastUpdatedPattern, `**Last Updated:** ${todayISO()}`);
      updated = true;
    }
  } else if (file === DOC_FILES.claudemd) {
    // Update .claude/CLAUDE.md in multiple places

    // 1. Update: **Version**: X.Y.Z (see [Version Management]...)
    const headerPattern = /\*\*Version\*\*: \d+\.\d+\.\d+/;
    if (headerPattern.test(content)) {
      content = content.replace(headerPattern, `**Version**: ${version}`);
      updated = true;
    }

    // 2. Update version file examples section
    // - `/VERSION` - Product release version (X.Y.Z)
    // - `agent/VERSION` - Agent binary version (X.Y.Z)
    // - `web/package.json` - Web app version (X.Y.Z)
    const versionFilesPattern = /- `\/VERSION` - Product release version \(\d+\.\d+\.\d+\)\n- `agent\/VERSION` - Agent binary version \(\d+\.\d+\.\d+\)\n- `web\/package\.json` - Web app version \(\d+\.\d+\.\d+\)/;
    if (versionFilesPattern.test(content)) {
      const replacement = `- \`/VERSION\` - Product release version (${version})\n- \`agent/VERSION\` - Agent binary version (${version})\n- \`web/package.json\` - Web app version (${version})`;
      content = content.replace(versionFilesPattern, replacement);
      updated = true;
    }

    // 3. Update trailing "Last Updated" line
    const lastUpdatedPattern = /\*\*Last Updated\*\*: \d{4}-\d{2}-\d{2}/;
    if (lastUpdatedPattern.test(content)) {
      content = content.replace(lastUpdatedPattern, `**Last Updated**: ${todayISO()}`);
      updated = true;
    }

    // 4. Update: **Current Version**: X.Y.Z (November...)
    const currentVersionPattern = /\*\*Current Version\*\*: \d+\.\d+\.\d+/;
    if (currentVersionPattern.test(content)) {
      // Get current date
      const now = new Date();
      const monthNames = ["January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"];
      const dateStr = `${monthNames[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;

      // Replace the entire Current Version line
      content = content.replace(
        /\*\*Current Version\*\*: \d+\.\d+\.\d+ \([^)]+\)/,
        `**Current Version**: ${version} (${dateStr})`
      );
      updated = true;
    }
  }

  if (updated) {
    fs.writeFileSync(file, content, 'utf8');
  }

  return updated;
}

// Show current versions
function showVersions() {
  console.log('\n📦 Current Versions:\n');
  console.log(`  Product:  ${readVersion(VERSION_FILES.product)}`);
  console.log(`  Agent:    ${readVersion(VERSION_FILES.agent)}`);
  console.log(`  Web:      ${readVersion(VERSION_FILES.web)}`);
  console.log('\n  Note: Firestore rules version is independent (tracks schema changes)\n');
}

// Sync all versions
function syncVersions(newVersion) {
  if (!newVersion.match(/^\d+\.\d+\.\d+$/)) {
    console.error(`❌ Invalid version format: ${newVersion}`);
    console.error('   Expected format: X.Y.Z (e.g., 2.1.0)');
    process.exit(1);
  }

  const oldVersion = readVersion(VERSION_FILES.product);

  console.log(`\n🔄 Syncing all versions to ${newVersion} (was ${oldVersion})...\n`);

  writeVersion(VERSION_FILES.product, newVersion);
  console.log(`  ✅ Updated /VERSION → ${newVersion}`);

  writeVersion(VERSION_FILES.agent, newVersion);
  console.log(`  ✅ Updated agent/VERSION → ${newVersion}`);

  writeVersion(VERSION_FILES.web, newVersion);
  console.log(`  ✅ Updated web/package.json → ${newVersion}`);

  // Update documentation files
  if (updateDocVersion(DOC_FILES.readme, newVersion, oldVersion)) {
    console.log(`  ✅ Updated README.md → ${newVersion}`);
  }

  if (updateDocVersion(DOC_FILES.claudemd, newVersion, oldVersion)) {
    console.log(`  ✅ Updated .claude/CLAUDE.md → ${newVersion}`);
  }

  if (updateDocVersion(DOC_FILES.versionMgmt, newVersion, oldVersion)) {
    console.log(`  ✅ Updated docs/internal/version-management.md → ${newVersion}`);
  }

  console.log('\n✨ All versions synced!\n');
  console.log('⚠️  Remember to:');
  console.log('   1. Update CHANGELOG.md with release notes');
  console.log('   2. Commit changes: git commit -am "chore: Bump version to ' + newVersion + '"');
  console.log('   3. Create tag: git tag v' + newVersion);
  console.log('   4. Push with tags: git push origin main --tags\n');
}

// Main
const args = process.argv.slice(2);

if (args.length === 0) {
  showVersions();
} else if (args.length === 1) {
  syncVersions(args[0]);
} else {
  console.error('Usage: node scripts/sync-versions.js [new-version]');
  process.exit(1);
}
