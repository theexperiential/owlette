'use client';

/**
 * AllowlistEditor — admin-facing mock for the roost destination allowlist
 * (wave 1.7). Presentation-only scaffolding; no firestore persistence yet.
 *
 * Authoritative enforcement lives on the agent
 * (agent/src/destination_allowlist.py). Empty/missing list is fail-closed:
 * the agent rejects every extraction. This UI must surface that state loudly
 * so an operator can't silently lock the machine out of receiving deploys.
 */

import { useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FolderLock, Plus, ShieldAlert, Trash2 } from 'lucide-react';

interface AllowlistEditorProps {
  /** resolved allowed roots, as they exist in firestore / agent config. */
  roots: string[];
  /**
   * called with the next roots array after an add/remove. mock — callers
   * are expected to persist to firestore themselves (wiring lands with the
   * real editor in a later wave).
   */
  onChange?: (roots: string[]) => void;
  /** non-admin viewers get a read-only presentation. */
  readOnly?: boolean;
}

export function AllowlistEditor({
  roots,
  onChange,
  readOnly = false,
}: AllowlistEditorProps) {
  const [localRoots, setLocalRoots] = useState<string[]>(roots);
  const [draft, setDraft] = useState('');

  const isFailClosed = localRoots.length === 0;
  const duplicate = useMemo(
    () => localRoots.includes(draft.trim()),
    [localRoots, draft],
  );

  const commit = (next: string[]) => {
    setLocalRoots(next);
    onChange?.(next);
  };

  const handleAdd = () => {
    const trimmed = draft.trim();
    if (!trimmed || duplicate) return;
    commit([...localRoots, trimmed]);
    setDraft('');
  };

  const handleRemove = (path: string) => {
    commit(localRoots.filter((p) => p !== path));
  };

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="flex items-start gap-3">
          <FolderLock className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
          <div className="space-y-1">
            <h3 className="text-sm font-medium">destination allowlist</h3>
            <p className="text-xs text-muted-foreground">
              roots where roost is allowed to extract files on this machine.
              the agent refuses to write anywhere outside this list.
            </p>
          </div>
        </div>

        {isFailClosed && (
          <Alert variant="destructive">
            <ShieldAlert className="h-4 w-4" />
            <AlertDescription>
              fail-closed — no roots configured. the agent will reject every
              extraction until at least one root is added.
            </AlertDescription>
          </Alert>
        )}

        {localRoots.length > 0 && (
          <ul className="space-y-2">
            {localRoots.map((path) => (
              <li
                key={path}
                className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2"
              >
                <code className="flex-1 text-xs font-mono truncate">{path}</code>
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemove(path)}
                    aria-label={`remove ${path}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {!readOnly && (
          <div className="flex gap-2">
            <Input
              placeholder="e.g. ~/Documents/Owlette or D:\Media"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAdd();
                }
              }}
              className="font-mono text-xs"
              aria-label="new allowed root"
            />
            <Button
              onClick={handleAdd}
              disabled={!draft.trim() || duplicate}
              size="sm"
            >
              <Plus className="h-4 w-4 mr-1" />
              add
            </Button>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          paths are expanded and realpath-resolved on the agent. symlinks,
          junctions, windows reserved names (NUL, CON, ...) and alternate data
          streams are rejected automatically.
        </p>
      </CardContent>
    </Card>
  );
}

export default AllowlistEditor;
