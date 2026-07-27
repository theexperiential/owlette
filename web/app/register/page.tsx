'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/lib/toast';
import { validatePassword, validateEmail } from '@/lib/validators';
import { sanitizeError } from '@/lib/errorHandler';
import { OwletteEyeIcon } from '@/components/landing/OwletteEye';
import { TurnstileWidget, TURNSTILE_ENABLED, type TurnstileHandle } from '@/components/TurnstileWidget';

export default function RegisterPage() {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [loading, setLoading] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  /**
   * Progressive disclosure for the email path. Collapsed by default so Google
   * is the visually dominant option; latches open on first email focus and
   * never closes, so a partly-filled form can't collapse mid-entry.
   */
  const [emailFormOpen, setEmailFormOpen] = useState(false);
  const turnstileRef = useRef<TurnstileHandle>(null);
  const { signUp, signInWithGoogle } = useAuth();
  const router = useRouter();

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();

    // Check terms agreement
    if (!agreedToTerms) {
      toast.error('you must agree to the terms of service and privacy policy');
      return;
    }

    // Validate email
    const emailValidation = validateEmail(email);
    if (!emailValidation.isValid) {
      toast.error(emailValidation.error);
      return;
    }

    // Validate password strength
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.isValid) {
      toast.error(passwordValidation.error);
      return;
    }

    // Check password confirmation
    if (password !== confirmPassword) {
      toast.error('passwords do not match');
      return;
    }

    setLoading(true);

    try {
      await signUp(email, password, firstName, lastName, turnstileToken);
      toast.success('account created successfully!');
      // Redirect to 2FA setup (mandatory for new users)
      router.push('/setup-2fa');
    } catch (error) {
      toast.error(sanitizeError(error));
      // Turnstile tokens are single-use. The page stays mounted after a failed
      // submit, so the consumed token has to be cleared before a retry.
      turnstileRef.current?.reset();
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignup = async () => {
    // No agreedToTerms gate here. The explicit checkbox lives inside the email
    // form, so it is not reachable on the Google path; consent for that path is
    // given by the notice rendered directly beneath the Google button
    // ("by continuing you agree to..."), which is the standard pattern for
    // federated sign-up. Both paths still surface the same two links.
    setLoading(true);

    try {
      await signInWithGoogle();
      toast.success('account created with Google!');
      // Note: AuthContext will redirect to /setup-2fa for new users
      router.push('/dashboard');
    } catch (error) {
      toast.error(sanitizeError(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center p-4 pb-32">
      {/* Grid background */}
      <div className="absolute inset-0 dot-grid opacity-30" />
      <div className="absolute inset-0 blueprint-grid opacity-15" />
      {/* Two columns from md up: brand on the left, the actual work on the
          right. Below md it stacks back to the original single column, so the
          form is never squeezed on a phone. */}
      {/* max-w-4xl, not 3xl: splitting a 3xl card in two left the form column
          narrower than the original single-column card, which made the terms
          line wrap mid-phrase. 4xl keeps each column wider than the old form. */}
      <Card className="relative z-10 w-full max-w-md overflow-hidden border-border bg-card p-0 md:max-w-4xl">
        <div className="grid md:grid-cols-2">
          {/* Brand panel = hero, not a second grey. Same fill as the form
              column — near-identical flat fills sharing an edge read as a
              mistake — so the difference is carried by KIND instead of degree:
              the brand dot-grid texture plus a radial vignette easing to
              --card-recessed at the corners. The column border remains the
              single boundary encoding. */}
          <CardHeader className="relative flex flex-col items-center justify-center space-y-4 p-8 text-center md:h-full md:border-r md:border-border">
            <div className="dot-grid absolute inset-0 -z-10 opacity-25" aria-hidden="true" />
            <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(120%_120%_at_50%_50%,transparent_35%,var(--card-recessed)_100%)]" aria-hidden="true" />
            <OwletteEyeIcon size={80} />
            <div className="space-y-1">
              <CardTitle className="text-2xl font-bold text-foreground">create an account</CardTitle>
              <CardDescription className="text-muted-foreground">
                join owlette to manage your fleet
              </CardDescription>
            </div>
          </CardHeader>
          {/* space-y-6 separates the major blocks (google group / divider /
              form / sign-in). Tighter spacing inside each group is set locally
              so related controls stay visually attached. */}
          <CardContent className="space-y-6 bg-card p-8">
          {/* Google first: it is the fastest path, it needs no password, and it
              skips the Turnstile challenge entirely (the server only gates
              password-provider signups). Showing the full email form up front
              buried it below six inputs. */}
          {/* Button + its consent notice are one group, so they stay tight to
              each other while space-y-6 pushes the next section away. */}
          <div className="space-y-2">
          <Button
            type="button"
            variant="outline"
            className="w-full cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleGoogleSignup}
            disabled={loading}
          >
            <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            continue with Google
          </Button>

          {/* Consent for the Google path. The explicit checkbox lives inside
              the email form, which a Google user never opens, so without this
              that path would carry no terms notice at all. */}
          {/* text-balance evens the two lines instead of letting the trailing
              link drop alone. Needed because the links are whitespace-nowrap
              (so "terms of service" can't split mid-phrase), which without
              balancing leaves "privacy policy" orphaned on its own line. */}
          <p className="text-balance text-center text-xs text-muted-foreground leading-snug">
            by continuing you agree to the{' '}
            <Link href="/terms" className="whitespace-nowrap hl-link text-accent-cyan" target="_blank">
              terms of service
            </Link>
            {' '}and{' '}
            <Link href="/privacy" className="whitespace-nowrap hl-link text-accent-cyan" target="_blank">
              privacy policy
            </Link>
          </p>
          </div>

          {/* -mx-8 cancels CardContent's p-8 so the rule runs edge to edge of
              the column instead of floating inset. Card is overflow-hidden, so
              the bleed can't create a horizontal scrollbar. */}
          <div className="relative -mx-8">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">
                or
              </span>
            </div>
          </div>

          <form onSubmit={handleRegister} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-foreground">email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                // Focus reveals the rest of the form. Focus (not click) so
                // keyboard tabbing expands it too, and it latches on so the
                // fields never collapse out from under a partly-filled form.
                onFocus={() => setEmailFormOpen(true)}
                required
                disabled={loading}
                className="bg-input border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            {emailFormOpen && (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="firstName" className="text-foreground">first name</Label>
                    <Input
                      id="firstName"
                      type="text"
                      placeholder="John"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      disabled={loading}
                      className="bg-input border-border text-foreground placeholder:text-muted-foreground"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lastName" className="text-foreground">last name</Label>
                    <Input
                      id="lastName"
                      type="text"
                      placeholder="Doe"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      disabled={loading}
                      className="bg-input border-border text-foreground placeholder:text-muted-foreground"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password" className="text-foreground">password</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    disabled={loading}
                    className="bg-input border-border text-foreground placeholder:text-muted-foreground"
                  />
                  <p className="text-xs text-muted-foreground">
                    must be 8+ characters with at least 2 of: lowercase, uppercase, numbers, special characters
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirmPassword" className="text-foreground">confirm password</Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    disabled={loading}
                    className="bg-input border-border text-foreground placeholder:text-muted-foreground"
                  />
                </div>
              </>
            )}

            {emailFormOpen && (
              <>
                <div className="flex items-start space-x-2">
                  <Checkbox
                    id="terms"
                    checked={agreedToTerms}
                    onCheckedChange={(checked) => setAgreedToTerms(checked === true)}
                    disabled={loading}
                    className="mt-0.5 border-border data-[state=checked]:bg-accent-cyan data-[state=checked]:border-accent-cyan"
                  />
                  {/* Label defaults to flex, which turns each inline child into
                      a flex item and lets "terms of service" break mid-phrase
                      in a narrow column. Force normal inline flow and keep each
                      link atomic. */}
                  <Label htmlFor="terms" className="block text-balance text-sm text-muted-foreground leading-snug cursor-pointer">
                    i agree to the{' '}
                    <Link href="/terms" className="whitespace-nowrap hl-link text-accent-cyan" target="_blank">
                      terms of service
                    </Link>
                    {' '}and{' '}
                    <Link href="/privacy" className="whitespace-nowrap hl-link text-accent-cyan" target="_blank">
                      privacy policy
                    </Link>
                  </Label>
                </div>

                {/* No justify-center wrapper: size:'flexible' spans its
                    container, so centering a fixed-width child would defeat it
                    and leave the widget floating narrower than the inputs. */}
                <TurnstileWidget
                  action="register"
                  onToken={setTurnstileToken}
                  ref={turnstileRef}
                />
                <Button type="submit" className="w-full text-background font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed" disabled={loading || !agreedToTerms || (TURNSTILE_ENABLED && !turnstileToken)}>
                  {loading ? 'creating account...' : 'create account'}
                </Button>
              </>
            )}
          </form>

          {/* Extra top spacing + a divider so this doesn't read as part of the
              form above it — it was easy to miss sitting flush under the
              submit button. */}
          {/* Full-bleed band: -mx-8/-mb-8 cancel CardContent's p-8 on three
              sides so this owns its own spacing, then symmetric py-6 centers
              the text within the band. Relying on the card's bottom padding
              instead left 24px above the text and 32px below it, which read
              as visually low. */}
          {/* Hairline only — the fill experiment is retired. One signal per
              boundary: the border plus symmetric py-6 does the separating. */}
          <div className="-mx-8 -mb-8 border-t border-border px-8 py-6 text-center text-sm text-muted-foreground">
            already have an account?{' '}
            <a href="/login" className="font-medium hl-link text-accent-cyan">
              sign in
            </a>
          </div>
          </CardContent>
        </div>
      </Card>
    </div>
  );
}
