import { accountsSignInUrl } from "@/lib/accounts";
import { safeNextPath } from "@/lib/nextPath";

const CHIPS = ["Envelopes", "Signing links", "Audit trail"];

// Public front door. No session, no data, no prose — a wordmark, what the app
// does, and the way in. Sign-in is accounts.redbtn.io; redSign never mints a
// session of its own.
export default function Landing({ next }: { next?: string | null }) {
  const signInUrl = accountsSignInUrl(safeNextPath(next) ?? "/");

  return (
    <main className="flex min-h-[100dvh] flex-col items-center justify-center overflow-y-auto bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <h1 className="text-3xl font-extrabold tracking-tight text-text-primary">
          red<span className="text-accent">Sign</span>
        </h1>
        <p className="mt-2 text-base text-text-secondary">E-signatures and signing pages.</p>

        <ul className="mt-5 flex flex-wrap gap-2">
          {CHIPS.map((chip) => (
            <li
              key={chip}
              className="rounded-full border border-border bg-bg-elevated px-3 py-1 text-xs text-text-secondary"
            >
              {chip}
            </li>
          ))}
        </ul>

        <a
          href={signInUrl}
          data-testid="sign-in-with-redbtn"
          className="mt-7 block w-full rounded-lg bg-accent px-4 py-3 text-center text-sm font-semibold text-white no-underline"
        >
          Sign in with redbtn
        </a>

        <div className="mt-4 flex items-center justify-center gap-4 text-sm">
          <a className="text-text-secondary no-underline hover:text-text-primary" href="https://redbtn.io/apps">
            All apps
          </a>
          <a className="text-text-secondary no-underline hover:text-text-primary" href="https://redbtn.io">
            redbtn.io
          </a>
        </div>

        <p className="mt-8 text-center text-xs text-text-tertiary">
          Protected by redbtn single sign-on.
        </p>
      </div>
    </main>
  );
}
