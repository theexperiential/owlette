---
description: Build both web and agent, then fix all errors
---

Run build commands for both web dashboard and Python agent, then systematically fix any errors found.

## Task

1. Build web dashboard (TypeScript + Next.js)
2. Build Python agent (syntax check)
3. If errors found, fix them systematically
4. Re-run builds to verify
5. Repeat until zero errors

## Instructions

### Step 1: Build Web Dashboard

Run TypeScript compiler in check mode:

```bash
cd web
npx tsc --noEmit
```

**Capture**:
- Number of errors
- Error messages and locations
- Error codes (TS####)

### Step 2: Build Python Agent

Run Python syntax checker:

```bash
cd agent
python -m py_compile src/*.py
```

OR use a linter for better errors:

```bash
cd agent
python -m pylint src/*.py --errors-only
```

**Capture**:
- Number of errors
- Error messages and file locations
- Error types

### Step 3: Analyze Errors

If **no errors**:
```
✅ All builds successful!

- Web (TypeScript): 0 errors
- Agent (Python): 0 errors

No action needed.
```

If **errors found**, categorize them:

1. **TypeScript errors**: File paths, line numbers, error codes
2. **Python errors**: File paths, line numbers, error types
3. **Priority**: Fix critical errors first (syntax, type errors, missing imports)

### Step 4: Fix Errors Systematically

For each error:

1. **Read the file** containing the error
2. **Understand the context** around the error
3. **Fix the error** following project guidelines (skills will auto-activate)
4. **Verify fix** doesn't break anything else

Work through errors in this order:
1. Import errors (missing imports, wrong paths)
2. Syntax errors
3. Type errors (TypeScript)
4. Logic errors
5. Linting issues

### Step 5: Re-Run Builds

After fixing all errors, re-run builds:

```bash
# Web
cd web && npx tsc --noEmit

# Agent
cd agent && python -m py_compile src/*.py
```

If new errors appear or errors remain, repeat Step 4-5.

### Step 6: Report Results

Once zero errors achieved:

```markdown
✅ BUILD AND FIX COMPLETE

## Initial State
- Web: [X] errors
- Agent: [Y] errors
- Total: [X+Y] errors

## Errors Fixed

### Web Dashboard
1. [file.tsx:line] - [Error description] → Fixed by [solution]
2. [file.ts:line] - [Error description] → Fixed by [solution]

### Python Agent
1. [file.py:line] - [Error description] → Fixed by [solution]

## Final State
- Web: 0 errors ✅
- Agent: 0 errors ✅
- Total: 0 errors ✅

All builds passing!
```

## Error Fixing Patterns

### Common TypeScript Errors

**TS2307: Cannot find module**:
```typescript
// ❌ BAD
import { Thing } from './path/to/thing'

// ✅ GOOD
import { Thing } from '@/path/to/thing'  // Use alias
```

**TS2345: Type X is not assignable to type Y**:
- Check type definitions
- Add proper type annotations
- Fix mismatched types

**TS7031: Binding element implicitly has 'any' type**:
```typescript
// ❌ BAD
function process(data) { ... }

// ✅ GOOD
interface Data { ... }
function process(data: Data) { ... }
```

### Common Python Errors

**SyntaxError**:
- Missing colons
- Incorrect indentation
- Unclosed brackets/quotes

**ImportError / ModuleNotFoundError**:
```python
# ❌ BAD
from module import thing  # Module doesn't exist

# ✅ GOOD
from src.module import thing  # Correct path
```

**NameError**:
- Undefined variables
- Typos in variable names
- Missing imports

## Tips for Efficient Fixing

1. **Group related errors** - Fix all import errors together
2. **Fix root causes** - One fix might resolve multiple errors
3. **Test incrementally** - Don't fix everything before testing
4. **Follow skills** - Reference frontend/backend/firebase guidelines
5. **Don't break working code** - Be careful with changes

## If Too Many Errors (> 20)

If there are more than 20 errors, suggest using the build-error-resolver agent instead:

```
⚠️  Found [X] errors - this is a lot to fix manually.

Recommendation: Launch the build-error-resolver agent to handle these systematically.

Would you like me to:
1. Launch the agent to fix all errors
2. Fix the most critical 5-10 errors manually first
3. Proceed with manual fixing anyway
```

## Edge Cases

**Build command not found**:
- Ensure you're in correct directory
- Check if npm/python is installed
- Verify package.json/requirements.txt exists

**Timeout**:
- Builds take too long (> 2 minutes)
- Consider using --skipLibCheck for TypeScript
- Focus on specific files instead of full build

**False positives**:
- Some "errors" might be warnings
- Check if build actually succeeds despite messages
- Verify with `npm run build` (full build) vs `tsc --noEmit` (type check only)

## Success Criteria

✅ TypeScript type check passes with 0 errors
✅ Python syntax check passes with 0 errors
✅ No breaking changes introduced
✅ Skills guidelines followed for all fixes
✅ Code is properly typed and documented

---

**Note**: This command focuses on TypeScript and Python syntax/type errors. For runtime errors, use testing and debugging workflows.
