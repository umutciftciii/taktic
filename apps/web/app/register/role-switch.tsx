import Link from 'next/link';

/**
 * The role picker from the design.
 *
 * Customer and provider sign-up are two routes with two server actions, so the
 * segment navigates rather than toggling a field — the choice really changes
 * which account gets created.
 */
export function RoleSwitch({ active }: { active: 'customer' | 'provider' }) {
  return (
    <div className="field">
      <span className="field-label">Ne yapmak istiyorsun?</span>
      <div className="seg" role="group" aria-label="Hesap türü">
        <Link
          className={`seg-opt${active === 'customer' ? ' is-active' : ''}`}
          href="/register/customer"
          aria-current={active === 'customer' ? 'page' : undefined}
        >
          Hizmet almak
        </Link>
        <Link
          className={`seg-opt${active === 'provider' ? ' is-active' : ''}`}
          href="/register/provider"
          aria-current={active === 'provider' ? 'page' : undefined}
        >
          Hizmet vermek
        </Link>
      </div>
    </div>
  );
}
