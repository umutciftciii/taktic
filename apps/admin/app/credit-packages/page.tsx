import Link from 'next/link';
import { apiFetch, OfferCreditPackage, requireAdmin } from '../../lib/api';
import {
  createCreditPackageAction,
  updateCreditPackageAction,
  updateCreditPackageStatusAction,
} from './actions';

export default async function CreditPackagesPage() {
  await requireAdmin();
  const packages = await apiFetch<OfferCreditPackage[]>('/credit-packages?includeInactive=true');

  return (
    <main>
      <p>
        <Link href="/">Admin home</Link>
      </p>
      <h1>Credit Packages</h1>
      {packages.map((creditPackage) => (
        <section key={creditPackage.id}>
          <h2>
            {creditPackage.name} ({creditPackage.isActive ? 'active' : 'inactive'})
          </h2>
          <form action={updateCreditPackageAction}>
            <input type="hidden" name="id" value={creditPackage.id} />
            <PackageFields creditPackage={creditPackage} />
            <button type="submit">Save package</button>
          </form>
          <form action={updateCreditPackageStatusAction}>
            <input type="hidden" name="id" value={creditPackage.id} />
            <input type="hidden" name="isActive" value={String(!creditPackage.isActive)} />
            <button type="submit">{creditPackage.isActive ? 'Deactivate' : 'Activate'}</button>
          </form>
        </section>
      ))}

      <section>
        <h2>Create Package</h2>
        <form action={createCreditPackageAction}>
          <PackageFields />
          <button type="submit">Create package</button>
        </form>
      </section>
    </main>
  );
}

function PackageFields({ creditPackage }: { creditPackage?: OfferCreditPackage }) {
  return (
    <>
      <p>
        <label>
          Name
          <input name="name" required defaultValue={creditPackage?.name ?? ''} />
        </label>
      </p>
      <p>
        <label>
          Slug
          <input name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" defaultValue={creditPackage?.slug ?? ''} />
        </label>
      </p>
      <p>
        <label>
          Credits
          <input name="creditAmount" type="number" min="1" required defaultValue={creditPackage?.creditAmount ?? 1} />
        </label>
      </p>
      <p>
        <label>
          Price amount
          <input name="priceAmount" type="number" min="1" required defaultValue={creditPackage?.priceAmount ?? 1} />
        </label>
      </p>
      <p>
        <label>
          Currency
          <input name="currency" defaultValue={creditPackage?.currency ?? 'TRY'} />
        </label>
      </p>
      <p>
        <label>
          Description
          <textarea name="description" defaultValue={creditPackage?.description ?? ''} />
        </label>
      </p>
      <p>
        <label>
          Sort order
          <input name="sortOrder" type="number" min="0" defaultValue={creditPackage?.sortOrder ?? 0} />
        </label>
      </p>
      <input type="hidden" name="isActive" value={String(creditPackage?.isActive ?? true)} />
    </>
  );
}
