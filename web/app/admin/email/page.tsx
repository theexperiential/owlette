'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { CheckCircle2, XCircle, Send, Loader2 } from 'lucide-react';

interface EmailConfig {
  provider: string;
  fromEmail: string;
  adminEmail: string | null;
  environment: string;
  apiKeyConfigured: boolean;
  adminEmailConfigured: boolean;
}

export default function EmailPage() {
  const [config, setConfig] = useState<EmailConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [lastResult, setLastResult] = useState<any>(null);

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      const response = await fetch('/api/admin/email/config');
      if (response.ok) {
        setConfig(await response.json());
      }
    } catch {
      // Config fetch failed — page still usable
    } finally {
      setConfigLoading(false);
    }
  };

  const sendTestEmail = async () => {
    setIsSending(true);
    setLastResult(null);

    try {
      const response = await fetch('/api/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await response.json();

      if (response.ok && data.success) {
        toast.success('Test email sent successfully!', {
          description: `Email sent to ${data.to}`,
        });
        setLastResult({ success: true, ...data });
      } else {
        toast.error('Failed to send test email', {
          description: data.error || 'Unknown error',
        });
        setLastResult({ success: false, error: data.error, details: data.details });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      toast.error('Failed to send test email', { description: errorMessage });
      setLastResult({ success: false, error: 'Request failed', details: errorMessage });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Email</h1>
        <p className="text-muted-foreground mt-1">
          Email notification configuration and testing
        </p>
      </div>

      {/* Configuration */}
      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
          <CardDescription>
            Current email provider settings and status
          </CardDescription>
        </CardHeader>
        <CardContent>
          {configLoading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-5 bg-muted rounded animate-pulse w-64" />
              ))}
            </div>
          ) : config ? (
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4 text-sm">
              <div>
                <dt className="text-muted-foreground font-medium">Provider</dt>
                <dd className="mt-1 flex items-center gap-2">
                  {config.provider}
                  <Badge
                    variant={config.apiKeyConfigured ? 'default' : 'destructive'}
                    className={config.apiKeyConfigured ? 'bg-emerald-600 hover:bg-emerald-600' : ''}
                  >
                    {config.apiKeyConfigured ? 'Connected' : 'Not configured'}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground font-medium">Environment</dt>
                <dd className="mt-1">{config.environment}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground font-medium">From Address</dt>
                <dd className="mt-1 font-mono text-xs">{config.fromEmail}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground font-medium">Admin Email</dt>
                <dd className="mt-1 flex items-center gap-2">
                  {config.adminEmailConfigured ? (
                    <span className="font-mono text-xs">{config.adminEmail}</span>
                  ) : (
                    <span className="text-destructive">Not configured</span>
                  )}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-destructive">Failed to load email configuration</p>
          )}
        </CardContent>
      </Card>

      {/* Test Email */}
      <Card>
        <CardHeader>
          <CardTitle>Test Email</CardTitle>
          <CardDescription>
            Send a test email to verify your configuration is working
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            onClick={sendTestEmail}
            disabled={isSending}
            className="bg-accent-cyan hover:bg-accent-cyan-hover text-gray-900 cursor-pointer"
          >
            {isSending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Send className="h-4 w-4" />
                Send Test Email
              </>
            )}
          </Button>

          {lastResult && (
            <div className={`p-4 rounded-lg border ${
              lastResult.success
                ? 'bg-emerald-950/50 border-emerald-800'
                : 'bg-red-950/50 border-red-800'
            }`}>
              <div className="flex items-center gap-2 mb-2">
                {lastResult.success ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                ) : (
                  <XCircle className="h-4 w-4 text-red-400" />
                )}
                <span className={`font-semibold text-sm ${
                  lastResult.success ? 'text-emerald-300' : 'text-red-300'
                }`}>
                  {lastResult.success ? 'Email sent successfully' : 'Failed to send email'}
                </span>
              </div>
              <div className="space-y-1 text-sm text-muted-foreground">
                {lastResult.success ? (
                  <>
                    <p>Sent to <span className="text-foreground font-medium">{lastResult.to}</span></p>
                    <p>Email ID: <span className="font-mono text-xs">{lastResult.emailId}</span></p>
                  </>
                ) : (
                  <>
                    <p>{lastResult.error}</p>
                    {lastResult.details && (
                      <pre className="mt-1 p-2 bg-red-950 rounded text-xs overflow-x-auto">
                        {typeof lastResult.details === 'string'
                          ? lastResult.details
                          : JSON.stringify(lastResult.details, null, 2)}
                      </pre>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
