import { Activity, Lock, WifiOff, type LucideIcon } from 'lucide-react';

interface Proof {
  icon: LucideIcon;
  headline: string;
  body: string;
}

const proofs: Proof[] = [
  {
    icon: Activity,
    headline: '~10s auto-recovery',
    body: 'crashed processes detected and restarted in under ten seconds.',
  },
  {
    icon: WifiOff,
    headline: 'runs offline, syncs on reconnect',
    body: 'agents monitor and recover locally without the cloud. resync resumes automatically when the connection returns.',
  },
  {
    icon: Lock,
    headline: 'no inbound ports — outbound 443 only',
    body: 'no vpn. no firewall holes. just https to firebase.',
  },
];

export function ProofStrip() {
  return (
    <section className="py-12 sm:py-16 px-4 sm:px-6 border-y border-border/40">
      <div className="max-w-5xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {proofs.map(({ icon: Icon, headline, body }) => (
            <div key={headline} className="text-center">
              <Icon className="w-6 h-6 mx-auto mb-3 text-accent-cyan" />
              <h3 className="text-lg font-semibold font-heading text-foreground mb-2">
                {headline}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
