#!/usr/bin/env node
/**
 * scan-firestore-writes — wave 1.1 ast scanner for security-boundary-migration.
 *
 * Walks `web/**\/*.{ts,tsx}` looking for any direct firestore *client* write
 * call (`firebase/firestore` import; not `firebase-admin/firestore`):
 *   - named function: setDoc, updateDoc, deleteDoc, addDoc, writeBatch,
 *     runTransaction, arrayUnion, arrayRemove
 *   - method-style on doc/collection refs: .set(), .update(), .delete(),
 *     .add() (incl. transaction.update / batch.delete patterns)
 *
 * Emits a structured report:
 *   { file, line, firestorePath, callType, surroundingFunction,
 *     classification: 'preference' | 'control_plane' | 'no_action',
 *     capability?: <Capability enum value>, route?: <canonical api route> }[]
 *
 * Outputs:
 *   - JSON to stdout (or to file with --json=path)
 *   - Markdown to dev/active/security-boundary-migration/reference/write-inventory.md
 *
 * Usage:
 *   npm run scan:firestore-writes
 *   node scripts/scan-firestore-writes.mjs
 *   node scripts/scan-firestore-writes.mjs --json=hits.json --no-md
 *
 * AST parser choice: typescript programmatic api (already a dev dep in
 * web/package.json). ts-morph is not installed and adding it would expand the
 * dep surface for a one-shot tool. tsc-ast is sufficient for the patterns we
 * need to recognise.
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WEB_DIR = join(ROOT, 'web');
const REPORT_DIR = join(ROOT, 'dev', 'active', 'security-boundary-migration', 'reference');
const REPORT_PATH = join(REPORT_DIR, 'write-inventory.md');

// resolve the typescript module from web/node_modules — that's where it lives
// (root has no package.json, web is the only node project that consumes tsc).
const requireFromWeb = createRequire(pathToFileURL(join(WEB_DIR, 'package.json')).href);
let ts;
try {
  ts = requireFromWeb('typescript');
} catch (err) {
  console.error('[scan-firestore-writes] failed to load typescript from web/node_modules.');
  console.error('  run `cd web && npm install` first.');
  console.error('  underlying error:', err.message);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
let writeMd = true;
let jsonOutPath = null;
for (const a of argv) {
  if (a === '--no-md') writeMd = false;
  else if (a.startsWith('--json=')) jsonOutPath = a.slice('--json='.length);
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------
const WRITE_FN_NAMES = new Set([
  'setDoc',
  'updateDoc',
  'deleteDoc',
  'addDoc',
  'writeBatch',
  'runTransaction',
  'arrayUnion',
  'arrayRemove',
]);

// method names triggered on doc/collection/transaction/batch refs
const WRITE_METHOD_NAMES = new Set(['set', 'update', 'delete', 'add']);

// directories under web/ to skip
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'out',
  'build',
  'dist',
  '.turbo',
  '.cache',
  'coverage',
]);

const INCLUDE_EXT = new Set(['.ts', '.tsx']);

// ---------------------------------------------------------------------------
// classification rules
// ---------------------------------------------------------------------------
//
// preference allowlist: writes that may stay client-side after lockdown.
// scoped to per-user preference paths only — every other path must migrate.
// each entry is matched against the *firestorePath* we infer from the
// enclosing doc(...) call. we intentionally only allowlist user-self-prefs.
const PREFERENCE_ALLOWLIST = [
  {
    // device prefs (per-user theme/timezone/etc.) — useDevicePrefs.ts
    firestorePathPattern: /^users\/[^/]+\/devicePrefs\/global$/,
    rationale: 'per-user device preferences (theme, timezone, alert mute) — user-self only',
  },
  {
    // user document preferences-only writes (preferences subkey, lastSiteId,
    // lastMachineIds). these are merged into users/{uid} but only update
    // user-self prefs fields. AuthContext.tsx writes to users/{uid} for both
    // creation (control-plane: USER_ROLE_MANAGE) and prefs (allowlisted) — we
    // disambiguate by surrounding function below.
    firestorePathPattern: /^users\/[^/]+$/,
    surroundingFunctionPattern: /^(updateUserPreferences|updateLastSite|updateLastMachine)$/,
    rationale: 'user-self preferences merge (preferences, lastSiteId, lastMachineIds)',
  },
  {
    // cortex chat history — per-user owned by the chat author. lives outside
    // the security-boundary lockdown scope; chat data is bounded by user uid
    // in firestore rules and is not a control-plane action.
    firestorePathPattern: /^chats\/[^/]+$/,
    rationale: 'per-user cortex chat history — user-owned, no control-plane impact',
  },
];

// classification map: surroundingFunction (or file+function) → capability + route.
// matched in order; first match wins. routes are canonical targets per plan
// wave 3 spec; for wave-3 task assignments see route-audit (wave 3.0).
const CONTROL_PLANE_RULES = [
  // ---- useDisplayActions.ts ----
  {
    file: /^web\/hooks\/useDisplayActions\.ts$/,
    fn: /^(captureLayout|setAutoRestore|resetAutoRestoreBreaker)$/,
    capability: 'MACHINE_CONFIG_WRITE',
    route: 'PUT /api/sites/{siteId}/machines/{machineId}/display-layout',
  },
  {
    file: /^web\/hooks\/useDisplayActions\.ts$/,
    fn: /^clearLayout$/,
    capability: 'MACHINE_CONFIG_WRITE',
    route: 'DELETE /api/sites/{siteId}/machines/{machineId}/display-layout',
  },
  {
    file: /^web\/hooks\/useDisplayActions\.ts$/,
    fn: /^(dispatchTopologyCommand|applyLayout|ackLayout|enumerateDisplayModes|testDisplayApply)$/,
    capability: 'MACHINE_EXEC_COMMAND',
    route: 'POST /api/sites/{siteId}/machines/{machineId}/commands',
  },

  // ---- useFirestore.ts ----
  {
    file: /^web\/hooks\/useFirestore\.ts$/,
    fn: /^(createSite|updateSite|deleteSite)$/,
    capability: 'SITE_MEMBER_MANAGE',
    route: 'POST|PATCH|DELETE /api/sites/{siteId}',
  },
  {
    file: /^web\/hooks\/useFirestore\.ts$/,
    fn: /^(killProcess|sendMachineCommand|rebootMachine|shutdownMachine|cancelReboot|dismissRebootPending|captureScreenshot|startLiveView|stopLiveView)$/,
    capability: 'MACHINE_EXEC_COMMAND',
    route: 'POST /api/sites/{siteId}/machines/{machineId}/commands',
  },
  {
    file: /^web\/hooks\/useFirestore\.ts$/,
    fn: /^setLaunchMode$/,
    capability: 'MACHINE_CONFIG_WRITE',
    route: 'PATCH /api/sites/{siteId}/machines/{machineId}/processes/{processId}/launch-mode',
  },
  {
    file: /^web\/hooks\/useFirestore\.ts$/,
    fn: /^(updateProcess|deleteProcess|createProcess)$/,
    capability: 'MACHINE_CONFIG_WRITE',
    route: 'POST|PATCH|DELETE /api/sites/{siteId}/machines/{machineId}/processes[/{processId}]',
  },
  {
    file: /^web\/hooks\/useFirestore\.ts$/,
    fn: /^updateRebootSchedule$/,
    capability: 'MACHINE_CONFIG_WRITE',
    route: 'PUT /api/sites/{siteId}/machines/{machineId}/reboot-schedule',
  },

  // ---- useDeployments.ts ----
  {
    // installer-template crud (sites/{siteId}/installer_templates/{id}) —
    // reusable deployment templates, classified as PRESET_MANAGE per plan.
    file: /^web\/hooks\/useDeployments\.ts$/,
    fn: /^(createTemplate|updateTemplate|deleteTemplate|createDeploymentTemplate|updateDeploymentTemplate|deleteDeploymentTemplate|saveTemplate|upsertTemplate)$/,
    capability: 'PRESET_MANAGE',
    route: 'POST|PATCH|DELETE /api/sites/{siteId}/presets/deployment-template[/{templateId}]',
  },
  {
    file: /^web\/hooks\/useDeployments\.ts$/,
    capability: 'DEPLOYMENT_MANAGE',
    route: 'POST|DELETE /api/sites/{siteId}/deployments[/{deploymentId}/cancel]',
  },

  // ---- useProjectDistributions.ts ----
  {
    file: /^web\/hooks\/useProjectDistributions\.ts$/,
    capability: 'DISTRIBUTION_MANAGE',
    route: 'POST|DELETE /api/sites/{siteId}/project-distributions[/{distId}/cancel]',
  },

  // ---- useUninstall.ts ----
  {
    file: /^web\/hooks\/useUninstall\.ts$/,
    capability: 'UNINSTALL_TRIGGER',
    route: 'POST|DELETE /api/sites/{siteId}/machines/{machineId}/uninstall',
  },

  // ---- useMachineOperations.ts ----
  {
    file: /^web\/hooks\/useMachineOperations\.ts$/,
    capability: 'MACHINE_REMOVE',
    route: 'DELETE /api/sites/{siteId}/machines/{machineId}',
  },

  // ---- useUserManagement.ts ----
  {
    file: /^web\/hooks\/useUserManagement\.ts$/,
    fn: /^(promoteToAdmin|demoteToMember|changeRole|updateUserRole)$/,
    capability: 'USER_ROLE_MANAGE',
    route: 'PATCH /api/admin/users/{userId}/role',
  },
  {
    file: /^web\/hooks\/useUserManagement\.ts$/,
    fn: /^(assignSites|removeSites|grantSiteAccess|revokeSiteAccess|addUserToSite|removeUserFromSite|assignSiteToUser|removeSiteFromUser)$/,
    capability: 'SITE_MEMBER_MANAGE',
    route: 'POST|DELETE /api/admin/users/{userId}/site-assignments',
  },
  {
    file: /^web\/hooks\/useUserManagement\.ts$/,
    fn: /^(deleteUser|removeUser)$/,
    capability: 'USER_DELETE',
    route: 'DELETE /api/admin/users/{userId}',
  },

  // ---- useSchedulePresets.ts / useRebootPresets.ts / useProjectDistributionPresets.ts ----
  {
    file: /^web\/hooks\/useSchedulePresets\.ts$/,
    capability: 'PRESET_MANAGE',
    route: 'POST|PATCH|DELETE /api/sites/{siteId}/presets/schedule[/{presetId}]',
  },
  {
    file: /^web\/hooks\/useRebootPresets\.ts$/,
    capability: 'PRESET_MANAGE',
    route: 'POST|PATCH|DELETE /api/sites/{siteId}/presets/reboot[/{presetId}]',
  },
  {
    file: /^web\/hooks\/useProjectDistributionPresets\.ts$/,
    capability: 'PRESET_MANAGE',
    route: 'POST|PATCH|DELETE /api/sites/{siteId}/presets/distribution[/{presetId}]',
  },

  // ---- useSystemPresets.ts ----
  {
    file: /^web\/hooks\/useSystemPresets\.ts$/,
    capability: 'SYSTEM_PRESET_MANAGE',
    route: 'POST|PATCH|DELETE /api/admin/system-presets[/{presetId}]',
  },

  // ---- useInstallerManagement.ts ----
  {
    file: /^web\/hooks\/useInstallerManagement\.ts$/,
    capability: 'INSTALLER_MANAGE',
    route: 'POST|DELETE /api/admin/installers[/{version}|/set-latest]',
  },

  // ---- useCortex.ts ----
  // chat history is per-user data, allowlisted as preference (see PREFERENCE_ALLOWLIST).
  // any non-chat write here would be control-plane — none currently exist.

  // ---- WebhookSettingsDialog.tsx ----
  {
    file: /^web\/components\/WebhookSettingsDialog\.tsx$/,
    capability: 'WEBHOOK_MANAGE',
    route: 'POST|PATCH|DELETE /api/sites/{siteId}/webhooks[/{webhookId}]',
  },

  // ---- admin/alerts/page.tsx ----
  {
    file: /^web\/app\/admin\/alerts\/page\.tsx$/,
    capability: 'GLOBAL_SETTINGS_WRITE',
    route: 'PUT /api/admin/alerts',
  },

  // ---- CortexPowerToggle.tsx ----
  {
    file: /^web\/app\/cortex\/components\/CortexPowerToggle\.tsx$/,
    capability: 'MACHINE_CONFIG_WRITE',
    route: 'PATCH /api/sites/{siteId}/machines/{machineId}/cortex-enabled',
  },

  // ---- logs/page.tsx ----
  {
    file: /^web\/app\/logs\/page\.tsx$/,
    capability: 'GLOBAL_SETTINGS_WRITE',
    route: 'DELETE /api/sites/{siteId}/logs',
  },

  // ---- web/lib/firebase.ts ----
  {
    file: /^web\/lib\/firebase\.ts$/,
    fn: /^sendOwletteUpdateCommand$/,
    capability: 'MACHINE_EXEC_COMMAND',
    route: 'POST /api/sites/{siteId}/machines/{machineId}/commands',
  },

  // ---- AuthContext.tsx (non-allowlisted writes) ----
  {
    file: /^web\/contexts\/AuthContext\.tsx$/,
    fn: /^(deleteAccount|deleteUser|deleteCurrentUser)$/,
    capability: 'USER_SELF_DELETE',
    route: 'DELETE /api/users/me',
  },
  {
    // user-doc creation on signup/sign-in (sets role + sites + mfa fields).
    // these are control-plane (USER_ROLE_MANAGE) — should be a server-side
    // bootstrap rather than a client setDoc once rules lock down. matches
    // both the signup useCallback and the listener-driven creation path
    // (the onAuthStateChanged callback is bound to `unsubscribe`).
    file: /^web\/contexts\/AuthContext\.tsx$/,
    fn: /^(signup|signUp|AuthProvider|unsubscribe)$/,
    capability: 'USER_ROLE_MANAGE',
    route: 'POST /api/users/bootstrap',
  },
];

// ---------------------------------------------------------------------------
// file walk
// ---------------------------------------------------------------------------
function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (st.isFile()) {
      const dot = name.lastIndexOf('.');
      if (dot < 0) continue;
      const ext = name.slice(dot);
      if (INCLUDE_EXT.has(ext)) yield full;
    }
  }
}

// ---------------------------------------------------------------------------
// per-file ast scan
// ---------------------------------------------------------------------------
function scanFile(absPath) {
  const source = readFileSync(absPath, 'utf8');

  // fast skip: only files that import from 'firebase/firestore' can have
  // firestore client writes. admin SDK imports come from 'firebase-admin/*'.
  if (!/from\s+['"]firebase\/firestore['"]/.test(source)) return [];

  const sf = ts.createSourceFile(
    absPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  // (1) collect named imports from 'firebase/firestore'. captures local
  //     binding names so we recognise aliased imports like
  //     `import { setDoc as fsSet } from 'firebase/firestore'`.
  // bindingName (local) -> originalName (firestore export)
  const firestoreBindings = new Map();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const mod = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(mod)) continue;
    if (mod.text !== 'firebase/firestore') continue;
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        const original = el.propertyName ? el.propertyName.text : el.name.text;
        firestoreBindings.set(el.name.text, original);
      }
    }
  }

  // bail if no write-related imports — read-only files (onSnapshot, getDoc,
  // collection, doc) don't trigger any write hits.
  const importsAnyWrite = [...firestoreBindings.values()].some((n) => WRITE_FN_NAMES.has(n));
  // we still need to scan for method-style writes (.set/.update/.delete/.add)
  // even when only `doc`/`collection` is imported, because those return a ref
  // that batch.delete(ref) consumes. method-style hits require a writeBatch
  // call in scope OR a runTransaction call — both of which use the named
  // import. so if `writeBatch` and `runTransaction` aren't imported and no
  // named-write is imported either, nothing can write here.
  if (!importsAnyWrite) return [];

  // (2) walk ast collecting hits.
  const hits = [];
  const fnStack = []; // function-name stack for surroundingFunction inference

  function lineNumber(pos) {
    const lc = sf.getLineAndCharacterOfPosition(pos);
    return lc.line + 1;
  }

  // try to extract the firestore path from a `doc(db, 'sites', siteId, ...)`
  // or `collection(db, 'sites', siteId, ...)` call. argument literals are
  // emitted verbatim; identifiers and template parts emit `{name}` so the
  // result reads like a path template.
  function extractPathFromRefCall(node) {
    if (!ts.isCallExpression(node)) return null;
    const callee = node.expression;
    let calleeName = null;
    if (ts.isIdentifier(callee)) calleeName = callee.text;
    else if (ts.isPropertyAccessExpression(callee)) calleeName = callee.name.text;
    if (calleeName !== 'doc' && calleeName !== 'collection') return null;

    // skip the first arg (db) and any arg that's clearly the db handle, then
    // join string literals and identifiers into a slash path.
    const parts = [];
    let firstSkipped = false;
    for (const arg of node.arguments) {
      // first arg is conventionally the db handle (Firestore instance);
      // older overloads accept a parent ref as first arg too — we still want
      // to skip it to keep paths starting from a string literal.
      if (!firstSkipped) {
        firstSkipped = true;
        // if it's a string literal, the user used the no-db overload —
        // keep it.
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
          parts.push(arg.text);
        }
        continue;
      }
      if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
        parts.push(arg.text);
      } else if (ts.isIdentifier(arg)) {
        parts.push(`{${arg.text}}`);
      } else if (ts.isPropertyAccessExpression(arg)) {
        parts.push(`{${arg.getText(sf)}}`);
      } else if (ts.isTemplateExpression(arg) || ts.isTemplateLiteral(arg)) {
        // approximate template literal as its raw text minus backticks
        parts.push(arg.getText(sf).replace(/^`|`$/g, '').replace(/\$\{[^}]+\}/g, (m) => m));
      } else {
        parts.push(`{${kindName(arg.kind)}}`);
      }
    }
    return parts.join('/');
  }

  // resolve a ref expression to a firestore path, by chasing identifier
  // assignments inside the same source file. handles:
  //   const ref = doc(db, 'sites', siteId, ...);
  //   await setDoc(ref, ...)
  // returns null if we can't determine.
  function resolveRefToPath(expr) {
    if (!expr) return null;
    if (ts.isCallExpression(expr)) {
      const p = extractPathFromRefCall(expr);
      if (p) return p;
    }
    if (ts.isIdentifier(expr)) {
      const def = findVariableInitializer(expr.text);
      if (def) {
        if (ts.isCallExpression(def)) {
          const p = extractPathFromRefCall(def);
          if (p) return p;
        }
      }
    }
    return null;
  }

  function findVariableInitializer(name) {
    let result = null;
    function visit(node) {
      if (result) return;
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer
      ) {
        result = node.initializer;
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
    return result;
  }

  function kindName(k) {
    return ts.SyntaxKind[k] || `kind_${k}`;
  }

  // figure out function-name for the call, climbing fnStack first then any
  // enclosing variable declaration / property assignment.
  function surroundingFunctionName() {
    for (let i = fnStack.length - 1; i >= 0; i--) {
      if (fnStack[i]) return fnStack[i];
    }
    return null;
  }

  function pushFn(name) {
    fnStack.push(name || null);
  }
  function popFn() {
    fnStack.pop();
  }

  function nameOfFunctionLike(node) {
    // function declaration: function foo() {}
    if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
    // method: foo() {}
    if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      return node.name.text;
    }
    // property assignment / variable assignment, walking through hooks like
    // useCallback / useMemo / useEffect that wrap the arrow function:
    //   const foo = () => {}
    //   const foo = useCallback(() => {}, [...])
    //   const foo = useMemo(() => {}, [...])
    let parent = node.parent;
    // climb up through enclosing CallExpressions (useCallback, useMemo, etc.)
    // until we hit something that names the binding.
    while (parent) {
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
      }
      if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
      }
      if (ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) {
        return parent.name.text;
      }
      // call expression wrapper (useCallback / useMemo / etc.) — keep climbing
      // toward the variable declaration that holds the call. break out the
      // moment the parent stops being either a CallExpression argument or a
      // VariableDeclaration initializer chain we care about.
      if (ts.isCallExpression(parent) || ts.isParenthesizedExpression(parent)) {
        parent = parent.parent;
        continue;
      }
      // anything else: give up — we've left the assignment chain.
      break;
    }
    return null;
  }

  function visit(node) {
    let pushed = false;
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      pushFn(nameOfFunctionLike(node));
      pushed = true;
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;

      // (a) named-import write: setDoc(ref, ...) etc.
      if (ts.isIdentifier(callee)) {
        const local = callee.text;
        const original = firestoreBindings.get(local);
        if (original && WRITE_FN_NAMES.has(original)) {
          let firestorePath = null;
          if (
            (original === 'setDoc' ||
              original === 'updateDoc' ||
              original === 'deleteDoc' ||
              original === 'addDoc') &&
            node.arguments.length > 0
          ) {
            firestorePath = resolveRefToPath(node.arguments[0]);
          }
          // arrayUnion/arrayRemove/writeBatch/runTransaction don't take a ref
          // as their first arg; we leave firestorePath null and rely on the
          // surrounding function for context.
          hits.push({
            line: lineNumber(node.getStart(sf)),
            firestorePath,
            callType: original,
            surroundingFunction: surroundingFunctionName(),
          });
        }
      }

      // (b) method-style on a ref: ref.set(...), batch.delete(ref),
      //     transaction.update(ref, ...), batch.add(...). we treat any
      //     property-access call whose method name matches WRITE_METHOD_NAMES
      //     as a write — but only inside a file that imports a write fn from
      //     firestore (already filtered above). this catches transaction.update
      //     and batch.delete in useFirestore.ts and useMachineOperations.ts.
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
        const methodName = callee.name.text;
        if (WRITE_METHOD_NAMES.has(methodName)) {
          // attempt to resolve ref from first arg (batch.delete(ref)) or
          // from the property-access object itself (ref.set(data)).
          let firestorePath = null;
          if (node.arguments.length > 0) {
            firestorePath = resolveRefToPath(node.arguments[0]);
          }
          if (!firestorePath) {
            firestorePath = resolveRefToPath(callee.expression);
          }
          // skip obvious false positives — if the call is on something
          // unrelated to firestore. heuristic: receiver must be one of
          // {batch, transaction, tx, commandRef, ref, configRef, ...} or the
          // arg must look like a doc/collection ref. we accept the hit when
          // we resolved a path OR the receiver is named like a firestore
          // batch/transaction. otherwise skip.
          const receiverText = callee.expression.getText(sf);
          const receiverIsLikelyFirestore =
            firestorePath !== null ||
            /^(batch|transaction|tx)$/.test(receiverText) ||
            /Ref$/.test(receiverText) ||
            /^doc\(/.test(receiverText) ||
            /^collection\(/.test(receiverText);
          if (receiverIsLikelyFirestore) {
            hits.push({
              line: lineNumber(node.getStart(sf)),
              firestorePath,
              callType: `${receiverText}.${methodName}`,
              surroundingFunction: surroundingFunctionName(),
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);

    if (pushed) popFn();
  }

  visit(sf);
  return hits;
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------
function classifyHit(hit, relPath) {
  // (1) preference allowlist takes precedence.
  for (const rule of PREFERENCE_ALLOWLIST) {
    if (!hit.firestorePath) continue;
    if (!rule.firestorePathPattern.test(hit.firestorePath)) continue;
    if (rule.surroundingFunctionPattern) {
      if (!hit.surroundingFunction) continue;
      if (!rule.surroundingFunctionPattern.test(hit.surroundingFunction)) continue;
    }
    return {
      classification: 'preference',
      rationale: rule.rationale,
    };
  }

  // (2) helper-only writes — `arrayUnion` and `arrayRemove` are *operands*
  //     inside a parent updateDoc call. they'll be reported alongside the
  //     parent updateDoc, so we don't emit a separate denial path; mark as
  //     'no_action' (helper-call, parent already classified).
  if (hit.callType === 'arrayUnion' || hit.callType === 'arrayRemove') {
    return {
      classification: 'no_action',
      rationale: 'array helper passed as updateDoc operand — parent updateDoc carries the classification',
    };
  }

  // (3) writeBatch / runTransaction by themselves are not writes — the writes
  //     happen via the returned batch/tx methods. the methods are caught by
  //     the .set/.update/.delete/.add scan above. mark as 'no_action'.
  if (hit.callType === 'writeBatch' || hit.callType === 'runTransaction') {
    return {
      classification: 'no_action',
      rationale: 'opens batch/transaction; actual writes scanned via method-style .set/.update/.delete',
    };
  }

  // (4) control-plane rules — match by file + (optional) function regex.
  // relPath is normalised to forward-slashes upstream; no leading slash.
  for (const rule of CONTROL_PLANE_RULES) {
    if (rule.file && !rule.file.test(relPath)) continue;
    if (rule.fn) {
      if (!hit.surroundingFunction) continue;
      if (!rule.fn.test(hit.surroundingFunction)) continue;
    }
    return {
      classification: 'control_plane',
      capability: rule.capability,
      route: rule.route,
    };
  }

  // (5) anything left over is unclassified — fail loud so triage cannot be
  //     silently skipped. the success criteria require zero unclear hits.
  return { classification: 'unclear' };
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
const allHits = [];
for (const file of walk(WEB_DIR)) {
  // skip __tests__ — denial tests / mocks reference firestore writes for
  // assertion purposes, not runtime control-plane writes. however, mocks in
  // __mocks__ need to be excluded explicitly too.
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  if (rel.startsWith('web/__tests__/')) continue;
  if (rel.startsWith('web/__mocks__/')) continue;
  if (rel.startsWith('web/lib/__tests__/')) continue;
  if (rel.startsWith('web/e2e/')) continue;

  const fileHits = scanFile(file);
  for (const h of fileHits) {
    const cls = classifyHit(h, rel);
    allHits.push({
      file: rel,
      line: h.line,
      firestorePath: h.firestorePath,
      callType: h.callType,
      surroundingFunction: h.surroundingFunction,
      ...cls,
    });
  }
}

// stable sort: file asc, line asc
allHits.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

// ---------------------------------------------------------------------------
// summarise
// ---------------------------------------------------------------------------
const counts = {
  preference: 0,
  control_plane: 0,
  no_action: 0,
  unclear: 0,
};
for (const h of allHits) counts[h.classification]++;

const byCapability = {};
for (const h of allHits) {
  if (h.classification !== 'control_plane') continue;
  const k = h.capability || 'UNASSIGNED';
  byCapability[k] = (byCapability[k] || 0) + 1;
}

// ---------------------------------------------------------------------------
// emit json
// ---------------------------------------------------------------------------
const jsonReport = {
  generatedAt: new Date().toISOString(),
  totals: { ...counts, total: allHits.length },
  byCapability,
  hits: allHits,
};

if (jsonOutPath) {
  writeFileSync(jsonOutPath, JSON.stringify(jsonReport, null, 2));
} else {
  process.stdout.write(JSON.stringify(jsonReport, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// emit markdown
// ---------------------------------------------------------------------------
if (writeMd) {
  if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
  const md = renderMarkdown(jsonReport);
  writeFileSync(REPORT_PATH, md);
  // use stderr so json on stdout stays clean for piping.
  process.stderr.write(`[scan-firestore-writes] wrote ${REPORT_PATH}\n`);
}

// nonzero exit when unclear hits remain — per success criteria, all entries
// must be triaged. ci uses this to enforce.
process.exit(counts.unclear > 0 ? 1 : 0);

// ---------------------------------------------------------------------------
// markdown rendering
// ---------------------------------------------------------------------------
function renderMarkdown(report) {
  const lines = [];
  lines.push('# firestore client-write inventory');
  lines.push('');
  lines.push(`generated: ${report.generatedAt}`);
  lines.push('source: `scripts/scan-firestore-writes.mjs`');
  lines.push('regenerate: `npm run scan:firestore-writes`');
  lines.push('');
  lines.push(
    'ast-based scan of `web/**/*.{ts,tsx}` for direct firestore *client* (`firebase/firestore`) write calls. excludes `__tests__/`, `__mocks__/`, `e2e/`. server-side admin sdk (`firebase-admin/firestore`) writes are out of scope — those run in trusted server context.',
  );
  lines.push('');
  lines.push('## totals');
  lines.push('');
  lines.push(`- total hits: **${report.totals.total}**`);
  lines.push(`- preference (allowlist): **${report.totals.preference}**`);
  lines.push(`- control-plane (must migrate): **${report.totals.control_plane}**`);
  lines.push(`- no-action (helper / batch open): **${report.totals.no_action}**`);
  lines.push(`- unclear (triage): **${report.totals.unclear}**`);
  lines.push('');
  if (Object.keys(report.byCapability).length > 0) {
    lines.push('## control-plane hits by capability');
    lines.push('');
    lines.push('| capability | count |');
    lines.push('| --- | --- |');
    for (const k of Object.keys(report.byCapability).sort()) {
      lines.push(`| \`${k}\` | ${report.byCapability[k]} |`);
    }
    lines.push('');
  }

  lines.push('## preference allowlist (explicit)');
  lines.push('');
  lines.push('these client writes are intentionally retained after rules lockdown. each entry is matched by firestore-path pattern + (optional) surrounding-function pattern. anything outside this list must migrate to a server route.');
  lines.push('');
  lines.push('| pattern | scope | rationale |');
  lines.push('| --- | --- | --- |');
  for (const rule of PREFERENCE_ALLOWLIST) {
    const scope = rule.surroundingFunctionPattern
      ? `function ~ \`${rule.surroundingFunctionPattern}\``
      : 'any function';
    lines.push(`| \`${rule.firestorePathPattern}\` | ${scope} | ${rule.rationale} |`);
  }
  lines.push('');

  lines.push('### preference hits (file:line)');
  lines.push('');
  const prefHits = report.hits.filter((h) => h.classification === 'preference');
  if (prefHits.length === 0) {
    lines.push('_no preference hits._');
  } else {
    lines.push('| file | line | path | call | function |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const h of prefHits) {
      lines.push(
        `| \`${h.file}\` | ${h.line} | \`${h.firestorePath || '(unresolved)'}\` | \`${h.callType}\` | \`${h.surroundingFunction || '(toplevel)'}\` |`,
      );
    }
  }
  lines.push('');

  lines.push('## control-plane hits (must migrate)');
  lines.push('');
  lines.push('every entry is mapped to a target capability + canonical api route per plan wave 3. wave 4 hook migrations replace the client write with a `fetch()` to the route below.');
  lines.push('');
  const cpHits = report.hits.filter((h) => h.classification === 'control_plane');
  if (cpHits.length === 0) {
    lines.push('_no control-plane hits._');
  } else {
    lines.push('| file | line | path | call | function | capability | target route |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const h of cpHits) {
      lines.push(
        `| \`${h.file}\` | ${h.line} | \`${h.firestorePath || '(unresolved)'}\` | \`${h.callType}\` | \`${h.surroundingFunction || '(toplevel)'}\` | \`${h.capability}\` | \`${h.route}\` |`,
      );
    }
  }
  lines.push('');

  lines.push('## no-action hits (informational)');
  lines.push('');
  lines.push('these matches are reported by the ast scanner but do not require migration on their own — the actual write is captured elsewhere. retained in the report for completeness so an auditor can confirm nothing slipped through.');
  lines.push('');
  const naHits = report.hits.filter((h) => h.classification === 'no_action');
  if (naHits.length === 0) {
    lines.push('_no no-action hits._');
  } else {
    lines.push('| file | line | call | function | reason |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const h of naHits) {
      lines.push(
        `| \`${h.file}\` | ${h.line} | \`${h.callType}\` | \`${h.surroundingFunction || '(toplevel)'}\` | ${h.rationale || ''} |`,
      );
    }
  }
  lines.push('');

  if (report.totals.unclear > 0) {
    lines.push('## unclear hits — TRIAGE REQUIRED');
    lines.push('');
    lines.push('these hits did not match any preference rule or control-plane rule. the scanner exits 1 when this section is non-empty so ci blocks the pr until each is triaged into preference / control_plane / no_action.');
    lines.push('');
    lines.push('| file | line | path | call | function |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const h of report.hits.filter((x) => x.classification === 'unclear')) {
      lines.push(
        `| \`${h.file}\` | ${h.line} | \`${h.firestorePath || '(unresolved)'}\` | \`${h.callType}\` | \`${h.surroundingFunction || '(toplevel)'}\` |`,
      );
    }
    lines.push('');
  }

  lines.push('## ci integration');
  lines.push('');
  lines.push('to enforce no-new-direct-writes on every pr, add the following to ci:');
  lines.push('');
  lines.push('```yaml');
  lines.push('- name: scan firestore writes');
  lines.push('  run: npm run scan:firestore-writes --silent > /dev/null');
  lines.push('```');
  lines.push('');
  lines.push("the scanner exits non-zero when any 'unclear' hit remains, so ci fails on any unclassified write introduced by a pr. once the security-boundary migration is complete, the same exit-non-zero behaviour will be tightened to fail on any *control_plane* hit too (every control-plane write must be a server route).");
  lines.push('');
  return lines.join('\n');
}
