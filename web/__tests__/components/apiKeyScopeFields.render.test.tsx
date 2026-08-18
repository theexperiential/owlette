import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  ApiKeyScopeFields,
  buildScopeRows,
  type ScopeRow,
  serializeScopeRows,
} from '@/components/ApiKeyScopeFields';
import { SCOPE_PRESETS, type ApiKeyScope } from '@/lib/apiKeyTypes';

/**
 * Rendered behaviour of the scope grid.
 *
 * The bug these guard against was reported as "I don't see any way to actually
 * edit the scopes" — so the first assertion any of this has to make is that the
 * controls are on screen at first paint, with no mode selected and nothing
 * expanded.
 *
 * Radix Select is hostile in jsdom (no pointer events, no scrollIntoView), but
 * nothing here needs one: the preset affordance is a plain button now, and the
 * resource picker only exists on user-added rows.
 */

function Harness({
  initial,
  canGrantPlatformScopes = false,
  onRows,
}: {
  initial: ScopeRow[];
  canGrantPlatformScopes?: boolean;
  onRows?: (rows: ScopeRow[]) => void;
}) {
  const [rows, setRows] = useState<ScopeRow[]>(initial);
  return (
    <ApiKeyScopeFields
      rows={rows}
      onRowsChange={(next) => {
        setRows(next);
        onRows?.(next);
      }}
      canGrantPlatformScopes={canGrantPlatformScopes}
    />
  );
}

describe('ApiKeyScopeFields — the reported bug', () => {
  it('renders the permission checkboxes at first paint, with no mode to choose', () => {
    render(<Harness initial={buildScopeRows(SCOPE_PRESETS.publisher, false)} />);

    // Six base resources x five permissions.
    expect(screen.getAllByRole('checkbox')).toHaveLength(30);
    // The ones the preset grants are ticked, visibly.
    expect(screen.getByLabelText('all sites — write')).toBeChecked();
    expect(screen.getByLabelText('all sites — admin')).not.toBeChecked();
    // And there is no dropdown left to hide them behind.
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
  });

  it('shows every resource by name, including the ones no preset covers', () => {
    render(<Harness initial={buildScopeRows(SCOPE_PRESETS.publisher, false)} />);
    for (const label of [
      'all roosts',
      'all sites',
      'all machines',
      'all hoot chats',
      'all classic deploys',
      'all processes',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('states in plain language that the table wins over the preset', () => {
    render(<Harness initial={buildScopeRows(SCOPE_PRESETS.publisher, false)} />);
    expect(
      screen.getByText("presets are shortcuts — what's ticked here is what gets saved."),
    ).toBeInTheDocument();
  });
});

describe('ApiKeyScopeFields — presets write into the table', () => {
  it('clicking a preset chip rewrites the grid rather than replacing it (scope-loss regression)', () => {
    let latest: ScopeRow[] = [];
    render(
      <Harness
        initial={buildScopeRows(SCOPE_PRESETS.publisher, false)}
        onRows={(r) => {
          latest = r;
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'operator' }));

    expect(serializeScopeRows(latest)).toEqual(SCOPE_PRESETS.operator);
    expect(screen.getByLabelText('all machines — rollback')).toBeChecked();
  });

  it('marks the matching chip pressed, and unmarks it the moment a box is toggled', () => {
    render(<Harness initial={buildScopeRows(SCOPE_PRESETS.publisher, false)} />);
    expect(screen.getByRole('button', { name: 'publisher' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(screen.getByLabelText('all sites — deploy'));

    expect(screen.getByRole('button', { name: 'publisher' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByText('custom scope set — no preset matches')).toBeInTheDocument();
  });

  it('ticking a box updates the counter', () => {
    render(<Harness initial={buildScopeRows(SCOPE_PRESETS.publisher, false)} />);
    expect(screen.getByText('4 scopes · 8 grants')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('all processes — read'));

    expect(screen.getByText('5 scopes · 9 grants')).toBeInTheDocument();
  });

  it('offers undo only when a preset click actually discarded a specific row', () => {
    render(<Harness initial={buildScopeRows(SCOPE_PRESETS.publisher, false)} />);

    // The chip shows the label, not the preset key — 'readonly' is an identifier.
    fireEvent.click(screen.getByRole('button', { name: 'read only' }));
    expect(screen.queryByRole('button', { name: 'undo' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /limit to a specific id/ }));
    fireEvent.click(screen.getByRole('button', { name: 'operator' }));

    expect(screen.getByRole('button', { name: 'undo' })).toBeInTheDocument();
  });
});

describe('ApiKeyScopeFields — platform scopes', () => {
  it('hides the platform rows from a non-superadmin entirely', () => {
    render(<Harness initial={buildScopeRows(SCOPE_PRESETS.publisher, false)} />);
    expect(screen.queryByText('all installer binaries')).not.toBeInTheDocument();
    expect(screen.queryByText(/show 2 more/)).not.toBeInTheDocument();
  });

  it('names installer in the disclosure button, so it is legible before the click', () => {
    render(<Harness initial={buildScopeRows(SCOPE_PRESETS.publisher, true)} canGrantPlatformScopes />);
    const disclosure = screen.getByRole('button', {
      name: 'show 2 more: all users, all installer binaries',
    });
    expect(disclosure).toBeInTheDocument();

    fireEvent.click(disclosure);

    // Two clicks total to reach installer:*:write — expand, then tick.
    expect(screen.getByLabelText('all installer binaries — write')).toBeInTheDocument();
  });

  it('starts expanded when the key already holds a platform grant', () => {
    const scopes: ApiKeyScope[] = [{ resource: 'installer', id: '*', permissions: ['write'] }];
    render(<Harness initial={buildScopeRows(scopes, true)} canGrantPlatformScopes />);
    expect(screen.getByLabelText('all installer binaries — write')).toBeChecked();
    expect(screen.queryByText(/show 2 more/)).not.toBeInTheDocument();
  });

  it('renders a demoted superadmin a read-only row and says saving will drop it', () => {
    const scopes: ApiKeyScope[] = [{ resource: 'installer', id: '*', permissions: ['write'] }];
    render(<Harness initial={buildScopeRows(scopes, false)} />);

    // Static glyphs, never a disabled checkbox — checkbox.tsx applies
    // disabled:cursor-not-allowed, which would read as a broken control.
    expect(screen.queryByLabelText('all installer binaries — write')).not.toBeInTheDocument();
    expect(
      screen.getByText('this key holds scopes only a superadmin can grant. saving removes them.'),
    ).toBeInTheDocument();
  });
});

describe('ApiKeyScopeFields — specific ids', () => {
  it('adds a removable row that stays out of the wire array until an id is typed', () => {
    let latest: ScopeRow[] = [];
    render(
      <Harness
        initial={buildScopeRows(SCOPE_PRESETS.publisher, false)}
        onRows={(r) => {
          latest = r;
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /limit to a specific id/ }));

    expect(serializeScopeRows(latest)).toEqual(SCOPE_PRESETS.publisher);
    expect(screen.getByText('4 scopes · 8 grants')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('scope id'), { target: { value: 'ohio-lobby' } });

    expect(serializeScopeRows(latest)).toContainEqual({
      resource: 'site',
      id: 'ohio-lobby',
      permissions: ['read'],
    });
  });

  it('removes a specific row on demand', () => {
    render(<Harness initial={buildScopeRows(SCOPE_PRESETS.publisher, false)} />);
    fireEvent.click(screen.getByRole('button', { name: /limit to a specific id/ }));
    expect(screen.getByLabelText('scope id')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'remove scope row' }));

    expect(screen.queryByLabelText('scope id')).not.toBeInTheDocument();
  });
});
