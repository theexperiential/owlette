import { useState } from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import {
  ApiKeyScopeFields,
  buildScopeRows,
  type ScopeRow,
} from '@/components/ApiKeyScopeFields';
import { SCOPE_PRESETS } from '@/lib/apiKeyTypes';

/**
 * Executable form of the selector contract this panel has to respect.
 *
 * The scope grid is now permanently mounted inside the create form and the
 * scope editor, which means it shares a DOM subtree with markup that six e2e
 * specs locate by CSS. Those locators are loose, and one of them is actively
 * dangerous: rowFor() in api-keys-states.spec.ts filters `div.rounded-md.border`
 * by `p.font-medium` and ends in `.first()`. A stray `p.font-medium` inside this
 * panel therefore does NOT raise a Playwright strict-mode error — it silently
 * retargets the row and resurfaces three specs later as "badge not found",
 * sending whoever picks it up into KeyCard's status logic instead of here.
 *
 * These run in ~40ms on every `npm test`, which is the point: prose invariants
 * do not fail a build.
 */

function Harness({
  canGrantPlatformScopes = false,
  initial,
}: {
  canGrantPlatformScopes?: boolean;
  initial: ScopeRow[];
}) {
  const [rows, setRows] = useState<ScopeRow[]>(initial);
  return (
    <ApiKeyScopeFields
      rows={rows}
      onRowsChange={setRows}
      canGrantPlatformScopes={canGrantPlatformScopes}
    />
  );
}

type Config = { name: string; setup: () => HTMLElement };

const CONFIGS: Config[] = [
  {
    name: 'default (publisher preset)',
    setup: () => render(<Harness initial={buildScopeRows(SCOPE_PRESETS.publisher, false)} />).container,
  },
  {
    name: 'with a specific-id row added',
    setup: () => {
      const { container } = render(
        <Harness initial={buildScopeRows(SCOPE_PRESETS.publisher, false)} />,
      );
      fireEvent.click(screen.getByRole('button', { name: /limit to a specific id/ }));
      return container;
    },
  },
  {
    name: 'superadmin with the platform rows expanded',
    setup: () => {
      const { container } = render(
        <Harness canGrantPlatformScopes initial={buildScopeRows(SCOPE_PRESETS.publisher, true)} />,
      );
      fireEvent.click(screen.getByRole('button', { name: /show 2 more/ }));
      return container;
    },
  },
];

describe.each(CONFIGS)('selector invariants — $name', ({ setup }) => {
  it('renders no p.font-medium (would silently retarget rowFor() in api-keys-states.spec.ts)', () => {
    expect(setup().querySelectorAll('p.font-medium')).toHaveLength(0);
  });

  it('renders no <code> (the reveal card and rowByPrefix() both anchor on a lone one)', () => {
    expect(setup().querySelectorAll('code')).toHaveLength(0);
  });

  it('renders neither lucide-trash-2 nor lucide-refresh-cw (KeyCard binds both)', () => {
    expect(
      setup().querySelectorAll('svg.lucide-trash-2, svg.lucide-refresh-cw'),
    ).toHaveLength(0);
  });

  it('contains nothing matching /name/i — getByLabel("name") is an unanchored substring match', () => {
    const container = setup();
    // The create form's own name field lives outside this component; a match in
    // here would make dialog.getByLabel('name') ambiguous and fail two specs.
    expect(screen.queryAllByLabelText(/name/i)).toHaveLength(0);
    expect(container.textContent ?? '').not.toMatch(/name/i);
  });

  it('renders no button named "create key" or "save changes"', () => {
    setup();
    expect(screen.queryAllByRole('button', { name: /^create key$/i })).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: /^save changes$/i })).toHaveLength(0);
  });

  it('renders no heading (the page and the forms own those)', () => {
    setup();
    expect(screen.queryAllByRole('heading')).toHaveLength(0);
  });
});

describe('selector invariants — comboboxes', () => {
  it('has zero comboboxes by default, down from one', () => {
    render(<Harness initial={buildScopeRows(SCOPE_PRESETS.publisher, false)} />);
    // The suite's house style is a bare page.getByRole('combobox'); the preset
    // dropdown used to be the single match here.
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
  });

  it('exposes any resource picker by test id rather than by role alone', () => {
    const { container } = render(
      <Harness initial={buildScopeRows(SCOPE_PRESETS.publisher, false)} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /limit to a specific id/ }));
    expect(container.querySelectorAll('[data-testid^="scope-resource-"]')).toHaveLength(1);
  });
});
