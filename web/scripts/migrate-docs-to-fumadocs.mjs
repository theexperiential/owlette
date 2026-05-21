#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webRoot, "..");
const sourceRoot = path.join(repoRoot, "docs");
const targetRoot = path.join(webRoot, "content", "docs");
const targetRootIndex = path.join(targetRoot, "index.mdx");

const excludedFiles = new Set([
  "maintainer-quickstart.md",
  "reference/api.md",
  "api/launch-runbook.md",
  "api/launch-assets.md",
  "api/developer-preview-checklist.md",
  "api/load-testing.md",
  "api/status-uptime.md",
]);

const excludedPrefixes = ["internal/", "ops/", "runbooks/"];
const calloutTypeMap = new Map([
  ["note", "info"],
  ["info", "info"],
  ["tip", "idea"],
  ["important", "warning"],
  ["warning", "warning"],
  ["danger", "error"],
]);

const allowlist = new Set();
const includedFiles = new Set();
const routeMap = new Map();
const metaByFolder = new Map();
const warnings = [];
const mermaidFiles = new Map();

function toPosix(value) {
  return value.replaceAll("\\", "/");
}

function normalizeSourcePath(value) {
  return path.posix.normalize(toPosix(value)).replace(/^\.\//, "");
}

function isExcluded(sourceRel) {
  return (
    excludedFiles.has(sourceRel) ||
    excludedPrefixes.some((prefix) => sourceRel.startsWith(prefix))
  );
}

function lowerLabel(label) {
  return String(label).trim().toLocaleLowerCase("en-US");
}

function withoutMarkdownExt(sourceRel) {
  return sourceRel.replace(/\.md$/i, "");
}

function outputRelForSource(sourceRel) {
  return `${withoutMarkdownExt(sourceRel)}.mdx`;
}

function routeForSource(sourceRel) {
  const stem = withoutMarkdownExt(sourceRel);
  if (stem === "index") {
    return "/docs";
  }

  if (stem.endsWith("/index")) {
    return `/docs/${stem.slice(0, -"/index".length)}`;
  }

  return `/docs/${stem}`;
}

function folderForOutput(outputRel) {
  const folder = path.posix.dirname(outputRel);
  return folder === "." ? "" : folder;
}

function pageNameForOutput(outputRel) {
  return path.posix.basename(outputRel, ".mdx");
}

function ensureMeta(folder, title) {
  const existing = metaByFolder.get(folder);
  if (existing) {
    if (title && !existing.title) {
      existing.title = lowerLabel(title);
    }
    return existing;
  }

  const meta = {
    title: lowerLabel(title || (folder ? path.posix.basename(folder) : "docs")),
    pages: [],
    seen: new Set(),
  };

  metaByFolder.set(folder, meta);
  return meta;
}

function addMetaPage(folder, page) {
  const meta = ensureMeta(folder);
  if (meta.seen.has(page)) {
    return;
  }

  meta.pages.push(page);
  meta.seen.add(page);
}

function collectFiles(items, out = []) {
  for (const item of items) {
    if (typeof item === "string") {
      out.push(normalizeSourcePath(item));
      continue;
    }

    const entries = Object.entries(item);
    if (entries.length === 0) {
      continue;
    }

    const [, value] = entries[0];
    if (typeof value === "string") {
      out.push(normalizeSourcePath(value));
    } else if (Array.isArray(value)) {
      collectFiles(value, out);
    }
  }

  return out;
}

function commonDirectory(sourceFiles) {
  const folders = sourceFiles.map((file) => folderForOutput(outputRelForSource(file)));
  if (folders.length === 0) {
    return "";
  }

  const [first, ...rest] = folders.map((folder) => (folder ? folder.split("/") : []));
  const common = [];

  for (let index = 0; index < first.length; index += 1) {
    const segment = first[index];
    if (rest.every((parts) => parts[index] === segment)) {
      common.push(segment);
    } else {
      break;
    }
  }

  return common.join("/");
}

function folderEntryName(parentFolder, childFolder) {
  if (!parentFolder) {
    return childFolder.split("/")[0];
  }

  const relative = path.posix.relative(parentFolder, childFolder);
  return relative.split("/")[0];
}

function includeSource(sourceRel) {
  allowlist.add(sourceRel);
  routeMap.set(sourceRel, routeForSource(sourceRel));

  if (isExcluded(sourceRel) || sourceRel === "index.md") {
    return false;
  }

  includedFiles.add(sourceRel);
  return true;
}

function processFileItem(sourceRel, currentFolder) {
  const normalized = normalizeSourcePath(sourceRel);
  const shouldWrite = includeSource(normalized);
  const outputRel = outputRelForSource(normalized);
  const outputFolder = folderForOutput(outputRel);
  const pageName = pageNameForOutput(outputRel);

  if (normalized === "index.md") {
    addMetaPage("", "index");
    return;
  }

  if (!shouldWrite) {
    return;
  }

  if (outputFolder === currentFolder) {
    addMetaPage(currentFolder, pageName);
  } else {
    addMetaPage(outputFolder, pageName);
  }
}

function processGroup(label, children, currentFolder) {
  const publicFiles = collectFiles(children).filter((file) => !isExcluded(file));
  for (const file of publicFiles) {
    allowlist.add(file);
    routeMap.set(file, routeForSource(file));
  }

  if (publicFiles.length === 0) {
    return;
  }

  const commonFolder = commonDirectory(publicFiles);
  const shouldNest = commonFolder !== currentFolder && commonFolder !== "";

  if (shouldNest) {
    ensureMeta(commonFolder, label);
    addMetaPage(currentFolder, folderEntryName(currentFolder, commonFolder));
    processNavItems(children, commonFolder);
    return;
  }

  addMetaPage(currentFolder, `---${lowerLabel(label)}---`);
  processNavItems(children, currentFolder);
}

function processNavItems(items, currentFolder = "") {
  ensureMeta(currentFolder);

  for (const item of items) {
    if (typeof item === "string") {
      processFileItem(item, currentFolder);
      continue;
    }

    const entries = Object.entries(item);
    if (entries.length === 0) {
      continue;
    }

    const [label, value] = entries[0];
    if (typeof value === "string") {
      processFileItem(value, currentFolder);
    } else if (Array.isArray(value)) {
      processGroup(label, value, currentFolder);
    }
  }
}

function insertApiReferenceLink() {
  const linkEntry = "[api reference](/docs/api)";
  const meta = ensureMeta("api", "api");
  const pages = meta.pages.filter((page) => page !== linkEntry);
  const referenceIndex = pages.indexOf("reference");
  const insertAt = referenceIndex === -1 ? 1 : referenceIndex;

  pages.splice(insertAt, 0, linkEntry);
  meta.pages = pages;
  meta.seen = new Set(pages);
}

function stripMkdocsFrontmatter(markdown) {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") {
    return lines;
  }

  const end = lines.findIndex((line, index) => index > 0 && line === "---");
  if (end === -1) {
    return lines;
  }

  return lines.slice(end + 1);
}

function extractTitle(lines, sourceRel) {
  let inFence = false;
  let fence = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);

    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fence = marker;
      } else if (marker === fence) {
        inFence = false;
      }
      continue;
    }

    if (inFence) {
      continue;
    }

    const titleMatch = line.match(/^#\s+(.+?)\s*(?:\{#[^}]+})?\s*$/);
    if (!titleMatch) {
      continue;
    }

    const title = plainText(titleMatch[1]);
    const body = [...lines.slice(0, index), ...lines.slice(index + 1)];
    while (body[0] === "") {
      body.shift();
    }

    return { title, body };
  }

  warnings.push(`${sourceRel}: no leading h1 found; used file name for title`);
  return {
    title: pathToTitle(withoutMarkdownExt(sourceRel)),
    body: lines,
  };
}

function pathToTitle(stem) {
  const last = stem.split("/").at(-1) || stem;
  return last.replaceAll("-", " ");
}

function plainText(markdown) {
  return markdown
    .replace(/!\[([^\]]*)]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/==([^=]+)==/g, "$1")
    .replace(/^#+\s*/g, "")
    .replace(/^>\s*/g, "")
    .replace(/:([a-z0-9_-]+):/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isLeadDescriptionBoundary(trimmed) {
  return (
    trimmed === "" ||
    trimmed === "---" ||
    /^#{1,6}\s/.test(trimmed) ||
    /^[-*]\s/.test(trimmed) ||
    /^\d+\.\s/.test(trimmed) ||
    /^\|/.test(trimmed) ||
    /^!!!\s/.test(trimmed) ||
    /^\*\*(last updated|status)\*\*:/i.test(trimmed)
  );
}

function extractDescriptionAndBody(lines, title) {
  let inFence = false;
  let fence = "";
  let paragraph = [];
  let paragraphStart = -1;
  let paragraphEnd = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fence = marker;
      } else if (marker === fence) {
        inFence = false;
      }
      continue;
    }

    if (inFence) {
      continue;
    }

    const trimmed = line.trim();
    if (isLeadDescriptionBoundary(trimmed)) {
      if (paragraph.length > 0) {
        paragraphEnd = index;
        break;
      }
      continue;
    }

    if (paragraph.length === 0) {
      paragraphStart = index;
    }
    paragraph.push(trimmed);
  }

  const description = plainText(paragraph.join(" "));
  if (!description || paragraphStart === -1) {
    return { description: title, body: lines };
  }

  if (paragraphEnd === -1) {
    paragraphEnd = lines.length;
  }

  if (paragraphEnd < lines.length && lines[paragraphEnd].trim() === "") {
    paragraphEnd += 1;
  }

  return {
    description,
    body: [...lines.slice(0, paragraphStart), ...lines.slice(paragraphEnd)],
  };
}

function transformOutsideCodeFences(lines, transform) {
  let inFence = false;
  let fence = "";

  return lines.map((line) => {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fence = marker;
      } else if (marker === fence) {
        inFence = false;
      }
      return line;
    }

    if (inFence) {
      return line;
    }

    return transform(line);
  });
}

function transformOutsideInlineCode(line, transform) {
  const parts = line.split(/(`[^`]*`)/g);
  return parts
    .map((part) => (part.startsWith("`") && part.endsWith("`") ? part : transform(part)))
    .join("");
}

function normalizeInlineSyntax(lines) {
  return transformOutsideCodeFences(lines, (line) => {
    return transformOutsideInlineCode(line, (segment) => {
      let next = segment
        .replace(/\{#[^}]+}\s*$/g, "")
        .replace(/\{\s*\.[^}]+}\s*/g, " ");

      next = next.replace(/<([^>\n]+)>/g, (match, body) => {
        const trimmed = body.trim();
        if (/^https?:\/\//i.test(trimmed)) {
          return `[${trimmed}](${trimmed})`;
        }

        const tagName = body.split(/\s+/)[0].replace(/^\//, "").toLocaleLowerCase("en-US");
        if (["kbd", "mark", "br", "sub", "sup"].includes(tagName)) {
          return match;
        }

        return `&lt;${body}&gt;`;
      });

      return next
        .replace(/</g, "&lt;")
        .replace(/\+\+([A-Za-z0-9_+-]+(?:\+[A-Za-z0-9_+-]+)*)\+\+/g, (_, keys) =>
          keys
            .split("+")
            .filter(Boolean)
            .map((key) => `<kbd>${key}</kbd>`)
            .join(" + "),
        )
        .replace(/==([^=\n]+)==/g, "<mark>$1</mark>");
    });
  });
}

function normalizeFenceLanguages(lines) {
  return lines.map((line) => line.replace(/^(\s*```+)\s*env(\s.*)?$/i, "$1dotenv$2"));
}

function rewriteLinks(lines, sourceRel) {
  const sourceFolder = path.posix.dirname(sourceRel) === "." ? "" : path.posix.dirname(sourceRel);
  const linkPattern = /\]\(([^)\s]+\.md(?:#[^)]+)?)(?:\s+"[^"]*")?\)/g;

  return transformOutsideCodeFences(lines, (line) =>
    line.replace(linkPattern, (match, href) => {
      const [targetPath, hash] = href.split("#");
      const normalizedTarget = normalizeSourcePath(path.posix.join(sourceFolder, targetPath));

      if (!routeMap.has(normalizedTarget)) {
        warnings.push(`${sourceRel}: left unmapped doc link ${href}`);
        return match;
      }

      const route = routeMap.get(normalizedTarget);
      return `](${route}${hash ? `#${hash}` : ""})`;
    }),
  );
}

function transformAdmonitionsAndTabs(lines, sourceRel) {
  const out = [];
  let index = 0;
  let inFence = false;
  let fence = "";

  while (index < lines.length) {
    const line = lines[index];
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fence = marker;
        if (line.trim().startsWith("```mermaid")) {
          mermaidFiles.set(sourceRel, (mermaidFiles.get(sourceRel) || 0) + 1);
        }
      } else if (marker === fence) {
        inFence = false;
      }
      out.push(line);
      index += 1;
      continue;
    }

    if (inFence) {
      out.push(line);
      index += 1;
      continue;
    }

    const admonition = line.match(/^!!!\s+([A-Za-z_-]+)(?:\s+"([^"]+)")?\s*$/);
    if (admonition) {
      const [, rawType, rawTitle] = admonition;
      const type = calloutTypeMap.get(rawType.toLocaleLowerCase("en-US")) || "info";
      const title = rawTitle || undefined;
      const body = [];
      index += 1;

      while (index < lines.length) {
        const bodyLine = lines[index];
        if (bodyLine.trim() === "") {
          body.push("");
          index += 1;
          continue;
        }

        if (/^(?: {4}|\t)/.test(bodyLine)) {
          body.push(bodyLine.replace(/^(?: {4}|\t)/, ""));
          index += 1;
          continue;
        }

        break;
      }

      out.push(title ? `<Callout type="${type}" title={${JSON.stringify(title)}}>` : `<Callout type="${type}">`);
      out.push("");
      out.push(...trimBlankEdges(body));
      out.push("");
      out.push("</Callout>");
      continue;
    }

    const tab = line.match(/^===\s+"([^"]+)"\s*$/);
    if (tab) {
      const tabs = [];

      while (index < lines.length) {
        const tabLine = lines[index];
        const tabHeader = tabLine.match(/^===\s+"([^"]+)"\s*$/);
        if (!tabHeader) {
          break;
        }

        index += 1;
        const body = [];
        while (index < lines.length) {
          const bodyLine = lines[index];
          if (/^===\s+"([^"]+)"\s*$/.test(bodyLine)) {
            break;
          }

          if (bodyLine.trim() === "") {
            body.push("");
            index += 1;
            continue;
          }

          if (/^(?: {4}|\t)/.test(bodyLine)) {
            body.push(bodyLine.replace(/^(?: {4}|\t)/, ""));
            index += 1;
            continue;
          }

          break;
        }

        tabs.push({ label: tabHeader[1], body: trimBlankEdges(body) });
      }

      if (tabs.length === 0) {
        warnings.push(`${sourceRel}: found an empty pymdownx tab block`);
        continue;
      }

      out.push(`<Tabs items={${JSON.stringify(tabs.map((item) => item.label))}}>`);
      for (const item of tabs) {
        out.push("");
        out.push(`<Tab value={${JSON.stringify(item.label)}}>`);
        out.push("");
        out.push(...item.body);
        out.push("");
        out.push("</Tab>");
      }
      out.push("");
      out.push("</Tabs>");
      continue;
    }

    out.push(line);
    index += 1;
  }

  return out;
}

function trimBlankEdges(lines) {
  const out = [...lines];
  while (out[0] === "") {
    out.shift();
  }
  while (out.at(-1) === "") {
    out.pop();
  }
  return out;
}

function frontmatterValue(value) {
  return JSON.stringify(value.replace(/\s+/g, " ").trim());
}

function convertMarkdown(markdown, sourceRel) {
  const stripped = stripMkdocsFrontmatter(markdown);
  const { title, body } = extractTitle(stripped, sourceRel);
  const { description, body: bodyWithoutDescription } = extractDescriptionAndBody(body, title);
  let lines = normalizeFenceLanguages(bodyWithoutDescription);
  lines = normalizeInlineSyntax(lines);
  lines = rewriteLinks(lines, sourceRel);
  lines = transformAdmonitionsAndTabs(lines, sourceRel);

  const content = trimBlankEdges(lines).join("\n");

  return [
    "---",
    `title: ${frontmatterValue(title)}`,
    `description: ${frontmatterValue(description)}`,
    "---",
    "",
    content,
    "",
  ].join("\n");
}

function countBySection(outputRel) {
  const parts = outputRel.split("/");
  return parts.length === 1 ? "root" : parts[0];
}

async function assertInside(parent, child) {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  const relative = path.relative(resolvedParent, resolvedChild);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`refusing to operate outside ${resolvedParent}: ${resolvedChild}`);
  }
}

async function cleanTarget() {
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.access(targetRootIndex);
  await assertInside(webRoot, targetRoot);

  const entries = await fs.readdir(targetRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "index.mdx") {
      continue;
    }

    const target = path.join(targetRoot, entry.name);
    await assertInside(targetRoot, target);
    await fs.rm(target, { recursive: true, force: true });
  }
}

async function writeGeneratedFiles() {
  const counts = new Map();
  const sortedFiles = Array.from(includedFiles).sort((a, b) => a.localeCompare(b));

  for (const sourceRel of sortedFiles) {
    const sourcePath = path.join(sourceRoot, toPosix(sourceRel));
    const outputRel = outputRelForSource(sourceRel);

    if (outputRel === "api/index.mdx") {
      throw new Error("refusing to create api/index.mdx because /docs/api is Scalar");
    }

    const outputPath = path.join(targetRoot, toPosix(outputRel));
    await assertInside(sourceRoot, sourcePath);
    await assertInside(targetRoot, outputPath);

    const markdown = await fs.readFile(sourcePath, "utf8");
    const mdx = convertMarkdown(markdown, sourceRel);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, mdx, "utf8");

    const section = countBySection(outputRel);
    counts.set(section, (counts.get(section) || 0) + 1);
  }

  return counts;
}

async function writeMetaFiles() {
  const entries = Array.from(metaByFolder.entries()).sort(([a], [b]) => a.localeCompare(b));

  for (const [folder, meta] of entries) {
    const metaPath = path.join(targetRoot, toPosix(folder), "meta.json");
    await assertInside(targetRoot, metaPath);
    await fs.mkdir(path.dirname(metaPath), { recursive: true });
    const payload = {
      title: meta.title,
      pages: meta.pages,
    };
    await fs.writeFile(metaPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}

async function main() {
  const mkdocsPath = path.join(repoRoot, "mkdocs.yml");
  const mkdocsSource = (await fs.readFile(mkdocsPath, "utf8")).replace(
    /!!python\/name:[^\s]+/g,
    '"__mkdocs_python_name__"',
  );
  const mkdocs = yaml.load(mkdocsSource);
  if (!mkdocs || !Array.isArray(mkdocs.nav)) {
    throw new Error("mkdocs.yml does not contain a nav array");
  }

  routeMap.set("index.md", "/docs");
  processNavItems(mkdocs.nav);
  insertApiReferenceLink();

  await cleanTarget();
  const counts = await writeGeneratedFiles();
  await writeMetaFiles();

  const total = Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
  console.log(`migrated ${total} pages`);
  for (const [section, count] of Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`- ${section}: ${count}`);
  }

  if (mermaidFiles.size > 0) {
    console.log("mermaid fences retained for renderer follow-up:");
    for (const [file, count] of Array.from(mermaidFiles.entries()).sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`- ${file}: ${count}`);
    }
  }

  if (warnings.length > 0) {
    console.log("warnings:");
    for (const warning of Array.from(new Set(warnings)).sort((a, b) => a.localeCompare(b))) {
      console.log(`- ${warning}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
